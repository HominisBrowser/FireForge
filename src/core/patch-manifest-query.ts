// SPDX-License-Identifier: EUPL-1.2
/**
 * Query helpers: finding patches by file, integrity checks, version compat, stamping.
 */

import type { PatchesManifest, PatchInfo, PatchMetadata } from '../types/commands/index.js';
import { readText } from '../utils/fs.js';
import { fileExistsInHead } from './git-file-ops.js';
import { discoverPatches, getAllTargetFilesFromPatch } from './patch-files.js';
import { loadPatchesManifest, savePatchesManifest } from './patch-manifest-io.js';
import { isNewFileInPatch } from './patch-parse.js';

/**
 * Gets all file paths claimed by patches other than the excluded one.
 * @param manifest - The patches manifest
 * @param excludeFilename - Filename to exclude from collection
 * @returns Set of file paths claimed by other patches
 */
export function getClaimedFiles(manifest: PatchesManifest, excludeFilename: string): Set<string> {
  const claimed = new Set<string>();
  for (const patch of manifest.patches) {
    if (patch.filename === excludeFilename) continue;
    for (const file of patch.filesAffected) {
      claimed.add(file);
    }
  }
  return claimed;
}

/**
 * Checks ESR version compatibility.
 * @param patchVersion - Version the patch was created for
 * @param currentVersion - Current project version
 * @returns Warning message if versions differ, null if compatible
 */
export function checkVersionCompatibility(
  patchVersion: string,
  currentVersion: string
): string | null {
  if (patchVersion === currentVersion) {
    return null;
  }

  // Extract major version numbers
  const patchMajor = parseInt(patchVersion.split('.')[0] ?? '0', 10);
  const currentMajor = parseInt(currentVersion.split('.')[0] ?? '0', 10);

  if (patchMajor !== currentMajor) {
    return (
      `Patch was created for Firefox ${patchVersion}, ` +
      `but current version is ${currentVersion}. ` +
      `Major version mismatch may cause conflicts.`
    );
  }

  return (
    `Patch was created for Firefox ${patchVersion}, ` + `current version is ${currentVersion}.`
  );
}

/**
 * Finds all patches that affect a specific file.
 * @param patchesDir - Path to the patches directory
 * @param filePath - File path to search for
 * @returns Patches affecting the file, sorted by order
 */
export async function findPatchesAffectingFile(
  patchesDir: string,
  filePath: string
): Promise<Array<{ patch: PatchInfo; metadata: PatchMetadata }>> {
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return [];

  const patches = await discoverPatches(patchesDir);
  const results: Array<{ patch: PatchInfo; metadata: PatchMetadata }> = [];

  for (const metadata of manifest.patches) {
    if (metadata.filesAffected.includes(filePath)) {
      const patch = patches.find((p) => p.filename === metadata.filename);
      if (patch) {
        results.push({ patch, metadata });
      }
    }
  }

  // Sort by order
  results.sort((a, b) => a.patch.order - b.patch.order);
  return results;
}

/**
 * Validates that all patches can be applied successfully.
 * Detects modification patches that reference files not in the source.
 * @param patchesDir - Path to the patches directory
 * @param engineDir - Path to the engine directory
 * @returns Array of validation issues with details
 */
export async function validatePatchIntegrity(
  patchesDir: string,
  engineDir: string
): Promise<
  Array<{
    filename: string;
    message: string;
    targetFile: string | null;
  }>
> {
  const issues: Array<{
    filename: string;
    message: string;
    targetFile: string | null;
  }> = [];

  const patches = await discoverPatches(patchesDir);

  for (const patch of patches) {
    // Check all files in the patch (supports multi-file patches)
    const patchContent = await readText(patch.path);
    const targetFiles = await getAllTargetFilesFromPatch(patch.path);

    for (const targetFile of targetFiles) {
      // Skip new-file sections — they don't need to exist in HEAD
      if (isNewFileInPatch(patchContent, targetFile)) continue;

      const existsInHead = await fileExistsInHead(engineDir, targetFile);

      if (!existsInHead) {
        issues.push({
          filename: patch.filename,
          message: `Modification patch for file that doesn't exist in source. Re-export with: fireforge export ${targetFile}`,
          targetFile,
        });
      }
    }
  }

  return issues;
}

/**
 * Stamps multiple patches with a new `sourceEsrVersion` in a single
 * manifest read-modify-write cycle.
 * @param patchesDir - Path to the patches directory
 * @param filenames - Patch filenames to update
 * @param newVersion - Version string to set (e.g. "140.0esr")
 */
export async function stampPatchVersions(
  patchesDir: string,
  filenames: string[],
  newVersion: string
): Promise<void> {
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return;

  const filenameSet = new Set(filenames);
  let modified = false;

  for (const patch of manifest.patches) {
    if (filenameSet.has(patch.filename) && patch.sourceEsrVersion !== newVersion) {
      patch.sourceEsrVersion = newVersion;
      modified = true;
    }
  }

  if (modified) {
    await savePatchesManifest(patchesDir, manifest);
  }
}
