// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch orchestration. Coordinates patch discovery, application, and validation.
 * Pure parsing, content transformation, and lock management are in separate modules.
 */

import { lstat, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { PatchError } from '../errors/patch.js';
import type {
  ImportSummary,
  PatchInfo,
  PatchMetadata,
  PatchResult,
} from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeFileAtomic, writeText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { applyPatchIdempotent, reversePatch } from './git.js';
import { getFileContentAtRef } from './git-file-ops.js';
import { discoverPatches } from './patch-files.js';
import { loadPatchesManifest } from './patch-manifest.js';
import {
  extractAffectedFiles,
  extractConflictingFiles,
  isNewFileInPatch,
  parseDiffSections,
} from './patch-parse.js';
import { applyPatchTextToContent, extractNewFileContentFromDiff } from './patch-transform.js';

// Re-export from split modules so existing import sites continue working
export { PatchError } from '../errors/patch.js';
export { countPatches, discoverPatches } from './patch-files.js';
export { withPatchDirectoryLock } from './patch-lock.js';
export { extractAffectedFiles } from './patch-parse.js';

/**
 * Applies a single patch.
 *
 * @param patch - Patch info
 * @param engineDir - Path to the engine directory
 * @param protectedFiles - Files touched by patches already applied in the
 *   current run. The idempotent-recovery reset must not wipe them (see
 *   applyPatchIdempotent). Overlapping queues (`--allow-overlap`) share files
 *   between patches, and resetting a shared file to HEAD during a later
 *   patch's recovery silently discards the earlier patch's changes.
 * @returns Patch result
 */
async function applySinglePatch(
  patch: PatchInfo,
  engineDir: string,
  protectedFiles?: ReadonlySet<string>
): Promise<PatchResult> {
  let patchContent = '';
  let affectedFiles: string[] = [];

  try {
    patchContent = await readText(patch.path);
    affectedFiles = extractAffectedFiles(patchContent);
    await validatePatchTargets(patch, affectedFiles, engineDir);

    await applyPatchIdempotent(patch.path, engineDir, {
      ...(protectedFiles ? { protectedFiles } : {}),
    });
    return { patch, success: true };
  } catch (error: unknown) {
    if (error instanceof PatchError) {
      return { patch, success: false, error: error.message };
    }

    const applyError = toError(error);

    // Check if this is a resolvable "new file" conflict
    let resolvedNewFiles = false;

    // Save original BYTES of files we might overwrite, so we can restore on
    // failure. Raw buffers rather than decoded text: the same snapshot has to
    // restore a binary target byte-for-byte, and a Buffer round-trips text
    // losslessly where a utf-8 decode of a binary file does not.
    const savedContents = new Map<string, Buffer>();
    // New-file sections keyed by target, so the binary discrimination below
    // reads the already-parsed section instead of re-scanning the body per
    // file.
    const newFileSections = new Map(
      parseDiffSections(patchContent)
        .filter((section) => section.isNewFile)
        .map((section) => [section.targetPath, section] as const)
    );
    try {
      for (const file of affectedFiles) {
        if (!isNewFileInPatch(patchContent, file)) continue;
        const targetPath = join(engineDir, file);
        if (!(await pathExists(targetPath))) continue;
        savedContents.set(file, await readFile(targetPath));
        const section = newFileSections.get(file);
        if (section?.isBinary === true) {
          // A binary new file cannot be resolved by writing extracted
          // text, because the payload is base85, whose alphabet includes
          // '+'. It does not need to be: `git apply` decodes a `GIT binary
          // patch` itself. So the resolution is to remove the blocking file
          // and let the retry below create it from the payload, which is
          // exactly what the text branch achieves by overwriting.
          if (!section.hasBinaryDelta) {
            // `Binary files … differ` records that the bytes changed and
            // carries none of them, so nothing can recreate the file. Fail
            // honestly rather than deleting a file we cannot put back.
            throw new PatchError(
              `Cannot resolve the new-file conflict for ${file}: the patch's binary section ` +
                'carries no replayable payload (`Binary files … differ` rather than `GIT binary ' +
                'patch`), so the file cannot be recreated. Re-export the patch with a binary-aware ' +
                'diff.',
              file
            );
          }
          await rm(targetPath, { force: true });
        } else {
          await writeText(targetPath, extractNewFileContentFromDiff(patchContent, file));
        }
        resolvedNewFiles = true;
      }
    } catch (extractError: unknown) {
      // Resolution threw for a later target after earlier targets were
      // already overwritten or removed. Restore them before reporting
      // failure, instead of letting the exception skip the restore loop
      // entirely and crash the whole import.
      for (const [file, originalContent] of savedContents) {
        await writeFileAtomic(join(engineDir, file), originalContent);
      }
      return { patch, success: false, error: toError(extractError).message };
    }

    if (resolvedNewFiles) {
      try {
        await applyPatchIdempotent(patch.path, engineDir, {
          ...(protectedFiles ? { protectedFiles } : {}),
        });
        // Keep the originals: rollbackPatches needs them if a later patch
        // fails, since reverse-applying this new-file patch deletes the
        // target and would otherwise permanently discard the pre-existing
        // content (recoverable from git only if it was tracked at HEAD).
        return { patch, success: true, autoResolved: true, autoResolvedOriginals: savedContents };
      } catch (retryError: unknown) {
        verbose(
          `Auto-resolved new-file retry failed for ${patch.filename}: ${toError(retryError).message}`
        );
        // Restore original file bytes before falling through to --reject
        for (const [file, originalContent] of savedContents) {
          await writeFileAtomic(join(engineDir, file), originalContent);
        }
      }
    }

    // If it's not a simple new-file conflict, try with --reject to help manual resolution
    let errorMessage = applyError.message;

    try {
      // Use --reject to apply what we can and create .rej files for what we can't
      await applyPatchIdempotent(patch.path, engineDir, {
        reject: true,
        ...(protectedFiles ? { protectedFiles } : {}),
      });
      // If this somehow succeeds with --reject but failed without, it still shouldn't
      // happen because applyPatch first runs --check which would fail.
      // But if it did succeed, we should still return failure because manual fix is needed
      // for the rejected hunks.
    } catch (rejectError: unknown) {
      // This is expected to fail, but now we have .rej files
      errorMessage = toError(rejectError).message;
    }

    return { patch, success: false, error: errorMessage };
  }
}

/**
 * Reverses previously applied patches in reverse order.
 * Best-effort: logs warnings for individual failures but does not throw.
 */
async function rollbackPatches(results: PatchResult[], engineDir: string): Promise<void> {
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];
    if (!result?.success) continue;
    try {
      await reversePatch(result.patch.path, engineDir);
      verbose(`Rolled back ${result.patch.filename}`);
    } catch (rollbackError: unknown) {
      verbose(`Failed to roll back ${result.patch.filename}: ${toError(rollbackError).message}`);
    }
    // Reversing an auto-resolved new-file patch deletes the target, so
    // put back the pre-existing content the auto-resolve overwrote.
    if (result.autoResolvedOriginals) {
      for (const [file, originalContent] of result.autoResolvedOriginals) {
        try {
          await writeFileAtomic(join(engineDir, file), originalContent);
          verbose(`Restored pre-existing content of ${file} after rollback`);
        } catch (restoreError: unknown) {
          verbose(`Could not restore ${file}: ${toError(restoreError).message}`);
        }
      }
    }
  }
}

