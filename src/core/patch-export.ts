// SPDX-License-Identifier: EUPL-1.2
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { PatchCategory, PatchInfo, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, removeFile, writeText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { PATCH_CATEGORIES } from '../utils/validation.js';
import { discoverPatches, isNewFilePatch, withPatchDirectoryLock } from './patch-apply.js';
import {
  addPatchToManifest,
  loadPatchesManifest,
  PATCHES_MANIFEST,
  savePatchesManifest,
} from './patch-manifest.js';

/**
 * Gets the next patch number for a new patch.
 * @param patchesDir - Path to the patches directory
 * @returns Next patch number (e.g., "005" for 4 existing patches)
 */
export async function getNextPatchNumber(patchesDir: string): Promise<string> {
  const patches = await discoverPatches(patchesDir);

  if (patches.length === 0) {
    return '001';
  }

  const finitePatches = patches.filter((p) => Number.isFinite(p.order));
  if (finitePatches.length === 0) return '001';
  const maxOrder = finitePatches.reduce((max, p) => Math.max(max, p.order), 0);
  const nextNumber = maxOrder + 1;

  return String(nextNumber).padStart(Math.max(3, String(nextNumber).length), '0');
}

/**
 * Sanitizes a string for use in a filename.
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Generates the next patch filename with category.
 * @param patchesDir - Path to the patches directory
 * @param category - Patch category
 * @param name - Human-readable name
 * @returns Filename like "001-ui-sidebar.patch"
 */
export async function getNextPatchFilename(
  patchesDir: string,
  category: PatchCategory,
  name: string
): Promise<string> {
  const patchNumber = await getNextPatchNumber(patchesDir);
  const sanitizedName = sanitizeName(name);

  return `${patchNumber}-${category}-${sanitizedName}.patch`;
}

export interface CommitExportedPatchInput {
  patchesDir: string;
  category: PatchCategory;
  name: string;
  description: string;
  diff: string;
  filesAffected: string[];
  sourceEsrVersion: string;
}

export interface CommitExportedPatchResult {
  patchFilename: string;
  metadata: PatchMetadata;
  superseded: PatchInfo[];
}

/**
 * Commits a freshly generated patch file and manifest update under an exclusive
 * patch directory lock so concurrent exports cannot allocate the same number.
 */
export async function commitExportedPatch(
  input: CommitExportedPatchInput
): Promise<CommitExportedPatchResult> {
  return withPatchDirectoryLock(input.patchesDir, async () => {
    const patchFilename = await getNextPatchFilename(input.patchesDir, input.category, input.name);
    const patchPath = join(input.patchesDir, patchFilename);
    const metadata: PatchMetadata = {
      filename: patchFilename,
      order: parseInt(patchFilename.split('-')[0] ?? '0', 10),
      category: input.category,
      name: input.name,
      description: input.description,
      createdAt: new Date().toISOString(),
      sourceEsrVersion: input.sourceEsrVersion,
      filesAffected: input.filesAffected,
    };

    const superseded = await findAllPatchesForFiles(
      input.patchesDir,
      input.filesAffected,
      patchFilename
    );
    const supersededFilenames = superseded.map((patch) => patch.filename);
    const originalManifest = await loadPatchesManifest(input.patchesDir);
    const originalPatchContent = (await pathExists(patchPath)) ? await readText(patchPath) : null;
    const removedPatchContents = new Map<string, string>();

    for (const oldPatch of superseded) {
      if (await pathExists(oldPatch.path)) {
        removedPatchContents.set(oldPatch.path, await readText(oldPatch.path));
      }
    }

    try {
      await writeText(patchPath, input.diff);

      await addPatchToManifest(input.patchesDir, metadata, supersededFilenames);

      for (const oldPatch of superseded) {
        await removeFile(oldPatch.path);
      }
    } catch (error: unknown) {
      // Best-effort rollback: wrap each operation so a secondary failure
      // never masks the original failure.
      try {
        if (originalPatchContent === null) {
          await removeFile(patchPath);
        } else {
          await writeText(patchPath, originalPatchContent);
        }
      } catch (error: unknown) {
        warn(`Rollback warning: could not restore patch file: ${toError(error).message}`);
      }

      for (const [oldPatchPath, oldPatchContent] of removedPatchContents) {
        try {
          await writeText(oldPatchPath, oldPatchContent);
        } catch (error: unknown) {
          warn(`Rollback warning: could not restore ${oldPatchPath}: ${toError(error).message}`);
        }
      }

      try {
        if (originalManifest) {
          await savePatchesManifest(input.patchesDir, originalManifest);
        } else {
          await removeFile(join(input.patchesDir, PATCHES_MANIFEST));
        }
      } catch (error: unknown) {
        warn(`Rollback warning: could not restore manifest: ${toError(error).message}`);
      }

      throw error;
    }

    return {
      patchFilename,
      metadata,
      superseded,
    };
  });
}

/**
 * Parses a patch filename to extract order, category, and name.
 * Supports both new format (001-category-name.patch) and legacy (001-name.patch).
 */
export function parseFilename(filename: string): {
  order: number;
  category: PatchCategory | null;
  name: string;
} {
  // New format: 001-ui-sidebar.patch
  const newMatch = /^(\d+)-([a-z]+)-(.+)\.patch$/.exec(filename);
  if (newMatch?.[1] && newMatch[2] && newMatch[3]) {
    const orderStr = newMatch[1];
    const category = newMatch[2];
    const name = newMatch[3];
    if (PATCH_CATEGORIES.includes(category as PatchCategory)) {
      return {
        order: parseInt(orderStr, 10),
        category: category as PatchCategory,
        name,
      };
    }
  }

  // Legacy format: 001-name.patch
  const legacyMatch = /^(\d+)-(.+)\.patch$/.exec(filename);
  if (legacyMatch?.[1] && legacyMatch[2]) {
    return {
      order: parseInt(legacyMatch[1], 10),
      category: null,
      name: legacyMatch[2],
    };
  }

  return { order: Infinity, category: null, name: filename };
}

/**
 * Finds an existing patch that contains the specified file.
 * Returns the most recent (highest order) patch if multiple exist.
 * @param patchesDir - Path to the patches directory
 * @param filePath - File path to search for
 * @returns The patch info and metadata, or null if not found
 */
export async function findExistingPatchForFile(
  patchesDir: string,
  filePath: string
): Promise<{ patch: PatchInfo; metadata: PatchMetadata } | null> {
  const { findPatchesAffectingFile } = await import('./patch-manifest.js');
  const affectingPatches = await findPatchesAffectingFile(patchesDir, filePath);

  if (affectingPatches.length === 0) {
    return null;
  }

  // Return the most recent (highest order) patch
  return affectingPatches[affectingPatches.length - 1] ?? null;
}

/**
 * Updates the content of a patch file.
 * @param patchPath - Path to the patch file
 * @param newContent - New patch content
 */
export async function updatePatch(patchPath: string, newContent: string): Promise<void> {
  await writeText(patchPath, newContent);
}

/**
 * Updates metadata for a patch in the manifest.
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename
 * @param updates - Partial metadata updates
 */
export async function updatePatchMetadata(
  patchesDir: string,
  filename: string,
  updates: Partial<PatchMetadata>
): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) return;

    const patchIndex = manifest.patches.findIndex((p) => p.filename === filename);
    if (patchIndex === -1) return;

    const existingPatch = manifest.patches[patchIndex];
    if (existingPatch) {
      manifest.patches[patchIndex] = { ...existingPatch, ...updates };
      await savePatchesManifest(patchesDir, manifest);
    }
  });
}

