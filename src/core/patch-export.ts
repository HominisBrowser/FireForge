// SPDX-License-Identifier: EUPL-1.2
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  PatchCategory,
  PatchesManifest,
  PatchInfo,
  PatchMetadata,
} from '../types/commands/index.js';
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
 * Sanitizes a human-readable name into a filename slug.
 *
 * Exported so `patch rename` can produce a filename slug from its
 * `--to <new-name>` argument using the exact same convention `export`
 * uses, without duplicating the lowercase + non-alnum collapse + length
 * cap rules. Drift between the two would let an operator rename a patch
 * to a slug `export` could never reach.
 */
export function sanitizeName(name: string): string {
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
  /** Optional `PatchMetadata.tier` opt-in (only `"branding"` recognised). */
  tier?: 'branding';
  /** Optional `PatchMetadata.lintIgnore` (empty array treated as absent). */
  lintIgnore?: string[];
}

export interface CommitExportedPatchResult {
  patchFilename: string;
  metadata: PatchMetadata;
  superseded: PatchInfo[];
}

/**
 * Commits a freshly generated patch file and manifest update under an
 * exclusive patch directory lock so concurrent exports cannot allocate the
 * same number. Shares {@link computeExportPlanUnderLock} with
 * {@link planExport} so the dry-run preview cannot drift from the real
 * write: both paths go through the same planning helper, and any bug fix
 * to filename allocation or supersede detection lands in both automatically.
 */
export async function commitExportedPatch(
  input: CommitExportedPatchInput
): Promise<CommitExportedPatchResult> {
  return withPatchDirectoryLock(input.patchesDir, async () => {
    const plan = await computeExportPlanUnderLock({
      patchesDir: input.patchesDir,
      category: input.category,
      name: input.name,
      description: input.description,
      filesAffected: input.filesAffected,
      sourceEsrVersion: input.sourceEsrVersion,
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.lintIgnore !== undefined ? { lintIgnore: input.lintIgnore } : {}),
    });

    const patchPath = plan.patchPath;
    const originalPatchContent = (await pathExists(patchPath)) ? await readText(patchPath) : null;
    const removedPatchContents = new Map<string, string>();

    for (const oldPatch of plan.supersededPatches) {
      if (await pathExists(oldPatch.path)) {
        removedPatchContents.set(oldPatch.path, await readText(oldPatch.path));
      }
    }

    try {
      await writeText(patchPath, input.diff);

      await addPatchToManifest(
        input.patchesDir,
        plan.metadata,
        plan.supersededPatches.map((p) => p.filename)
      );

      for (const oldPatch of plan.supersededPatches) {
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
        if (plan.manifestBefore) {
          await savePatchesManifest(input.patchesDir, plan.manifestBefore);
        } else {
          await removeFile(join(input.patchesDir, PATCHES_MANIFEST));
        }
      } catch (error: unknown) {
        warn(`Rollback warning: could not restore manifest: ${toError(error).message}`);
      }

      throw error;
    }

    return {
      patchFilename: plan.patchFilename,
      metadata: plan.metadata,
      superseded: plan.supersededPatches,
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
 * Optional post-commit hook for {@link updatePatchAndMetadata}. Runs inside
 * the patch directory lock after the mutation has succeeded but before the
 * lock is released. Intended for history-log appends so the audit record
 * lands atomically with the mutation. Hook failures are warned but never
 * re-thrown: by the time the hook runs the mutation is already committed,
 * so there is nothing meaningful to roll back.
 */
export type UpdatePatchCommittedHook = () => Promise<void>;

/**
 * Updates a patch file body and its manifest row under the same patch
 * directory lock. Intended for commands like `re-export --files` where the
 * file body and `filesAffected` metadata must move together.
 *
 * If the manifest write fails after the patch body has been rewritten, the
 * original patch content is restored best-effort before the error is
 * re-thrown.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Target patch filename
 * @param newContent - New patch body
 * @param updates - Metadata fields to merge into the existing row
 * @param onCommitted - Optional hook that runs inside the same lock after
 *   the mutation succeeds. See {@link UpdatePatchCommittedHook}.
 */
export async function updatePatchAndMetadata(
  patchesDir: string,
  filename: string,
  newContent: string,
  updates: Partial<PatchMetadata>,
  onCommitted?: UpdatePatchCommittedHook
): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) {
      throw new Error('Cannot update patch metadata: patches.json is missing.');
    }

    const patchIndex = manifest.patches.findIndex((p) => p.filename === filename);
    if (patchIndex === -1) {
      throw new Error(`Cannot update patch metadata: ${filename} not found in patches.json.`);
    }

    const patchPath = join(patchesDir, filename);
    if (!(await pathExists(patchPath))) {
      throw new Error(`Cannot update patch: patch file is missing on disk: ${filename}`);
    }

    const originalContent = await readText(patchPath);
    const existingPatch = manifest.patches[patchIndex] as PatchMetadata;
    manifest.patches[patchIndex] = { ...existingPatch, ...updates };

    let patchWritten = false;
    try {
      await writeText(patchPath, newContent);
      patchWritten = true;
      await savePatchesManifest(patchesDir, manifest);
    } catch (error: unknown) {
      if (patchWritten) {
        try {
          await writeText(patchPath, originalContent);
        } catch (rollbackError: unknown) {
          warn(
            `Rollback warning: could not restore ${filename} after metadata write failed: ${toError(rollbackError).message}`
          );
        }
      }
      throw error;
    }

    if (onCommitted) {
      try {
        await onCommitted();
      } catch (hookError: unknown) {
        warn(
          `History log append failed after updatePatchAndMetadata committed (${filename}): ` +
            toError(hookError).message
        );
      }
    }
  });
}