async function validatePatchTargets(
  patch: PatchInfo,
  affectedFiles: string[],
  engineDir?: string
): Promise<void> {
  // realpath the engine root once so containment is checked against the
  // physical tree (the root itself may sit behind a symlink, e.g. /tmp on
  // macOS). An unresolvable engine dir skips the symlink checks. A missing
  // engine surfaces through `git apply --check` with a better message.
  const engineRoot = engineDir ? await realpath(engineDir).catch(() => null) : null;

  for (const file of affectedFiles) {
    if (!isContainedRelativePath(file)) {
      throw new PatchError(`Patch targets a path outside engine/: ${file}`, patch.filename);
    }

    // Verify that a write to the target would physically land inside the
    // engine tree. A crafted patch could otherwise write through a symlink
    // (the target itself, a dangling link, or a symlinked parent directory)
    // to an arbitrary location.
    if (engineDir && engineRoot) {
      const destination = await resolvePatchWriteDestination(join(engineDir, file));
      if (destination !== engineRoot && !destination.startsWith(engineRoot + sep)) {
        throw new PatchError(
          `Patch targets a path that resolves outside engine/ (symlink escape): ${file}`,
          patch.filename
        );
      }
    }
  }
}

/**
 * Resolves where a write to `targetPath` would physically land, following
 * symlinks on every path component that already exists.
 *
 * - Existing target: `realpath` resolves it fully.
 * - Dangling symlink: `realpath` rejects it, but a write through the link
 *   would still be created at the link target, so the target is resolved
 *   against the link's (real) parent directory. The link target is taken
 *   textually. A loop or nested dangling link fails at apply time anyway.
 * - Not-yet-existing file: resolved against the nearest existing ancestor's
 *   real path. Components below that ancestor do not exist, so they cannot
 *   be symlinks and are appended verbatim.
 */
