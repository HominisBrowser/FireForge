// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type {
  PatchCategory,
  PatchesManifest,
  PatchInfo,
  PatchMetadata,
} from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, removeFile, writeText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { PATCH_CATEGORIES } from '../utils/validation.js';
import { discoverPatches, withPatchDirectoryLock } from './patch-apply.js';
import { normalizePatchArtifact } from './patch-artifact-normalize.js';
import {
  findAllPatchesForFilesWithDetails,
  type SupersedeCoverageDetail,
} from './patch-export-coverage.js';
import {
  addPatchToManifest,
  loadPatchesManifestForWrite,
  PATCHES_MANIFEST,
  savePatchesManifest,
} from './patch-manifest.js';
import { allocatePolicyOrder, enforcePatchPolicy } from './patch-policy.js';

export {
  findAllPatchesForFiles,
  findAllPatchesForFilesWithDetails,
  findSupersededPatches,
  isPatchFullyCovered,
  type PatchCoverage,
  type SupersedeCoverageDetail,
} from './patch-export-coverage.js';
export {
  type ClearablePatchMetadataField,
  mutatePatchMetadata,
  type PatchMetadataMutation,
  type PatchMetadataMutationResult,
  updatePatchMetadata,
} from './patch-export-metadata.js';
export { updatePatchAndMetadata } from './patch-export-update.js';

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips a leading `NNN-<category>-` prefix from a sanitized name slug.
 * Operators frequently pass the DESIRED FILENAME stem to `--name`
 * (`--name 203-ui-foo --category ui`), which 0.33.0 double-prefixed into
 * `203-ui-203-ui-foo.patch`. The filename builders prepend the order and
 * category themselves, so a matching prefix in the name is always
 * redundant. Applied repeatedly so a twice-prefixed slug (from a previous
 * double-prefix incident) also collapses. Exported for direct testing.
 */
export function stripRedundantCategoryPrefix(sanitizedName: string, category: string): string {
  const prefixes = [
    new RegExp(`^\\d+-${escapeRegExp(category)}-`),
    new RegExp(`^${escapeRegExp(category)}-`),
  ];
  let stripped = sanitizedName;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (prefix.test(stripped)) {
        stripped = stripped.replace(prefix, '');
        changed = true;
      }
    }
  }
  return stripped.length > 0 ? stripped : sanitizedName;
}

/** Sanitizes a patch name and drops redundant category/full-stem prefixes. */
export function patchNameSlug(name: string, category: string): string {
  return stripRedundantCategoryPrefix(sanitizeName(name), category);
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
  const sanitizedName = patchNameSlug(name, category);

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
  sourceProduct?: FireForgeConfig['firefox']['product'];
  sourceVersion?: string;
  /** Optional `PatchMetadata.tier` opt-in (only `"branding"` recognised). */
  tier?: 'branding';
  /** Optional `PatchMetadata.lintIgnore` (empty array treated as absent). */
  lintIgnore?: string[];
  /** Project config, used only when opt-in patchPolicy is present. */
  config?: FireForgeConfig;
  /** Mutating command name for policy errors. */
  policyCommand?: string;
  /** Whether --force-unsafe was supplied by the mutating command. */
  forceUnsafe?: boolean;
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
      ...(input.sourceProduct !== undefined ? { sourceProduct: input.sourceProduct } : {}),
      ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.lintIgnore !== undefined ? { lintIgnore: input.lintIgnore } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
    });

    if (input.config !== undefined) {
      enforcePatchPolicy({
        config: input.config,
        manifest: plan.manifestAfter,
        command: input.policyCommand ?? 'export',
        forceUnsafe: input.forceUnsafe === true,
      });
    }

    const patchPath = plan.patchPath;
    const originalPatchContent = (await pathExists(patchPath)) ? await readText(patchPath) : null;
    const removedPatchContents = new Map<string, string>();

    for (const oldPatch of plan.supersededPatches) {
      if (await pathExists(oldPatch.path)) {
        removedPatchContents.set(oldPatch.path, await readText(oldPatch.path));
      }
    }

    try {
      await writeText(patchPath, normalizePatchArtifact(input.diff));

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
    if ((PATCH_CATEGORIES as readonly string[]).includes(category)) {
      return {
        order: parseInt(orderStr, 10),
        category,
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
  await writeText(patchPath, normalizePatchArtifact(newContent));
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
  sourceProduct?: FireForgeConfig['firefox']['product'];
  sourceVersion?: string;
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
  /** Project config, used only when opt-in patchPolicy is present. */
  config?: FireForgeConfig;
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
  // ForWrite: a corrupt manifest read as null here would produce a
  // manifestAfter containing ONLY the new patch — committing that plan
  // wipes the queue metadata, and the rollback path would then delete
  // patches.json entirely because manifestBefore looked absent.
  const manifestBefore = await loadPatchesManifestForWrite(input.patchesDir);
  const policyOrder =
    input.config !== undefined
      ? allocatePolicyOrder(input.config, manifestBefore?.patches ?? [], input.category)
      : null;
  const patchFilename =
    policyOrder !== null
      ? `${String(policyOrder).padStart(3, '0')}-${input.category}-${patchNameSlug(input.name, input.category)}.patch`
      : await getNextPatchFilename(input.patchesDir, input.category, input.name);
  const patchPath = join(input.patchesDir, patchFilename);

  const metadata: PatchMetadata = {
    filename: patchFilename,
    order: parseInt(patchFilename.split('-')[0] ?? '0', 10),
    category: input.category,
    name: input.name,
    description: input.description,
    createdAt: new Date().toISOString(),
    sourceEsrVersion: input.sourceEsrVersion,
    ...(input.sourceProduct !== undefined ? { sourceProduct: input.sourceProduct } : {}),
    sourceVersion: input.sourceVersion ?? input.sourceEsrVersion,
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
