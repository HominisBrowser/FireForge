// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest consistency checks and rebuild/recovery operations.
 */

import { stat } from 'node:fs/promises';

import { GeneralError } from '../errors/base.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { discoverPatches, getAllTargetFilesFromPatch } from './patch-files.js';
import type { PatchDirectoryLockOptions } from './patch-lock.js';
import { withPatchDirectoryLock } from './patch-lock.js';
import {
  type LoadedManifestState,
  loadPatchesManifestState,
  PATCHES_MANIFEST,
  savePatchesManifest,
} from './patch-manifest-io.js';
import { inferPatchMetadataFromFilename } from './patch-manifest-validate.js';

/** Consistency issue codes for manifest validation. */
export interface PatchManifestConsistencyIssue {
  code:
    | 'manifest-invalid'
    | 'manifest-missing'
    | 'missing-patch-file'
    | 'untracked-patch-file'
    | 'files-affected-mismatch'
    | 'duplicate-manifest-entry';
  filename: string;
  message: string;
}

/**
 * Validates that patches.json and the patch directory describe the same patch set.
 * @param patchesDir - Path to the patches directory
 * @returns Consistency issues between manifest metadata and on-disk patch files
 */
export async function validatePatchesManifestConsistency(
  patchesDir: string
): Promise<PatchManifestConsistencyIssue[]> {
  const manifestState = await loadPatchesManifestState(patchesDir);
  const patches = await discoverPatches(patchesDir);
  const issues: PatchManifestConsistencyIssue[] = [];

  if (manifestState.parseError) {
    issues.push({
      code: 'manifest-invalid',
      filename: PATCHES_MANIFEST,
      message: `patches.json exists but could not be parsed: ${manifestState.parseError.message}`,
    });
    return issues;
  }

  if (!manifestState.exists) {
    if (patches.length > 0) {
      issues.push({
        code: 'manifest-missing',
        filename: PATCHES_MANIFEST,
        message: `patches.json is missing while ${patches.length} patch file(s) exist.`,
      });
    }
    return issues;
  }

  const manifest = manifestState.manifest;
  if (!manifest) {
    return issues;
  }

  const patchByFilename = new Map(patches.map((patch) => [patch.filename, patch]));
  const seenManifestEntries = new Set<string>();

  for (const metadata of manifest.patches) {
    if (seenManifestEntries.has(metadata.filename)) {
      issues.push({
        code: 'duplicate-manifest-entry',
        filename: metadata.filename,
        message: `patches.json contains duplicate metadata entries for ${metadata.filename}.`,
      });
      continue;
    }
    seenManifestEntries.add(metadata.filename);

    const patch = patchByFilename.get(metadata.filename);
    if (!patch) {
      issues.push({
        code: 'missing-patch-file',
        filename: metadata.filename,
        message: `${metadata.filename} is listed in patches.json but the patch file is missing.`,
      });
      continue;
    }

    const declaredFiles = normalizeAffectedFiles(metadata.filesAffected);
    const actualFiles = normalizeAffectedFiles(await getAllTargetFilesFromPatch(patch.path));
    if (!sameStringArray(declaredFiles, actualFiles)) {
      issues.push({
        code: 'files-affected-mismatch',
        filename: metadata.filename,
        message:
          `${metadata.filename} declares [${declaredFiles.join(', ')}] in patches.json ` +
          `but the patch file targets [${actualFiles.join(', ')}].`,
      });
    }

    patchByFilename.delete(metadata.filename);
  }

  for (const orphanPatch of patchByFilename.values()) {
    issues.push({
      code: 'untracked-patch-file',
      filename: orphanPatch.filename,
      message: `${orphanPatch.filename} exists on disk but is not tracked in patches.json.`,
    });
  }

  return issues;
}

/**
 * Recovery hint for an unrepaired consistency failure.
 *
 * Drift that is only in `filesAffected` is a derived value disagreeing with
 * the diff it describes, and the narrow repair fixes exactly that. Naming the
 * whole-manifest rebuild for it (as this hint used to, unconditionally) puts
 * an operator one keystroke from rewriting every row in the manifest to
 * correct one list.
 */
export function recommendManifestRepair(issues: readonly PatchManifestConsistencyIssue[]): string {
  const filesAffectedOnly =
    issues.length > 0 && issues.every((issue) => issue.code === 'files-affected-mismatch');
  return filesAffectedOnly
    ? 'Run "fireforge doctor --repair-files-affected" to recompute filesAffected from the patch ' +
        'bodies (add --dry-run to preview). It rewrites only the drifted lists and leaves every ' +
        'other manifest field untouched.'
    : 'Run "fireforge doctor --repair-patches-manifest" to rebuild patches.json from the patch ' +
        'files (add --dry-run to preview). Only filesAffected and order are recomputed; every ' +
        'other field on an existing entry is preserved.';
}

