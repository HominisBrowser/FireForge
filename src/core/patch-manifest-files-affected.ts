// SPDX-License-Identifier: EUPL-1.2
/**
 * Narrow repair for `filesAffected`, the one manifest field a `.patch` body
 * can actually yield.
 *
 * A `files-affected-mismatch` is pure derived-value drift: the manifest's list
 * disagrees with the diff it describes, and the diff is right by definition.
 * Rebuilding the whole manifest to fix it is a much larger operation than the
 * failure calls for, so this repair recomputes one field on the drifted rows
 * and leaves every other row byte-identical.
 */

import { GeneralError } from '../errors/base.js';
import { discoverPatches, getAllTargetFilesFromPatch } from './patch-files.js';
import type { PatchDirectoryLockOptions } from './patch-lock.js';
import { withPatchDirectoryLock } from './patch-lock.js';
import { normalizeAffectedFiles } from './patch-manifest-consistency.js';
import {
  loadPatchesManifestForWrite,
  mutatePatchRowsInManifest,
  PATCHES_MANIFEST,
} from './patch-manifest-io.js';

/** One row whose `filesAffected` list disagreed with its patch body. */
export interface FilesAffectedRepair {
  /** Patch filename. */
  filename: string;
  /** The list the manifest declared, normalized for comparison. */
  before: string[];
  /** The list the patch body actually targets. */
  after: string[];
}

/** Summary of a {@link repairPatchesFilesAffected} run. */
export interface RepairFilesAffectedResult {
  /** Rows that drifted and were (or would be) corrected. */
  repairs: FilesAffectedRepair[];
  /** Requested filenames with no manifest row, or no patch file on disk. */
  skippedFilenames: string[];
  /** False when the run was a dry run and patches.json was left untouched. */
  written: boolean;
}

/** Options for {@link repairPatchesFilesAffected}. */
export interface RepairFilesAffectedOptions extends PatchDirectoryLockOptions {
  /** Compute the corrections without writing them. */
  dryRun?: boolean;
}

/**
 * Recomputes `filesAffected` from the patch body for the named patches.
 *
 * @param patchesDir - Path to the patches directory
 * @param filenames - Patch filenames to repair
 * @param options - Lock options plus `dryRun`
 * @returns The corrections applied (or projected) and the filenames skipped
 */
export async function repairPatchesFilesAffected(
  patchesDir: string,
  filenames: readonly string[],
  options: RepairFilesAffectedOptions = {}
): Promise<RepairFilesAffectedResult> {
  // Same lock contract as the full rebuild (invariant 2,
  // docs/lifecycle-invariants.md): a manifest write serializes on the
  // patch-directory lock, and a dry run reads under it so its projection
  // cannot be computed against a queue being rewritten underneath.
  return withPatchDirectoryLock(
    patchesDir,
    () => repairPatchesFilesAffectedUnderLock(patchesDir, filenames, options),
    options
  );
}

async function repairPatchesFilesAffectedUnderLock(
  patchesDir: string,
  filenames: readonly string[],
  options: RepairFilesAffectedOptions
): Promise<RepairFilesAffectedResult> {
  // ForWrite: a corrupt manifest must abort here rather than be treated as
  // empty. This repair exists precisely so that a one-field drift never
  // reaches a whole-manifest rewrite, and silently writing over unparseable
  // metadata would be a larger version of what it avoids.
  const manifest = await loadPatchesManifestForWrite(patchesDir);
  if (!manifest) {
    throw new GeneralError(
      `Cannot repair filesAffected: ${PATCHES_MANIFEST} does not exist in ${patchesDir}.`
    );
  }

  const patchPathByFilename = new Map(
    (await discoverPatches(patchesDir)).map((patch) => [patch.filename, patch.path])
  );
  const rowByFilename = new Map(manifest.patches.map((entry) => [entry.filename, entry]));

  const repairs: FilesAffectedRepair[] = [];
  const skippedFilenames: string[] = [];

  for (const filename of new Set(filenames)) {
    const patchPath = patchPathByFilename.get(filename);
    const row = rowByFilename.get(filename);
    if (patchPath === undefined || !row) {
      // A missing patch file or a missing row is a different consistency
      // issue with a different remedy. This repair reports it rather than
      // inventing a row or deleting one.
      skippedFilenames.push(filename);
      continue;
    }

    const before = normalizeAffectedFiles(row.filesAffected);
    const after = normalizeAffectedFiles(await getAllTargetFilesFromPatch(patchPath));
    if (sameFiles(before, after)) continue;
    repairs.push({ filename, before, after });
  }

  skippedFilenames.sort((left, right) => left.localeCompare(right));

  if (repairs.length === 0 || options.dryRun === true) {
    return { repairs, skippedFilenames, written: false };
  }

  const correctedByFilename = new Map(repairs.map((repair) => [repair.filename, repair.after]));
  // Row-scoped mutation, so every untouched entry keeps its exact JSON shape:
  // no re-sorted `filesAffected` lists and no reader-only fallback fields
  // serialized into rows this repair has no business touching.
  await mutatePatchRowsInManifest(patchesDir, [...correctedByFilename.keys()], (existing) => {
    const corrected = correctedByFilename.get(existing.filename);
    return corrected ? { set: { filesAffected: corrected } } : null;
  });

  return { repairs, skippedFilenames, written: true };
}

function sameFiles(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
