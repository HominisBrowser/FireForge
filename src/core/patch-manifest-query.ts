// SPDX-License-Identifier: EUPL-1.2
/**
 * Query helpers: finding patches by file, integrity checks, version compat, stamping.
 */

import type { PatchesManifest, PatchInfo, PatchMetadata } from '../types/commands/index.js';
import type { FirefoxProduct } from '../types/config.js';
import { readText } from '../utils/fs.js';
import { listTrackedInHead } from './git-file-ops.js';
import { discoverPatches, getAllTargetFilesFromPatch } from './patch-files.js';
import { withPatchDirectoryLock } from './patch-lock.js';
import { loadPatchesManifest, mutatePatchRowsInManifest } from './patch-manifest-io.js';
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
 * Checks Firefox source version compatibility.
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

  // Collect every modification target first, then resolve HEAD existence in
  // one batched ls-tree pass (chunked for ARG_MAX). The per-file
  // fileExistsInHead fan-out spawned one git process per (patch × target) on
  // every import: a 56-file branding patch alone cost ~56 spawns before a
  // single patch was applied.
  const modificationTargets: Array<{ filename: string; targetFile: string }> = [];
  for (const patch of patches) {
    // Check all files in the patch (supports multi-file patches)
    const patchContent = await readText(patch.path);
    const targetFiles = await getAllTargetFilesFromPatch(patch.path);

    for (const targetFile of targetFiles) {
      // Skip new-file sections. They don't need to exist in HEAD
      if (isNewFileInPatch(patchContent, targetFile)) continue;
      modificationTargets.push({ filename: patch.filename, targetFile });
    }
  }

  const tracked = await listTrackedInHead(
    engineDir,
    modificationTargets.map((t) => t.targetFile)
  );
  for (const { filename, targetFile } of modificationTargets) {
    if (!tracked.has(targetFile)) {
      issues.push({
        filename,
        message: `Modification patch for file that doesn't exist in source. Re-export with: fireforge export ${targetFile}`,
        targetFile,
      });
    }
  }

  return issues;
}

/**
 * Stamps multiple patches with a new source version in a single
 * manifest read-modify-write cycle.
 *
 * Acquires the shared patch-directory lock for the read-modify-write, so a
 * concurrent export/reorder/metadata update cannot interleave with the stamp.
 * The lock is not reentrant: callers must not invoke this while already
 * holding {@link withPatchDirectoryLock} on the same patches directory.
 *
 * @param patchesDir - Path to the patches directory
 * @param filenames - Patch filenames to update
 * @param newVersion - Version string to set (e.g. "140.9.0esr")
 */
export async function stampPatchVersions(
  patchesDir: string,
  filenames: string[],
  newVersion: string,
  newProduct?: FirefoxProduct
): Promise<void> {
  await withPatchDirectoryLock(patchesDir, () =>
    mutatePatchRowsInManifest(patchesDir, filenames, (patch, rawPatch) => {
      if (
        patch.sourceEsrVersion !== newVersion ||
        rawPatch['sourceVersion'] !== newVersion ||
        (newProduct !== undefined && rawPatch['sourceProduct'] !== newProduct)
      ) {
        return {
          set: {
            sourceEsrVersion: newVersion,
            sourceVersion: newVersion,
            ...(newProduct !== undefined ? { sourceProduct: newProduct } : {}),
          },
        };
      }
      return null;
    })
  );
}
