// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch coverage and supersession helpers used by export planning.
 */

import type { PatchInfo, PatchMetadata } from '../types/commands/index.js';
import { discoverPatches } from './patch-apply.js';
import { loadPatchesManifest } from './patch-manifest.js';

/**
 * Report whether a patch is fully covered by a new export, and which of its
 * files caused the coverage.
 */
export interface PatchCoverage {
  covered: boolean;
  byFiles: string[];
}

/**
 * Checks whether a patch is fully covered by a new export.
 * A patch is fully covered when every file it affects is present in the new export.
 * @param patchFiles - Files affected by the existing patch
 * @param targetFiles - Files affected by the new export
 * @returns Coverage report with the triggering file list when `covered` is true
 */
export function isPatchFullyCovered(patchFiles: string[], targetFiles: string[]): PatchCoverage {
  if (patchFiles.length === 0) {
    return { covered: false, byFiles: [] };
  }

  const targetFileSet = new Set(targetFiles);
  const covered = patchFiles.every((file) => targetFileSet.has(file));
  return {
    covered,
    byFiles: covered ? [...patchFiles] : [],
  };
}

/**
 * Finds patches whose filesAffected entries are fully covered by the specified files.
 * Used for complete supersession when exporting full-file patches.
 * @param patchesDir - Path to the patches directory
 * @param targetFiles - Files affected by the new export
 * @param excludeFilename - Filename to exclude from results (the new patch itself)
 * @returns Patches that are fully covered by the new export
 */
export async function findAllPatchesForFiles(
  patchesDir: string,
  targetFiles: string[],
  excludeFilename?: string
): Promise<PatchInfo[]> {
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return [];

  const patches = await discoverPatches(patchesDir);
  const superseded: PatchInfo[] = [];

  for (const metadata of manifest.patches) {
    if (excludeFilename && metadata.filename === excludeFilename) continue;

    if (isPatchFullyCovered(metadata.filesAffected, targetFiles).covered) {
      const patch = patches.find((p) => p.filename === metadata.filename);
      if (patch) {
        superseded.push(patch);
      }
    }
  }

  return superseded;
}

/**
 * Describes which files in a covered patch triggered its supersession.
 * Returned from `planExport` so dry-run previews can render a complete
 * "moved / removed" picture rather than a bare patch count.
 */
export interface SupersedeCoverageDetail {
  /** Existing patch filename. */
  filename: string;
  /** Files the existing patch claimed that the new export also claims. */
  coveredByFiles: string[];
}

/**
 * Resolves coverage details for every existing patch that the new export
 * would fully cover.
 */
export async function findAllPatchesForFilesWithDetails(
  patchesDir: string,
  targetFiles: string[],
  excludeFilename?: string
): Promise<{ patch: PatchInfo; coverage: PatchCoverage; metadata: PatchMetadata }[]> {
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return [];

  const patches = await discoverPatches(patchesDir);
  const results: { patch: PatchInfo; coverage: PatchCoverage; metadata: PatchMetadata }[] = [];

  for (const metadata of manifest.patches) {
    if (excludeFilename && metadata.filename === excludeFilename) continue;
    const coverage = isPatchFullyCovered(metadata.filesAffected, targetFiles);
    if (!coverage.covered) continue;
    const patch = patches.find((p) => p.filename === metadata.filename);
    if (!patch) continue;
    results.push({ patch, coverage, metadata });
  }

  return results;
}
