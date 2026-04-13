// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch orchestration — coordinates patch discovery, application, and validation.
 * Pure parsing, content transformation, and lock management are in separate modules.
 */

import { join } from 'node:path';

import { PatchError } from '../errors/patch.js';
import type { ImportSummary, PatchInfo, PatchResult } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { exec } from '../utils/process.js';
import { applyPatchIdempotent, reversePatch } from './git.js';
import { getFileContentFromHead } from './git-file-ops.js';
import { discoverPatches } from './patch-files.js';
import { findPatchesAffectingFile } from './patch-manifest.js';
import { extractAffectedFiles, extractConflictingFiles, isNewFileInPatch } from './patch-parse.js';
import { applyPatchToContent, extractNewFileContent } from './patch-transform.js';

// Re-export from split modules so existing import sites continue working
export { PatchError } from '../errors/patch.js';
export {
  countPatches,
  discoverPatches,
  getAllTargetFilesFromPatch,
  getTargetFileFromPatch,
  isNewFilePatch,
} from './patch-files.js';
export { withPatchDirectoryLock } from './patch-lock.js';
export {
  extractAffectedFiles,
  extractOrder,
  isNewFileInPatch,
  parseHunksForFile,
} from './patch-parse.js';
export {
  applyPatchToContent,
  extractNewFileContent,
  extractNewFileContentFromDiff,
} from './patch-transform.js';

/**
 * Applies a single patch.
 * @param patch - Patch info
 * @param engineDir - Path to the engine directory
 * @returns Patch result
 */
