// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest metadata mutation helpers for patch export commands.
 */

import type { PatchMetadata } from '../types/commands/index.js';
import { withPatchDirectoryLock } from './patch-apply.js';
import { loadPatchesManifest, savePatchesManifest } from './patch-manifest.js';

/**
 * Optional `PatchMetadata` keys safe to clear via the helpers below.
 */
export type ClearablePatchMetadataField = 'tier' | 'lintIgnore';

/**
 * Merges `updates` onto `existing` and removes the listed optional fields.
 */
function applyMetadataUpdate(
  existing: PatchMetadata,
  updates: Partial<PatchMetadata>,
  unset: ReadonlyArray<ClearablePatchMetadataField>
): PatchMetadata {
  const next: PatchMetadata = { ...existing, ...updates };
  for (const field of unset) {
    switch (field) {
      case 'tier':
        delete next.tier;
        break;
      case 'lintIgnore':
        delete next.lintIgnore;
        break;
    }
  }
  return next;
}

/**
 * Updates metadata for a patch in the manifest.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename
 * @param updates - Field values to set
 * @param unsetFields - Optional fields to remove from the entry
 */
export async function updatePatchMetadata(
  patchesDir: string,
  filename: string,
  updates: Partial<PatchMetadata>,
  unsetFields: ReadonlyArray<ClearablePatchMetadataField> = []
): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) return;

    const patchIndex = manifest.patches.findIndex((p) => p.filename === filename);
    if (patchIndex === -1) return;

    const existingPatch = manifest.patches[patchIndex];
    if (existingPatch) {
      manifest.patches[patchIndex] = applyMetadataUpdate(existingPatch, updates, unsetFields);
      await savePatchesManifest(patchesDir, manifest);
    }
  });
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
 */
export async function mutatePatchMetadata(
  patchesDir: string,
  filename: string,
  mutator: (existing: PatchMetadata) => PatchMetadataMutation
): Promise<PatchMetadataMutationResult | null> {
  return await withPatchDirectoryLock(patchesDir, async () => {
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) return null;

    const patchIndex = manifest.patches.findIndex((p) => p.filename === filename);
    if (patchIndex === -1) return null;

    const existingPatch = manifest.patches[patchIndex];
    if (!existingPatch) return null;

    const { set = {}, unset = [] } = mutator(existingPatch);
    const updatedPatch = applyMetadataUpdate(existingPatch, set, unset);
    manifest.patches[patchIndex] = updatedPatch;
    await savePatchesManifest(patchesDir, manifest);
    return { before: existingPatch, after: updatedPatch };
  });
}