/**
 * Summary of a {@link rebuildPatchesManifest} run. `recoveredFilenames`
 * lists patches whose manifest entry was reconstructed from filename,
 * mtime, and diff alone (no pre-existing manifest entry to preserve).
 * These entries carry generic descriptions and mtime-based
 * timestamps. Callers like `doctor --repair-patches-manifest` surface
 * a per-patch review warning so operators know which metadata was
 * invented vs which was restored.
 */
export interface RebuildPatchesManifestResult {
  /**
   * Rebuilt manifest, ready to be re-applied by callers. Persisted unless
   * the run was a dry run. See {@link RebuildPatchesManifestResult.written}.
   */
  manifest: PatchesManifest;
  /**
   * Filenames whose manifest entry had no pre-existing metadata to
   * preserve. Every descriptive field on these entries is inferred.
   */
  recoveredFilenames: string[];
  /**
   * Filenames that had a manifest entry but no patch file on disk, so the
   * row was dropped. Discarding these silently is how a manifest quietly
   * loses rows an operator still expected to be there.
   */
  droppedFilenames: string[];
  /** False when the run was a dry run and patches.json was left untouched. */
  written: boolean;
}

/** Options for {@link rebuildPatchesManifest}. */
export interface RebuildPatchesManifestOptions extends PatchDirectoryLockOptions {
  /**
   * Proceed even when patches.json exists but cannot be parsed, in which case
   * there is no existing metadata to preserve and every descriptive field on
   * every entry is invented. Refused without this flag. See
   * {@link rebuildPatchesManifest}.
   */
  allowMetadataLoss?: boolean;
  /** Compute the rebuilt manifest without writing it. */
  dryRun?: boolean;
}

/**
 * Rebuilds patches.json from the patch files currently present on disk.
 *
 * This is a merge, not a from-scratch rebuild: only `filesAffected` and
 * `order` are recomputed from the patch files, and every other field on an
 * existing entry is carried forward untouched. Entries with no pre-existing
 * metadata are recovered from filename structure, patch contents, and file
 * mtimes.
 *
 * Refuses when patches.json exists but cannot be parsed, because that is the
 * one case where nothing can be carried forward and the "merge" silently
 * becomes a whole-manifest reinvention. Pass `allowMetadataLoss` to accept it.
 *
 * @param patchesDir - Path to the patches directory
 * @param fallbackSourceEsrVersion - source version to use for recovered legacy entries
 * @param options - Lock options plus `allowMetadataLoss` / `dryRun`
 * @returns {@link RebuildPatchesManifestResult}: the rebuilt manifest, the
 *   filenames that were reconstructed from generic defaults, and the rows
 *   dropped because their patch file is gone.
 */
export async function rebuildPatchesManifest(
  patchesDir: string,
  fallbackSourceEsrVersion: string,
  options: RebuildPatchesManifestOptions = {}
): Promise<RebuildPatchesManifestResult> {
  // The whole read → discover → rebuild → save cycle runs under the shared
  // patch-directory lock (invariant 2, docs/lifecycle-invariants.md):
  // manifest writes serialize on this lock, so without it a repair racing a
  // concurrent export/reorder can clobber the other writer's manifest. Not
  // reentrant: callers must not already hold it.
  //
  // A dry run takes the lock too: it reads the same manifest and patch bodies
  // a real run would, and a projection computed against a queue being
  // rewritten underneath is worth less than no projection at all.
  return withPatchDirectoryLock(
    patchesDir,
    () => rebuildPatchesManifestUnderLock(patchesDir, fallbackSourceEsrVersion, options),
    options
  );
}