async function resolvePatchWriteDestination(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    // Fall through: the path (or its symlink target) does not exist.
  }

  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink()) {
      const linkTarget = await readlink(targetPath);
      return resolve(await resolvePatchWriteDestination(dirname(targetPath)), linkTarget);
    }
  } catch {
    // The path component itself does not exist.
  }

  const parent = dirname(targetPath);
  if (parent === targetPath) {
    return targetPath;
  }
  return join(await resolvePatchWriteDestination(parent), basename(targetPath));
}

/**
 * Options for {@link applyPatchesWithContinue}.
 */
export interface ApplyPatchesOptions {
  /** Continue applying patches even after one fails. */
  continueOnFailure?: boolean;
  /**
   * Stop applying patches after this filename has been processed
   * (successfully or not). Any patches after it in apply order are left
   * untouched. Accepts either the bare filename (with or without .patch)
   * or the numeric ordinal as a string. Unknown identifiers throw.
   */
  untilFilename?: string | undefined;
}

/**
 * Decides whether a patch filename matches an `--until` identifier.
 *
 * The identifier is one of three shapes and the three shapes must stay
 * disjoint so the operator can reason about which patch they picked:
 *
 *   1. Exact filename, `005-foo.patch`. Matches only that filename.
 *   2. Filename without extension, `005-foo`. Matches `005-foo.patch`.
 *   3. Bare numeric ordinal, `5` or `005`. Matches the patch whose
 *      order prefix parses to the same integer (so `5` and `005` both match
 *      `005-foo.patch`, and `05` matches too because parseInt normalizes
 *      leading zeros).
 *
 * A purely-numeric identifier is treated only as an ordinal: it does not
 * also match a filename that happens to literally equal the digits. That
 * would require a patch literally named `5` or `005`, which would collide
 * with the filename prefix anyway.
 */
export function matchesUntilFilename(patchFilename: string, needle: string): boolean {
  const isNumeric = /^\d+$/.test(needle);
  if (isNumeric) {
    const order = parseInt(needle, 10);
    const prefixMatch = /^(\d+)-/.exec(patchFilename);
    return prefixMatch !== null && parseInt(prefixMatch[1] ?? '0', 10) === order;
  }
  if (patchFilename === needle) return true;
  if (patchFilename === `${needle}.patch`) return true;
  return false;
}

/**
 * Enhanced patch application with continue mode.
 * When continueOnFailure is false, rolls back all previously applied patches
 * on the first failure to keep the engine directory in a clean state.
 * @param patchesDir - Path to the patches directory
 * @param engineDir - Path to the engine directory
 * @param options - Application options
 * @returns Import summary with all results
 */