/**
 * Finds patches that are completely superseded by newer patches.
 * A patch is superseded if all its affected files are covered by newer patches.
 * @param patchesDir - Path to the patches directory
 * @param newPatchFiles - Files affected by the new patch
 * @param excludeFilename - Filename to exclude from results (the new patch itself)
 * @returns Superseded patches
 */
export async function findSupersededPatches(
  patchesDir: string,
  newPatchFiles: string[],
  excludeFilename?: string
): Promise<PatchInfo[]> {
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return [];

  const patches = await discoverPatches(patchesDir);
  const superseded: PatchInfo[] = [];

  for (const metadata of manifest.patches) {
    // Skip the new patch itself
    if (excludeFilename && metadata.filename === excludeFilename) continue;

    // Check if this is a "new file" patch (single file, created from scratch)
    // A patch is superseded if it's a single-file new-file patch and
    // the new patch covers the same file
    if (metadata.filesAffected.length === 1) {
      const affectedFile = metadata.filesAffected[0];
      if (affectedFile && newPatchFiles.includes(affectedFile)) {
        const patch = patches.find((p) => p.filename === metadata.filename);
        if (patch && (await isNewFilePatch(patch.path))) {
          superseded.push(patch);
        }
      }
    }
  }

  return superseded;
}

/**
 * Deletes a patch file and removes it from the manifest.
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename to delete
 */
export async function deletePatch(patchesDir: string, filename: string): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
    const patchPath = join(patchesDir, filename);
    const manifest = await loadPatchesManifest(patchesDir);
    const updatedManifest = manifest
      ? {
          ...manifest,
          patches: manifest.patches.filter((patch) => patch.filename !== filename),
        }
      : null;

    // Update manifest first so interrupted deletions leave an explicit repairable
    // extra patch file rather than silently dropping metadata for an absent file.
    if (updatedManifest) {
      await savePatchesManifest(patchesDir, updatedManifest);
    }

    if (!(await pathExists(patchPath))) {
      return;
    }

    try {
      await unlink(patchPath);
    } catch (error: unknown) {
      if (manifest) {
        try {
          await savePatchesManifest(patchesDir, manifest);
        } catch (error: unknown) {
          warn(
            `Failed to restore manifest after patch deletion error for "${filename}": ${toError(error).message}`
          );
        }
      }
      throw error;
    }
  });
}

/**
 * Checks whether a patch is fully covered by a new export.
 * A patch is fully covered when every file it affects is present in the new export.
 * @param patchFiles - Files affected by the existing patch
 * @param targetFiles - Files affected by the new export
 * @returns True when the existing patch is fully covered
 */
export function isPatchFullyCovered(patchFiles: string[], targetFiles: string[]): boolean {
  if (patchFiles.length === 0) {
    return false;
  }

  const targetFileSet = new Set(targetFiles);
  return patchFiles.every((file) => targetFileSet.has(file));
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
    // Skip the new patch itself
    if (excludeFilename && metadata.filename === excludeFilename) continue;

    if (isPatchFullyCovered(metadata.filesAffected, targetFiles)) {
      const patch = patches.find((p) => p.filename === metadata.filename);
      if (patch) {
        superseded.push(patch);
      }
    }
  }

  return superseded;
}
