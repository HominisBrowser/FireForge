// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest I/O: load, save, and add operations for patches.json.
 */

import { join } from 'node:path';

import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { validatePatchesManifest } from './patch-manifest-validate.js';

/** Filename for the patches manifest */
export const PATCHES_MANIFEST = 'patches.json';

/** Internal state returned by loadPatchesManifestState. */
export interface LoadedManifestState {
  exists: boolean;
  manifest: PatchesManifest | null;
  parseError: Error | undefined;
}

/**
 * Loads and validates the patches manifest, returning full state information.
 * @param patchesDir - Path to the patches directory
 */
export async function loadPatchesManifestState(patchesDir: string): Promise<LoadedManifestState> {
  const manifestPath = join(patchesDir, PATCHES_MANIFEST);
  if (!(await pathExists(manifestPath))) {
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
 * @param patchesDir - Path to the patches directory
 * @returns PatchesManifest or null if not found
 */
export async function loadPatchesManifest(patchesDir: string): Promise<PatchesManifest | null> {
  const state = await loadPatchesManifestState(patchesDir);
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
  const manifest = (await loadPatchesManifest(patchesDir)) ?? {
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