export async function applyPatchesWithContinue(
  patchesDir: string,
  engineDir: string,
  options: ApplyPatchesOptions = {}
): Promise<ImportSummary> {
  const continueOnFailure = options.continueOnFailure ?? false;
  const untilFilename = options.untilFilename;

  const patches = await discoverPatches(patchesDir);

  // Resolve the --until stop index up front so callers get an immediate
  // error on an unknown identifier instead of a silent no-op. Detect
  // ambiguity (two patches matching the same needle). That should never
  // happen in a well-formed manifest, but it surfaces queue corruption
  // loudly instead of silently picking the first match.
  let stopIndex = patches.length - 1;
  if (untilFilename !== undefined) {
    const matchingIndexes: number[] = [];
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];
      if (patch && matchesUntilFilename(patch.filename, untilFilename)) {
        matchingIndexes.push(i);
      }
    }
    if (matchingIndexes.length === 0) {
      throw new PatchError(
        `--until identifier "${untilFilename}" does not match any patch. ` +
          `Available: ${patches.map((p) => p.filename).join(', ')}`
      );
    }
    if (matchingIndexes.length > 1) {
      const matches = matchingIndexes
        .map((idx) => patches[idx]?.filename ?? '<unknown>')
        .join(', ');
      throw new PatchError(
        `--until identifier "${untilFilename}" is ambiguous: matches ${matchingIndexes.length} ` +
          `patches (${matches}). Use the full filename to disambiguate.`
      );
    }
    stopIndex = matchingIndexes[0] ?? patches.length - 1;
  }

  const succeeded: PatchResult[] = [];
  const failed: PatchResult[] = [];
  const skipped: PatchInfo[] = [];
  const appliedFiles = new Set<string>();

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!patch) continue;

    if (i > stopIndex) {
      // Patches beyond the --until cutoff are skipped on purpose. They
      // are not failures. Record them in `skipped` so the summary still
      // reflects what the full queue contained.
      skipped.push(patch);
      continue;
    }

    const result = await applySinglePatch(patch, engineDir, appliedFiles);

    if (result.success) {
      succeeded.push(result);
      for (const file of extractAffectedFiles(await readText(patch.path))) {
        appliedFiles.add(file);
      }
    } else {
      // Try to extract conflicting files from error message
      result.conflictingFiles = extractConflictingFiles(result.error);
      failed.push(result);

      if (!continueOnFailure) {
        // Roll back successfully applied patches to keep engine clean
        if (succeeded.length > 0) {
          verbose(`Rolling back ${succeeded.length} previously applied patch(es)…`);
          await rollbackPatches(succeeded, engineDir);
        }

        // Mark remaining patches as skipped (including anything that was
        // already past the --until cutoff, which stays skipped).
        for (let j = i + 1; j < patches.length; j++) {
          const remainingPatch = patches[j];
          if (remainingPatch) {
            skipped.push(remainingPatch);
          }
        }
        break;
      }
    }
  }

  return {
    total: patches.length,
    succeeded,
    failed,
    skipped,
  };
}

/**
 * Batched patched-content computation shared by status classification,
 * import's unmanaged-dirty guard, and discard baseline planning.
 */
export interface PatchedContentContext {
  /** Manifest rows, so callers don't re-load the manifest per file. */
  manifestPatches: readonly PatchMetadata[];
  /** Cumulative patched content for a file (null if absent at HEAD with no creator). */
  computePatched: (filePath: string) => Promise<string | null>;
  /** Patches affecting a file, sorted by order (from the shared inverted index). */
  getAffectingPatches: (filePath: string) => readonly PatchInfo[];
  /** Patch body text, memoized per patch path across the whole batch. */
  readPatchBody: (patch: PatchInfo) => Promise<string>;
}

/**
 * Builds a batched patched-content context that loads the manifest and
 * discovers patch files once for many lookups, and memoizes each patch body
 * read across the batch. A per-call helper re-runs `loadPatchesManifest` +
 * `discoverPatches` and re-reads every affecting patch body for every file,
 * which is O(dirtyFiles × patches) redundant IO when classifying a broad
 * engine edit session during `status` or `import`.
 */
export async function createPatchedContentContext(
  patchesDir: string,
  engineDir: string
): Promise<PatchedContentContext> {
  const manifest = await loadPatchesManifest(patchesDir);
  const patches = await discoverPatches(patchesDir);
  const patchByFilename = new Map(patches.map((p) => [p.filename, p]));

  const affectingByFile = new Map<string, PatchInfo[]>();
  for (const metadata of manifest?.patches ?? []) {
    const patch = patchByFilename.get(metadata.filename);
    if (!patch) continue;
    for (const file of metadata.filesAffected) {
      const list = affectingByFile.get(file) ?? [];
      list.push(patch);
      affectingByFile.set(file, list);
    }
  }
  for (const list of affectingByFile.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  // Promise-memoized so concurrent classification workers never read the
  // same body twice (memoizing the promise, not the value, closes the
  // window between two workers missing the cache at once).
  const bodyPromises = new Map<string, Promise<string>>();
  const readPatchBody = (patch: PatchInfo): Promise<string> => {
    let body = bodyPromises.get(patch.path);
    if (!body) {
      body = readText(patch.path);
      bodyPromises.set(patch.path, body);
    }
    return body;
  };

  const getAffectingPatches = (filePath: string): readonly PatchInfo[] =>
    affectingByFile.get(filePath) ?? [];

  return {
    manifestPatches: manifest?.patches ?? [],
    getAffectingPatches,
    readPatchBody,
    computePatched: async (filePath: string): Promise<string | null> => {
      let content = await getFileContentAtRef(engineDir, filePath);
      for (const patch of getAffectingPatches(filePath)) {
        content = applyPatchTextToContent(content, await readPatchBody(patch), filePath);
      }
      return content;
    },
  };
}
