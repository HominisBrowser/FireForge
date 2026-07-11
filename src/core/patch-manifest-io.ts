// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest I/O: load, save, and mutating operations for patches.json.
 *
 * Mutations (add / remove / renumber) are intended to be the only sanctioned
 * way to change on-disk manifest state. They run under the shared patch
 * directory lock so concurrent commands cannot race each other into
 * inconsistent manifests.
 */

import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { FireForgeError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import { PatchManifestCorruptError } from '../errors/patch.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExistsStrict, readJson, removeFile, writeJson } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { isArray, isObject } from '../utils/validation.js';
import { validatePatchesManifest } from './patch-manifest-validate.js';

/** Filename for the patches manifest */
export const PATCHES_MANIFEST = 'patches.json';

/** Internal state returned by loadPatchesManifestState. */
export interface LoadedManifestState {
  exists: boolean;
  manifest: PatchesManifest | null;
  parseError: Error | undefined;
}

/** Field-level mutation returned by a row-scoped manifest mutator. */
export interface PatchManifestRowMutation {
  /** Metadata fields to set on the selected manifest row. */
  set?: Partial<PatchMetadata>;
  /** Metadata fields to delete from the selected manifest row. */
  unset?: ReadonlyArray<string>;
}

/** Result for one manifest row changed by {@link mutatePatchRowsInManifest}. */
export interface PatchManifestRowMutationResult {
  /** Validated row before the mutation. */
  before: PatchMetadata;
  /** Validated row after the mutation. */
  after: PatchMetadata;
}

/**
 * Loads and validates the patches manifest, returning full state information.
 * @param patchesDir - Path to the patches directory
 */
export async function loadPatchesManifestState(patchesDir: string): Promise<LoadedManifestState> {
  const manifestPath = join(patchesDir, PATCHES_MANIFEST);
  if (!(await pathExistsStrict(manifestPath))) {
    return { exists: false, manifest: null, parseError: undefined };
  }

  try {
    const manifest = validatePatchesManifest(await readJson<unknown>(manifestPath));
    return {
      exists: true,
      manifest,
      parseError: undefined,
    };
  } catch (error: unknown) {
    return {
      exists: true,
      manifest: null,
      parseError: toError(error),
    };
  }
}

/**
 * Loads the patches manifest if it exists.
 *
 * READ-ONLY callers only: this collapses "absent" and "corrupt" into null.
 * Any code path that will WRITE the manifest (or delete patch files based
 * on its content) must use {@link loadPatchesManifestForWrite} instead —
 * treating a corrupt manifest as empty and then saving destroys every
 * existing patch's metadata.
 *
 * @param patchesDir - Path to the patches directory
 * @returns PatchesManifest or null if not found
 */
export async function loadPatchesManifest(patchesDir: string): Promise<PatchesManifest | null> {
  const state = await loadPatchesManifestState(patchesDir);
  return state.manifest;
}

/**
 * Loads the patches manifest for a mutating operation.
 *
 * Returns null only when the manifest genuinely does not exist; a manifest
 * that exists but fails to parse/validate throws
 * {@link PatchManifestCorruptError} so the caller aborts instead of
 * rebuilding an empty queue over the top of the corrupt file.
 */
export async function loadPatchesManifestForWrite(
  patchesDir: string
): Promise<PatchesManifest | null> {
  const state = await loadPatchesManifestState(patchesDir);
  if (state.exists && state.manifest === null) {
    throw new PatchManifestCorruptError(join(patchesDir, PATCHES_MANIFEST), state.parseError);
  }
  return state.manifest;
}

/**
 * Saves the patches manifest.
 * @param patchesDir - Path to the patches directory
 * @param manifest - Manifest to save
 */
export async function savePatchesManifest(
  patchesDir: string,
  manifest: PatchesManifest
): Promise<void> {
  const manifestPath = join(patchesDir, PATCHES_MANIFEST);
  await writeJson(manifestPath, manifest);
}

/**
 * Mutates selected manifest rows while preserving the raw JSON shape of every
 * untouched row. This avoids serializing reader-only fallback fields, such as
 * `sourceVersion` derived from legacy `sourceEsrVersion`, into unrelated patch
 * entries during partial metadata updates.
 */
export async function mutatePatchRowsInManifest(
  patchesDir: string,
  filenames: readonly string[],
  mutator: (
    existing: PatchMetadata,
    rawExisting: Readonly<Record<string, unknown>>
  ) => PatchManifestRowMutation | null
): Promise<PatchManifestRowMutationResult[] | null> {
  const manifestPath = join(patchesDir, PATCHES_MANIFEST);
  if (!(await pathExistsStrict(manifestPath))) return null;

  const rawManifest = await readJson<unknown>(manifestPath);
  const beforeManifest = validatePatchesManifest(rawManifest);
  if (!isObject(rawManifest) || !isArray(rawManifest['patches'])) {
    throw new Error('patches.json must be a JSON object with a patches array');
  }

  const filenameSet = new Set(filenames);
  if (filenameSet.size === 0) return [];

  const rawPatches = rawManifest['patches'].map((entry) => {
    if (!isObject(entry)) {
      throw new Error('patches.json patches entries must be objects');
    }
    return { ...entry };
  });

  const changedIndexes: number[] = [];
  for (const [index, rawPatch] of rawPatches.entries()) {
    const filename = rawPatch['filename'];
    if (typeof filename !== 'string' || !filenameSet.has(filename)) continue;

    const existing = beforeManifest.patches[index];
    if (!existing) continue;

    const mutation = mutator(existing, rawPatch);
    if (!mutation) continue;

    for (const [field, value] of Object.entries(mutation.set ?? {})) {
      rawPatch[field] = value;
    }
    for (const field of mutation.unset ?? []) {
      rawPatch[field] = undefined;
    }
    changedIndexes.push(index);
  }

  if (changedIndexes.length === 0) return [];

  const nextRawManifest = {
    ...rawManifest,
    patches: rawPatches,
  };
  const afterManifest = validatePatchesManifest(nextRawManifest);
  await writeJson(manifestPath, nextRawManifest);

  return changedIndexes.map((index) => ({
    before: beforeManifest.patches[index] as PatchMetadata,
    after: afterManifest.patches[index] as PatchMetadata,
  }));
}

/**
 * Adds or updates a patch entry in the manifest.
 * @param patchesDir - Path to the patches directory
 * @param metadata - Patch metadata to add/update
 * @param removeFilenames - Optional filenames to remove in the same read-modify-write cycle
 */
export async function addPatchToManifest(
  patchesDir: string,
  metadata: PatchMetadata,
  removeFilenames?: string[]
): Promise<void> {
  // ForWrite: a corrupt manifest must abort here, not be rebuilt as empty.
  const manifest = (await loadPatchesManifestForWrite(patchesDir)) ?? {
    version: 1 as const,
    patches: [],
  };

  // Remove existing entry with same filename if present
  manifest.patches = manifest.patches.filter((p) => p.filename !== metadata.filename);

  // Remove superseded entries in the same cycle to avoid race conditions
  if (removeFilenames && removeFilenames.length > 0) {
    const removeSet = new Set(removeFilenames);
    manifest.patches = manifest.patches.filter((p) => !removeSet.has(p.filename));
  }

  // Add new entry and sort by order
  manifest.patches.push(metadata);
  manifest.patches.sort((a, b) => a.order - b.order);

  await savePatchesManifest(patchesDir, manifest);
}

/**
 * Removes a single patch entry from the manifest by filename. Leaves the
 * ordinal gap in place — callers wanting to close the gap must use
 * {@link renumberPatchesInManifest} explicitly. This matches the spec: delete
 * is a row removal, not a resequencing.
 *
 * Not atomic with any on-disk patch file deletion; callers are expected to
 * remove the .patch file separately under the same lock.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Filename of the patch to remove from the manifest
 * @returns True when the manifest was written (i.e. an entry was removed),
 *   false when no matching entry existed
 */
export async function removePatchFromManifest(
  patchesDir: string,
  filename: string
): Promise<boolean> {
  const manifest = await loadPatchesManifestForWrite(patchesDir);
  if (!manifest) return false;

  const originalLength = manifest.patches.length;
  manifest.patches = manifest.patches.filter((p) => p.filename !== filename);

  if (manifest.patches.length === originalLength) {
    return false;
  }

  await savePatchesManifest(patchesDir, manifest);
  return true;
}

/**
 * A single rename step in a {@link renumberPatchesInManifest} plan.
 */
export interface PatchRenameEntry {
  /** New filename (e.g. `005-ui-sidebar.patch`). */
  newFilename: string;
  /** New numeric order — must match the prefix of `newFilename`. */
  newOrder: number;
}

/**
 * Rewrites `stagedDependencies.forwardImports[].owner` and
 * `stagedDependencies.registrations[].owner` references on one patch
 * through a rename lookup. Owners embed exact patch filenames, so any
 * renumber (compact, reorder, placement export, rename) that does not remap
 * them leaves dangling references that surface as false forward-import
 * errors on the next lint.
 *
 * Pure and allocation-conservative: returns the input object unchanged when
 * no owner matches the lookup, so callers can map whole manifests cheaply.
 *
 * @param patch - Manifest row to rewrite
 * @param renameLookup - Maps an old patch filename to its new filename, or
 *   undefined when the filename is not being renamed
 * @returns The same row, or a copy with remapped owners
 */
export function rewriteStagedDependencyOwners(
  patch: PatchMetadata,
  renameLookup: (oldFilename: string) => string | undefined
): PatchMetadata {
  const staged = patch.stagedDependencies;
  if (!staged) return patch;

  const rewriteOwners = <T extends { owner?: string }>(
    entries: T[] | undefined
  ): { entries: T[] | undefined; changed: boolean } => {
    if (!entries || entries.length === 0) return { entries, changed: false };
    const rewritten = entries.map((entry) => {
      if (!entry.owner) return entry;
      const newOwner = renameLookup(entry.owner);
      if (newOwner === undefined || newOwner === entry.owner) return entry;
      return { ...entry, owner: newOwner };
    });
    return {
      entries: rewritten,
      changed: rewritten.some((entry, index) => entry !== entries[index]),
    };
  };

  const forwardImports = rewriteOwners(staged.forwardImports);
  const registrations = rewriteOwners(staged.registrations);
  if (!forwardImports.changed && !registrations.changed) return patch;
  return {
    ...patch,
    stagedDependencies: {
      ...staged,
      ...(forwardImports.entries !== undefined ? { forwardImports: forwardImports.entries } : {}),
      ...(registrations.entries !== undefined ? { registrations: registrations.entries } : {}),
    },
  };
}

/**
 * Renames patch files on disk and rewrites the corresponding manifest rows
 * atomically-ish: file renames use a two-phase staging strategy (rename each
 * entry to a unique temp filename first, then rename the temp to its final
 * target) so cycles like `003 → 005` while `005` also moves do not collide.
 *
 * The manifest is rewritten once at the end with all new filenames and
 * orders. Failure semantics:
 *
 *   - **Phase 1 (stage)**: rolls back by renaming staged files back to
 *     their originals. Manifest is untouched. Best-effort — a rollback
 *     rename failure is warned but not re-thrown.
 *   - **Phase 2 (stage → final)**: rolls back to the pre-operation state
 *     by reversing every partial step: files already at their final
 *     names are renamed back to staging, and all staged files are then
 *     renamed back to their originals. The manifest is untouched. If
 *     the rollback itself fails midway, the thrown error is augmented
 *     with a description of the residue so the operator can inspect.
 *   - **Phase 3 (manifest write)**: by this point all files are on disk
 *     at their new names; a manifest write failure will roll the files
 *     back to their original names before re-throwing so the directory
 *     and manifest stay in agreement. A rollback failure at this stage
 *     is warned (manifest was never mutated) and the original error is
 *     re-thrown.
 *
 * Does not sort the rename map for the caller — the map is the authoritative
 * plan. Entries not present in the map keep their existing filename and
 * order.
 *
 * @param patchesDir - Path to the patches directory
 * @param renameMap - Map from existing filename → new filename/order
 */
export async function renumberPatchesInManifest(
  patchesDir: string,
  renameMap: Map<string, PatchRenameEntry>
): Promise<void> {
  if (renameMap.size === 0) return;

  const manifest = await loadPatchesManifestForWrite(patchesDir);
  if (!manifest) {
    throw new Error('Cannot renumber patches: patches.json is missing.');
  }

  // Phase 1: rename each old filename to a unique temp staging name so the
  // later rename to the final target cannot collide with another entry
  // currently occupying that slot.
  const stagingId = randomUUID();
  const stagedRenames: Array<{ from: string; staged: string; toEntry: PatchRenameEntry }> = [];

  try {
    for (const [oldFilename, entry] of renameMap) {
      const oldPath = join(patchesDir, oldFilename);
      if (!(await pathExistsStrict(oldPath))) {
        throw new Error(`Cannot renumber: patch file is missing on disk: ${oldFilename}`);
      }
      const stagedName = `.fireforge-renumber-${stagingId}-${oldFilename}`;
      const stagedPath = join(patchesDir, stagedName);
      await rename(oldPath, stagedPath);
      stagedRenames.push({ from: oldFilename, staged: stagedName, toEntry: entry });
    }
  } catch (error: unknown) {
    // Roll back phase 1: put any already-staged files back.
    for (const { from, staged } of stagedRenames) {
      try {
        await rename(join(patchesDir, staged), join(patchesDir, from));
      } catch (rollbackError: unknown) {
        warn(
          `Rollback warning: could not restore ${from} from staging: ${toError(rollbackError).message}`
        );
      }
    }
    throw error;
  }

  // Phase 2: rename each staged file to its final target, tracking which
  // entries have completed so we can reverse the partial state on failure.
  const completedFinalRenames: Array<{ from: string; staged: string; toEntry: PatchRenameEntry }> =
    [];
  try {
    for (const stagedEntry of stagedRenames) {
      const { staged, toEntry } = stagedEntry;
      const targetPath = join(patchesDir, toEntry.newFilename);
      if (await pathExistsStrict(targetPath)) {
        throw new Error(
          `Cannot renumber: target patch filename already exists on disk: ${toEntry.newFilename}`
        );
      }
      await rename(join(patchesDir, staged), targetPath);
      // Postcondition assert: confirm the target actually exists on
      // disk before we mark the rename complete. A silent rename
      // failure would leave the manifest and the filesystem
      // disagreeing — exactly what the eval 1 Finding #7 report
      // described: manifest rewrote to new filenames while the old
      // files stayed on disk. If the assert ever fires, the Phase 2
      // rollback will undo prior moves before re-throwing.
      if (!(await pathExistsStrict(targetPath))) {
        throw new Error(
          `Rename postcondition failed: expected ${toEntry.newFilename} to exist after rename, but it was not found on disk.`
        );
      }
      completedFinalRenames.push(stagedEntry);
    }
  } catch (error: unknown) {
    // Phase 2 rollback — reverse both the partial final-name moves and
    // the phase-1 staging. This collapses the directory back to its
    // pre-operation filenames so the manifest (which was never
    // touched) remains consistent with what is on disk. If any
    // individual rollback step itself fails, we warn with the residue
    // filename so the operator can finish the cleanup by hand, but we
    // still re-throw the original error so the caller sees the real
    // cause.
    const residue: string[] = [];
    for (const completed of completedFinalRenames) {
      try {
        await rename(
          join(patchesDir, completed.toEntry.newFilename),
          join(patchesDir, completed.staged)
        );
      } catch (rollbackError: unknown) {
        residue.push(completed.toEntry.newFilename);
        warn(
          `Rollback warning: could not revert ${completed.toEntry.newFilename} to staging: ${toError(rollbackError).message}`
        );
      }
    }
    for (const stagedEntry of stagedRenames) {
      try {
        await rename(join(patchesDir, stagedEntry.staged), join(patchesDir, stagedEntry.from));
      } catch (rollbackError: unknown) {
        residue.push(stagedEntry.staged);
        warn(
          `Rollback warning: could not restore ${stagedEntry.from} from staging: ${toError(rollbackError).message}`
        );
      }
    }
    if (residue.length > 0) {
      warn(
        `Renumber phase 2 rollback left residue files (pattern: .fireforge-renumber-${stagingId}-*). ` +
          `Inspect ${patchesDir} and remove or rename: ${residue.join(', ')}`
      );
    }
    throw error;
  }

  // Phase 3: rewrite the manifest rows. Any entry without a rename keeps its
  // existing metadata; entries in the map get their filename + order
  // updated. Sort by the new order so the manifest remains ordered.
  const filenameUpdates = new Map<string, PatchRenameEntry>();
  for (const [oldFilename, entry] of renameMap) {
    filenameUpdates.set(oldFilename, entry);
  }
  // Owner references live on *other* patches than the renamed ones, so every
  // row is passed through the staged-dependency rewrite, not just renamed rows.
  const ownerLookup = (oldFilename: string): string | undefined =>
    filenameUpdates.get(oldFilename)?.newFilename;
  const updatedPatches: PatchMetadata[] = manifest.patches.map((p) => {
    const update = filenameUpdates.get(p.filename);
    const withOwners = rewriteStagedDependencyOwners(p, ownerLookup);
    if (!update) return withOwners;
    return {
      ...withOwners,
      filename: update.newFilename,
      order: update.newOrder,
    };
  });

  updatedPatches.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));

  try {
    await savePatchesManifest(patchesDir, {
      ...manifest,
      patches: updatedPatches,
    });
  } catch (error: unknown) {
    // Phase 3 rollback: reverse every completed rename. The manifest
    // save failed before it could be persisted, so the on-disk state
    // must match what the manifest still records. Best-effort: any
    // individual step that fails gets warned; the original save
    // error is always re-thrown so the caller sees the real cause.
    for (const completed of completedFinalRenames) {
      try {
        await rename(
          join(patchesDir, completed.toEntry.newFilename),
          join(patchesDir, completed.from)
        );
      } catch (rollbackError: unknown) {
        warn(
          `Rollback warning: could not revert ${completed.toEntry.newFilename} → ${completed.from} after manifest save failed: ${toError(rollbackError).message}`
        );
      }
    }
    throw error;
  }
}