/**
 * Optional `PatchMetadata` keys safe to clear via the helpers below.
 * Required keys (filename, order, etc.) are excluded by construction so
 * an over-eager `unsetFields: ['filename']` cannot delete a field the
 * manifest validator requires. Add new keys here only when they become
 * optional on the type.
 */
export type ClearablePatchMetadataField = 'tier' | 'lintIgnore';

/**
 * Merges `updates` onto `existing` and removes the listed `unset`
 * fields. The unset path is an explicit switch over the
 * {@link ClearablePatchMetadataField} union rather than a dynamic
 * `delete obj[k]` so the typecheck-time guarantee that only optional
 * fields can be cleared survives the runtime erasure — and so the lint
 * rule against dynamic deletes does not have to be silenced. Adding a
 * new clearable field requires extending both the union and this
 * switch in lockstep, which is exactly the constraint we want.
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
 * Required-field updates go through the `updates` partial. Clearing an
 * optional field (e.g. removing the `tier` override) goes through
 * `unsetFields` because TypeScript's `exactOptionalPropertyTypes` does
 * not let `Partial<PatchMetadata>` carry an explicit `undefined` value
 * for fields whose declared type does not include `undefined`. The
 * implementation deletes the listed keys from the merged record before
 * writing, so the on-disk JSON omits them and the validator's
 * "preserve only when present" contract is preserved.
 *
 * @param patchesDir - Path to the patches directory
 * @param filename - Patch filename
 * @param updates - Field values to set. Pass an empty object when only
 *   clearing fields.
 * @param unsetFields - Optional fields to remove from the entry (so
 *   serialization drops them).
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

/**
 * Return shape from a {@link mutatePatchMetadata} mutator.
 */
export interface PatchMetadataMutation {
  /** Field values to set on the entry. */
  set?: Partial<PatchMetadata>;
  /** Optional fields to remove from the entry entirely. */
  unset?: ReadonlyArray<ClearablePatchMetadataField>;
}

/**
 * Result of a successful {@link mutatePatchMetadata} call.
 */
export interface PatchMetadataMutationResult {
  /** Pre-mutation snapshot of the patch's metadata. */
  before: PatchMetadata;
  /** Post-mutation state of the patch's metadata. */
  after: PatchMetadata;
}

/**
 * Reads a patch's metadata under the directory lock, applies a mutator
 * function to compute the update, and writes the result back — all
 * under a single lock so a concurrent writer cannot interleave a
 * read-modify-write cycle. Useful for operations that need to compute
 * the new value from the old (e.g. unioning a `lintIgnore` list,
 * removing a specific entry), which {@link updatePatchMetadata}'s flat
 * merge cannot express on its own.
 *
 * The mutator returns `{ set, unset }` so it can both write fields
 * and drop optional ones. `set` and `unset` are merged before write:
 * `set` runs first via spread, then `unset` deletes the listed keys.
 *
 * @returns The pre/post metadata pair when the patch is found and the
 *   write succeeds; `null` when the manifest is missing or the named
 *   patch is not in it. Callers should treat `null` as "no-op, nothing
 *   to log".
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
 * Report whether a patch is fully covered by a new export, and which of its
 * files caused the coverage.
 *
 * Widened from a bare boolean to `{covered, byFiles}` so that `export
 * --supersede --dry-run` can tell the operator which files in each existing
 * patch triggered its supersession — the opaque "this export would
 * supersede N patches" message was the primary reason `--supersede` was
 * unsafe before this change.
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
    // Skip the new patch itself
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
 * Returned from {@link planExport} so dry-run previews can render a
 * complete "moved / removed" picture rather than a bare patch count.
 */
export interface SupersedeCoverageDetail {
  /** Existing patch filename. */
  filename: string;
  /** Files the existing patch claimed that the new export also claims. */
  coveredByFiles: string[];
}

/**
 * Resolves coverage details for every existing patch that the new export
 * would fully cover. Mirrors {@link findAllPatchesForFiles} but returns the
 * widened {@link PatchCoverage.byFiles} list per match so callers can render
 * a per-patch breakdown.
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

/**
 * Fully computed plan for a pending export. Returned from
 * {@link planExport} so that `--dry-run` previews can render the full
 * outcome of the hypothetical write without touching disk.
 *
 * Dry-run and the real write both go through {@link computeExportPlanUnderLock}
 * so their filename allocation, supersede detection, and projected
 * post-write manifest cannot drift. `planExport` exposes the rich coverage
 * form for preview rendering; {@link commitExportedPatch} consumes the bare
 * `PatchInfo[]` form of the same underlying data.
 */
