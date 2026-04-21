// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest consistency checks and rebuild/recovery operations.
 */

import { stat } from 'node:fs/promises';

import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { discoverPatches, getAllTargetFilesFromPatch } from './patch-files.js';
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

    const declaredFiles = normalizeFiles(metadata.filesAffected);
    const actualFiles = normalizeFiles(await getAllTargetFilesFromPatch(patch.path));
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
 * Summary of a {@link rebuildPatchesManifest} run. `recoveredFilenames`
 * lists patches whose manifest entry was reconstructed from filename,
 * mtime, and diff alone (no pre-existing manifest entry to preserve).
 * These entries carry generic descriptions and mtime-based
 * timestamps; callers like `doctor --repair-patches-manifest` surface
 * a per-patch review warning so operators know which metadata was
 * invented vs which was restored.
 */
export interface RebuildPatchesManifestResult {
  /** Rebuilt manifest, ready to be re-applied by callers (already persisted). */
  manifest: PatchesManifest;
  /**
   * Filenames whose manifest entry had no pre-existing metadata to
   * preserve — every descriptive field on these entries is inferred.
   */
  recoveredFilenames: string[];
}

/**
 * Rebuilds patches.json from the patch files currently present on disk.
 * Existing metadata is preserved when possible; missing entries are recovered
 * from filename structure, patch contents, and file mtimes.
 * @param patchesDir - Path to the patches directory
 * @param fallbackSourceEsrVersion - ESR version to use for recovered entries
 * @returns {@link RebuildPatchesManifestResult} — the persisted manifest
 *   plus the filenames that were reconstructed from generic defaults.
 */
export async function rebuildPatchesManifest(
  patchesDir: string,
  fallbackSourceEsrVersion: string
): Promise<RebuildPatchesManifestResult> {
  const manifestState: LoadedManifestState = await loadPatchesManifestState(patchesDir);
  const existingEntries = new Map<string, PatchMetadata>();

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

  for (const patch of patches) {
    const existing = existingEntries.get(patch.filename);
    const filesAffected = normalizeFiles(await getAllTargetFilesFromPatch(patch.path));
    const patchStats = await stat(patch.path);
    const inferred = inferPatchMetadataFromFilename(patch.filename);
    const recoveredOrder = Number.isFinite(patch.order) ? patch.order : nextRecoveredOrder++;

    if (!existing) {
      // Track every filename that had no pre-existing manifest entry
      // so callers can warn the operator per-patch. A missing entry
      // means every descriptive field (`description`, `createdAt`,
      // `category`) was invented rather than preserved. FireForge
      // patch files carry no header metadata that could carry a
      // human description forward, so full fidelity is impossible —
      // visibility is the best we can offer. 2026-04-21 eval
      // (Finding #17) tripped over silent overwrites of useful
      // human-written descriptions during a recovery run.
      recoveredFilenames.push(patch.filename);
    }

    rebuiltPatches.push({
      filename: patch.filename,
      order: recoveredOrder,
      category: existing?.category ?? inferred.category,
      name: existing?.name ?? inferred.name,
      description:
        existing?.description ??
        `Recovered manifest entry for ${patch.filename}. Review description and ESR version.`,
      createdAt: existing?.createdAt ?? new Date(patchStats.mtimeMs).toISOString(),
      sourceEsrVersion: existing?.sourceEsrVersion ?? fallbackSourceEsrVersion,
      filesAffected,
    });
  }

  rebuiltPatches.sort(
    (left, right) => left.order - right.order || left.filename.localeCompare(right.filename)
  );

  const rebuiltManifest: PatchesManifest = {
    version: 1,
    patches: rebuiltPatches,
  };

  await savePatchesManifest(patchesDir, rebuiltManifest);
  return { manifest: rebuiltManifest, recoveredFilenames };
}

function normalizeFiles(files: string[]): string[] {
  return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right));
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