async function applySinglePatch(patch: PatchInfo, engineDir: string): Promise<PatchResult> {
  let patchContent = '';
  let affectedFiles: string[] = [];

  try {
    patchContent = await readText(patch.path);
    affectedFiles = extractAffectedFiles(patchContent);
    validatePatchTargets(patch, affectedFiles);

    await applyPatchIdempotent(patch.path, engineDir);
    return { patch, success: true };
  } catch (error: unknown) {
    if (error instanceof PatchError) {
      return { patch, success: false, error: error.message };
    }

    const applyError = toError(error);

    // Check if this is a resolvable "new file" conflict
    let resolvedNewFiles = false;

    // Save original content for files we might overwrite, so we can restore on failure
    const savedContents = new Map<string, string>();
    for (const file of affectedFiles) {
      if (isNewFileInPatch(patchContent, file)) {
        const targetPath = join(engineDir, file);
        if (await pathExists(targetPath)) {
          savedContents.set(file, await readText(targetPath));
          const content = await extractNewFileContent(patch.path, file);
          await writeText(targetPath, content);
          resolvedNewFiles = true;
        }
      }
    }

    if (resolvedNewFiles) {
      try {
        await applyPatchIdempotent(patch.path, engineDir);
        return { patch, success: true, autoResolved: true };
      } catch (retryError: unknown) {
        verbose(
          `Auto-resolved new-file retry failed for ${patch.filename}: ${toError(retryError).message}`
        );
        // Restore original file content before falling through to --reject
        for (const [file, originalContent] of savedContents) {
          await writeText(join(engineDir, file), originalContent);
        }
      }
    }

    // If it's not a simple new-file conflict, try with --reject to help manual resolution
    let errorMessage = applyError.message;

    try {
      // Use --reject to apply what we can and create .rej files for what we can't
      await applyPatchIdempotent(patch.path, engineDir, { reject: true });
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
  }
}

/**
 * Applies all patches in order. Rolls back all successfully applied
 * patches when one fails so the engine directory stays clean.
 * @param patchesDir - Path to the patches directory
 * @param engineDir - Path to the engine directory
 * @returns Results for each patch
 */
export async function applyPatches(patchesDir: string, engineDir: string): Promise<PatchResult[]> {
  const patches = await discoverPatches(patchesDir);
  const results: PatchResult[] = [];

  for (const patch of patches) {
    const result = await applySinglePatch(patch, engineDir);
    results.push(result);

    // Stop on first failure and roll back all previously applied patches
    if (!result.success) {
      const succeeded = results.filter((r) => r.success);
      if (succeeded.length > 0) {
        verbose(`Rolling back ${succeeded.length} previously applied patch(es)…`);
        await rollbackPatches(succeeded, engineDir);
      }
      break;
    }
  }

  return results;
}

/**
 * Validates that all patches can be applied.
 * @param patchesDir - Path to the patches directory
 * @param engineDir - Path to the engine directory
 * @returns Validation results
 */
export async function validatePatches(
  patchesDir: string,
  engineDir: string
): Promise<{ valid: boolean; errors: string[] }> {
  const patches = await discoverPatches(patchesDir);
  const errors: string[] = [];

  for (const patch of patches) {
    try {
      const patchContent = await readText(patch.path);
      validatePatchTargets(patch, extractAffectedFiles(patchContent));
    } catch (error: unknown) {
      errors.push(`${patch.filename}: ${toError(error).message}`);
      continue;
    }

    const result = await exec('git', ['apply', '--check', '--', patch.path], { cwd: engineDir });
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || 'git apply --check failed';
      errors.push(`${patch.filename}: ${message}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validatePatchTargets(patch: PatchInfo, affectedFiles: string[]): void {
  for (const file of affectedFiles) {
    if (!isContainedRelativePath(file)) {
      throw new PatchError(`Patch targets a path outside engine/: ${file}`, patch.filename);
    }
  }
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
 *   1. **Exact filename** — `005-foo.patch`. Matches only that filename.
 *   2. **Filename without extension** — `005-foo`. Matches `005-foo.patch`.
 *   3. **Bare numeric ordinal** — `5` or `005`. Matches the patch whose
 *      order prefix parses to the same integer (so `5` and `005` both
 *      match `005-foo.patch`, and `05` matches too because parseInt
 *      normalizes leading zeros).
 *
 * A purely-numeric identifier is treated **only** as an ordinal: it does
 * not also match a filename that happens to literally equal the digits.
 * That would require a patch literally named `5` or `005` — which would
 * collide with the filename prefix anyway — and we prefer the explicit
 * ordinal interpretation. The earlier form's `patchFilename === needle`
 * short-circuit was kept behind the numeric gate so the match stays
 * single-meaning per identifier.
 */
function matchesUntilFilename(patchFilename: string, needle: string): boolean {
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
 * @param optionsOrContinue - Options object, or the legacy continueOnFailure boolean
 * @returns Import summary with all results
 */
export async function applyPatchesWithContinue(
  patchesDir: string,
  engineDir: string,
  optionsOrContinue: ApplyPatchesOptions | boolean = false
): Promise<ImportSummary> {
  // Accept both the legacy boolean positional and the new options object so
  // existing call sites (tests and rebase) keep working without a rewrite.
  const options: ApplyPatchesOptions =
    typeof optionsOrContinue === 'boolean'
      ? { continueOnFailure: optionsOrContinue }
      : optionsOrContinue;
  const continueOnFailure = options.continueOnFailure ?? false;
  const untilFilename = options.untilFilename;

  const patches = await discoverPatches(patchesDir);

  // Resolve the --until stop index up front so callers get an immediate
  // error on an unknown identifier instead of a silent no-op. Detect
  // ambiguity (two patches matching the same needle — should never happen
  // in a well-formed manifest but surfaces queue corruption loudly
  // instead of silently picking the first match).
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

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!patch) continue;

    if (i > stopIndex) {
      // Patches beyond the --until cutoff are intentionally skipped. They
      // are not failures — record them in `skipped` so the summary still
      // reflects what the full queue contained.
      skipped.push(patch);
      continue;
    }

    const result = await applySinglePatch(patch, engineDir);

    if (result.success) {
      succeeded.push(result);
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
 * Computes the cumulative patched content for a file.
 * @param patchesDir - Path to the patches directory
 * @param engineDir - Path to the engine directory
 * @param filePath - File path to compute content for
 * @returns Content after all patches applied, or null if file doesn't exist
 */
export async function computePatchedContent(
  patchesDir: string,
  engineDir: string,
  filePath: string
): Promise<string | null> {
  let content = await getFileContentFromHead(engineDir, filePath);

  // Find all patches affecting this file
  const affectingPatches = await findPatchesAffectingFile(patchesDir, filePath);

  if (affectingPatches.length === 0) {
    return content;
  }

  // Apply each patch in order
  for (const { patch } of affectingPatches) {
    content = await applyPatchToContent(content, patch.path, filePath);
  }

  return content;
}