export interface ExportPlan {
  /** Allocated patch filename (e.g. `005-ui-sidebar.patch`). */
  patchFilename: string;
  /** Full metadata row that would be written to the manifest. */
  metadata: PatchMetadata;
  /** Existing patches that would be superseded by this export. */
  superseded: SupersedeCoverageDetail[];
  /** Manifest state as it existed when the plan was computed. */
  manifestBefore: PatchesManifest | null;
  /**
   * Manifest state the plan would write. Always includes the new patch
   * metadata and excludes any superseded filenames.
   */
  manifestAfter: PatchesManifest;
}

export interface PlanExportInput {
  patchesDir: string;
  category: PatchCategory;
  name: string;
  description: string;
  filesAffected: string[];
  sourceEsrVersion: string;
  /**
   * Optional `PatchMetadata.tier` opt-in carried from the CLI flag.
   * Only `"branding"` is currently recognised. When provided the field
   * is written into the new patch's metadata; when absent the field
   * stays unset and tier resolution falls back to auto-detection.
   */
  tier?: 'branding';
  /**
   * Optional `PatchMetadata.lintIgnore` carried from the CLI flag.
   * Empty arrays are treated as "field absent" — the validator only
   * preserves the field when it has at least one entry.
   */
  lintIgnore?: string[];
}

/**
 * Internal shape shared by {@link planExport} (dry-run) and
 * {@link commitExportedPatch} (real write). Carries both the rich coverage
 * form (for dry-run rendering) and the bare `PatchInfo[]` form (for the
 * writer to delete superseded files), so neither caller has to recompute
 * the supersede set from the other.
 */
interface ComputedExportPlan {
  patchFilename: string;
  patchPath: string;
  metadata: PatchMetadata;
  supersededDetails: SupersedeCoverageDetail[];
  supersededPatches: PatchInfo[];
  manifestBefore: PatchesManifest | null;
  manifestAfter: PatchesManifest;
}

/**
 * Internal planning helper. Does NOT take the patch directory lock — the
 * caller must already hold it — because the two public entry points
 * ({@link planExport} and {@link commitExportedPatch}) each take their own
 * lock for the full operation. Sharing this single pure computation is how
 * dry-run previews and real writes stay in lockstep by construction
 * instead of by parallel implementations that can drift.
 */
async function computeExportPlanUnderLock(input: PlanExportInput): Promise<ComputedExportPlan> {
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
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.lintIgnore !== undefined && input.lintIgnore.length > 0
      ? { lintIgnore: input.lintIgnore }
      : {}),
  };

  const supersedeMatches = await findAllPatchesForFilesWithDetails(
    input.patchesDir,
    input.filesAffected,
    patchFilename
  );
  const supersededDetails: SupersedeCoverageDetail[] = supersedeMatches.map((m) => ({
    filename: m.patch.filename,
    coveredByFiles: m.coverage.byFiles,
  }));
  const supersededPatches: PatchInfo[] = supersedeMatches.map((m) => m.patch);

  const manifestBefore = await loadPatchesManifest(input.patchesDir);
  const supersededSet = new Set(supersededDetails.map((s) => s.filename));
  const afterPatches = (manifestBefore?.patches ?? []).filter(
    (p) => !supersededSet.has(p.filename) && p.filename !== patchFilename
  );
  afterPatches.push(metadata);
  afterPatches.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));

  return {
    patchFilename,
    patchPath,
    metadata,
    supersededDetails,
    supersededPatches,
    manifestBefore: manifestBefore ?? null,
    manifestAfter: {
      version: 1,
      patches: afterPatches,
    },
  };
}

/**
 * Read-only planning function — computes everything a real export would
 * do without writing anything to disk. Takes the patch directory lock
 * briefly, runs {@link computeExportPlanUnderLock}, releases the lock,
 * and returns the plan for preview rendering.
 *
 * Shares {@link computeExportPlanUnderLock} with {@link commitExportedPatch}
 * so the dry-run preview cannot drift from the real write. The real write
 * path does NOT reuse a prior plan object (another export may have landed
 * between dry-run and commit, which would stale the filename allocation);
 * it re-runs the same helper under a fresh lock. The guarantee is "same
 * code, possibly different data," not "same plan object."
 */
export async function planExport(input: PlanExportInput): Promise<ExportPlan> {
  return withPatchDirectoryLock(input.patchesDir, async () => {
    const plan = await computeExportPlanUnderLock(input);
    return {
      patchFilename: plan.patchFilename,
      metadata: plan.metadata,
      superseded: plan.supersededDetails,
      manifestBefore: plan.manifestBefore,
      manifestAfter: plan.manifestAfter,
    };
  });
}
