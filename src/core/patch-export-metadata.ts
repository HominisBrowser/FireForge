// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest metadata mutation helpers for patch export commands.
 */

import type { PatchMetadata } from '../types/commands/index.js';
import { withPatchDirectoryLock } from './patch-apply.js';
import type { PatchDirectoryLockOptions } from './patch-lock.js';
import { mutatePatchRowsInManifest } from './patch-manifest.js';

/**
 * Optional `PatchMetadata` keys safe to clear via the helpers below.
 */
export type ClearablePatchMetadataField = 'tier' | 'lintIgnore' | 'stagedDependencies';

/**
 * Updates metadata for a patch in the manifest.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename
 * @param updates - Field values to set
 * @param unsetFields - Optional fields to remove from the entry
 * @param lockOptions - `--wait-lock` budget and the command name recorded in
 *   the lock's owner metadata. Threaded from the CLI so a caller that waits
 *   is not silently given the default 30s budget.
 */
export async function updatePatchMetadata(
  patchesDir: string,
  filename: string,
  updates: Partial<PatchMetadata>,
  unsetFields: ReadonlyArray<ClearablePatchMetadataField> = [],
  lockOptions: PatchDirectoryLockOptions = {}
): Promise<void> {
  await withPatchDirectoryLock(
    patchesDir,
    async () => {
      await mutatePatchRowsInManifest(patchesDir, [filename], () => ({
        set: updates,
        unset: unsetFields,
      }));
    },
    lockOptions
  );
}

/** Return shape from a `mutatePatchMetadata` mutator. */
export interface PatchMetadataMutation {
  /** Field values to set on the entry. */
  set?: Partial<PatchMetadata>;
  /** Optional fields to remove from the entry entirely. */
  unset?: ReadonlyArray<ClearablePatchMetadataField>;
}

/** Result of a successful `mutatePatchMetadata` call. */
export interface PatchMetadataMutationResult {
  /** Pre-mutation snapshot of the patch's metadata. */
  before: PatchMetadata;
  /** Post-mutation state of the patch's metadata. */
  after: PatchMetadata;
}

/**
 * Reads a patch's metadata under the directory lock, applies a mutator
 * function to compute the update, and writes the result back.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename
 * @param mutator - Computes the update from the existing metadata
 * @param lockOptions - `--wait-lock` budget and owner-metadata command name
 * @returns Before/after metadata, or null when the patch was not found
 */
export async function mutatePatchMetadata(
  patchesDir: string,
  filename: string,
  mutator: (existing: PatchMetadata) => PatchMetadataMutation,
  lockOptions: PatchDirectoryLockOptions = {}
): Promise<PatchMetadataMutationResult | null> {
  return await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const result = await mutatePatchRowsInManifest(patchesDir, [filename], (existing) => {
        const { set = {}, unset = [] } = mutator(existing);
        return { set, unset };
      });
      const changed = result?.[0];
      if (!changed) return null;
      return { before: changed.before, after: changed.after };
    },
    lockOptions
  );
}