/**
 * Thrown when {@link removePatchFileAndManifest} cannot complete the file
 * delete AND cannot restore the manifest row afterward, so the on-disk
 * state and manifest state are known to disagree. Carries both the
 * primary delete error and the rollback error so the caller (and the
 * operator) can see the full failure chain instead of only the original
 * error with a warning about the rollback buried in logs.
 *
 * Extends {@link FireForgeError} so the CLI top-level handler routes it
 * through the rich-error formatter rather than the generic unexpected-error
 * path; the dedicated `.name` is kept so programmatic callers and tests
 * can still distinguish it with `instanceof PatchDeleteRollbackError`.
 */
export class PatchDeleteRollbackError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  constructor(
    public readonly filename: string,
    public readonly deleteError: Error,
    public readonly rollbackError: Error
  ) {
    super(
      `Failed to delete ${filename}, AND failed to restore patches.json afterward. ` +
        `The patch directory is now inconsistent: the manifest no longer lists ${filename} ` +
        `but the patch file may still exist on disk. ` +
        `Delete error: ${deleteError.message}. ` +
        `Manifest rollback error: ${rollbackError.message}. ` +
        `Inspect ${filename} in the patches directory and either remove it or restore the manifest row by hand.`
    );
  }
}

/**
 * Deletes both a patch file on disk and its manifest row under the caller's
 * lock. This is a convenience for the `patch delete` command; callers that
 * need different ordering (e.g. deleting the file first without touching the
 * manifest) should call the primitives separately.
 *
 * Failure semantics: if the manifest row was already removed and the
 * file deletion then fails, the original manifest is restored best-effort
 * and the delete error is re-thrown. If the restore itself also fails,
 * a {@link PatchDeleteRollbackError} is thrown that carries both the
 * delete error and the rollback error so neither is hidden behind a
 * warning log. Callers can detect the compound failure with
 * `instanceof PatchDeleteRollbackError`.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename to delete
 */
export async function removePatchFileAndManifest(
  patchesDir: string,
  filename: string
): Promise<void> {
  const patchPath = join(patchesDir, filename);
  // ForWrite: deleting the patch FILE while a corrupt manifest still
  // references it would strand the queue; abort on corruption instead.
  const originalManifest = await loadPatchesManifestForWrite(patchesDir);
  const removedFromManifest = await removePatchFromManifest(patchesDir, filename);

  try {
    if (await pathExistsStrict(patchPath)) {
      await removeFile(patchPath);
    }
  } catch (error: unknown) {
    const deleteError = toError(error);
    if (removedFromManifest && originalManifest) {
      try {
        await savePatchesManifest(patchesDir, originalManifest);
      } catch (rollbackError: unknown) {
        // Compound failure: both the delete and the rollback failed,
        // so the directory is in a known-inconsistent state. Throw a
        // dedicated error type that carries both causes so the
        // operator's log shows the complete picture instead of the
        // original delete error with a warning about the rollback
        // buried in stderr.
        throw new PatchDeleteRollbackError(filename, deleteError, toError(rollbackError));
      }
    }
    throw deleteError;
  }
}