async function rebuildPatchesManifestUnderLock(
  patchesDir: string,
  fallbackSourceEsrVersion: string,
  options: RebuildPatchesManifestOptions
): Promise<RebuildPatchesManifestResult> {
  const manifestState: LoadedManifestState = await loadPatchesManifestState(patchesDir);
  const existingEntries = new Map<string, PatchMetadata>();

  // An unparseable manifest yields `manifest: null`, which the merge below
  // cannot distinguish from "no manifest at all". Every entry would be
  // treated as new and every descriptive field reinvented. `filesAffected`
  // is the only field a .patch body can yield. `stagedDependencies`,
  // `lintIgnore`, `tier`, `description`, `category`, `createdAt` and the
  // source version cannot be reconstructed from a diff at all. Refuse rather
  // than write that, since the write is what makes it unrecoverable on a
  // queue that is not under version control.
  if (manifestState.exists && manifestState.parseError && options.allowMetadataLoss !== true) {
    throw new GeneralError(
      `Refusing to rebuild ${PATCHES_MANIFEST}: it exists but could not be parsed ` +
        `(${manifestState.parseError.message}). None of its metadata can be carried ` +
        'forward, so every entry would be rebuilt with an invented description, an ' +
        'mtime-based createdAt and an inferred category, and any stagedDependencies, ' +
        'lintIgnore or tier declarations would be lost — a patch body carries none of ' +
        'them.\n' +
        `Fix the JSON in ${PATCHES_MANIFEST} (restore it from version control if you ` +
        'can) and re-run, or pass --allow-metadata-loss to accept the reinvention.'
    );
  }

  if (manifestState.manifest) {
    for (const entry of manifestState.manifest.patches) {
      existingEntries.set(entry.filename, entry);
    }
  }

  const patches = await discoverPatches(patchesDir);
  const rebuiltPatches: PatchMetadata[] = [];
  const recoveredFilenames: string[] = [];
  const highestFiniteOrder = patches.reduce((highest, patch) => {
    return Number.isFinite(patch.order) ? Math.max(highest, patch.order) : highest;
  }, 0);
  let nextRecoveredOrder = highestFiniteOrder + 1;

  // Prefetch the two independent per-patch reads concurrently. This runs
  // while the patch-directory lock is held, and as two serialised awaits per
  // patch it costs 58 round-trips on a 29-patch queue. The fold below stays
  // sequential because `nextRecoveredOrder` is loop-carried: parallelising
  // the assignment would scramble the recovered ordinals.
  const prefetched = await Promise.all(
    patches.map(async (patch) => ({
      filesAffected: normalizeAffectedFiles(await getAllTargetFilesFromPatch(patch.path)),
      patchStats: await stat(patch.path),
    }))
  );

  for (const [index, patch] of patches.entries()) {
    const existing = existingEntries.get(patch.filename);
    const prefetch = prefetched[index];
    if (!prefetch) continue;
    const { filesAffected, patchStats } = prefetch;
    const inferred = inferPatchMetadataFromFilename(patch.filename);
    const recoveredOrder = Number.isFinite(patch.order) ? patch.order : nextRecoveredOrder++;

    if (!existing) {
      // Track every filename that had no pre-existing manifest entry so
      // callers can warn the operator per-patch. A missing entry means every
      // descriptive field (`description`, `createdAt`, `category`) was
      // invented rather than preserved, and FireForge patch files carry no
      // header metadata that could carry a human description forward, so
      // visibility is the best available, and silent overwrites of
      // human-written descriptions during a recovery run are the failure to
      // avoid.
      recoveredFilenames.push(patch.filename);
    }

    // The rebuild owns exactly two fields: `filesAffected` (recomputed from
    // the patch body) and `order` (from the filename ordinal). Everything
    // else on an existing entry is carried forward by the spread, so a field
    // a .patch cannot express (`stagedDependencies`, `lintIgnore`, `tier`,
    // and whatever is added to PatchMetadata next) survives a repair without
    // anyone remembering to list it here. It was an enumerated literal until
    // `stagedDependencies` was dropped from every entry that had one, which
    // is the failure this shape prevents from recurring.
    const rebuilt: PatchMetadata = {
      ...(existing ?? {}),
      filename: patch.filename,
      order: recoveredOrder,
      category: existing?.category ?? inferred.category,
      name: existing?.name ?? inferred.name,
      description:
        existing?.description ??
        `Recovered manifest entry for ${patch.filename}. Review description and source version.`,
      createdAt: existing?.createdAt ?? new Date(patchStats.mtimeMs).toISOString(),
      sourceEsrVersion: existing?.sourceEsrVersion ?? fallbackSourceEsrVersion,
      sourceVersion:
        existing?.sourceVersion ?? existing?.sourceEsrVersion ?? fallbackSourceEsrVersion,
      filesAffected,
    };
    // Copy the arrays rather than aliasing the loaded manifest's, so a caller
    // mutating the rebuilt entry cannot reach back into `manifestState`.
    if (existing?.lintIgnore !== undefined) rebuilt.lintIgnore = [...existing.lintIgnore];
    rebuiltPatches.push(rebuilt);
    existingEntries.delete(patch.filename);
  }

  rebuiltPatches.sort(
    (left, right) => left.order - right.order || left.filename.localeCompare(right.filename)
  );

  const rebuiltManifest: PatchesManifest = {
    version: 1,
    patches: rebuiltPatches,
  };

  // Whatever is left in the map had a manifest row but no patch file, so the
  // rebuild drops it. That is the correct outcome, since the file is the
  // source of truth, but dropping rows without naming them is
  // indistinguishable from never having had them.
  const droppedFilenames = [...existingEntries.keys()].sort((left, right) =>
    left.localeCompare(right)
  );

  if (options.dryRun === true) {
    return {
      manifest: rebuiltManifest,
      recoveredFilenames,
      droppedFilenames,
      written: false,
    };
  }

  await savePatchesManifest(patchesDir, rebuiltManifest);
  return { manifest: rebuiltManifest, recoveredFilenames, droppedFilenames, written: true };
}

/**
 * Canonical form of a `filesAffected` list: deduplicated and sorted, so a
 * comparison between a declared list and one extracted from a patch body is
 * about membership rather than ordering.
 */
export function normalizeAffectedFiles(files: string[]): string[] {
  return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right));
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
