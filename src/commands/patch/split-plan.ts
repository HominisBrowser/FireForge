// SPDX-License-Identifier: EUPL-1.2
/**
 * Planning helpers for `fireforge patch split`: ownership guards, diff
 * construction from the worktree, staged-dependency owner-rewrite
 * discovery, cross-patch lint projection, and policy-manifest projection.
 * Split out of `split.ts` to keep both files within the per-file line
 * budget; consumed only by the split command.
 */

import { join } from 'node:path';

import { type ConflictReport } from '../../core/destructive.js';
import { getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import { extractAffectedFiles } from '../../core/patch-apply.js';
import {
  buildModifiedFileAdditionsFromDiff,
  buildPatchQueueContext,
  collectForwardImportEdges,
  detectNewFilesInDiff,
  formatPatchLintIssue,
  lintPatchQueue,
  type PatchQueueEntry,
} from '../../core/patch-lint.js';
import { computeProjectedLintRegressions } from '../../core/patch-lint-projection.js';
import { rewriteStagedDependencyOwners } from '../../core/patch-manifest.js';
import { applyRenameMapToManifest, buildProjectedManifest } from '../../core/patch-policy.js';
import { buildPatchSourceMetadata } from '../../core/patch-source-metadata.js';
import { extractNewFileContentFromDiff } from '../../core/patch-transform.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { PatchStagedForwardImport } from '../../types/commands/index.js';
import type { PatchCategory, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { pathExists } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { type PlacementPlan } from '../export-flow.js';

/** Everything the commit step needs, computed and confirmed up front. */
export interface SplitPlan {
  source: PatchMetadata;
  movedFiles: string[];
  remainingFiles: string[];
  movedDiff: string;
  remainingDiff: string;
  placement: PlacementPlan;
  /** Effective placement flags (with the after-source default applied). */
  placementOptions: { order?: number; before?: string; after?: string };
  category: PatchCategory;
  name: string;
  description: string;
  /** Patches (by current filename) whose staged-dependency owners re-point to the new patch. */
  ownerRewrites: string[];
  /**
   * Staged forward-import declarations the split introduces, keyed by the
   * importing patch's post-rename filename. These are the new forward edges
   * from existing patches into the freshly-created patch (owner known); they
   * are injected into the projected lint so dry-run matches the real gate,
   * and persisted on commit so the real per-patch gate stays clean.
   */
  stagedDependencyAdditions: Map<string, PatchStagedForwardImport[]>;
}

/**
 * Refuses the split unless the source patch currently owns every requested
 * file. Splitting out a file the source does not own would produce a new patch
 * whose diff cannot apply.
 */
export function assertSourceOwnsFiles(source: PatchMetadata, files: readonly string[]): void {
  const owned = new Set(source.filesAffected);
  const missing = files.filter((file) => !owned.has(file));
  if (missing.length > 0) {
    throw new InvalidArgumentError(
      `${source.filename} does not currently own ${missing.length} requested file(s): ${missing.join(', ')}. ` +
        'Run "fireforge status --ownership" to inspect current ownership.',
      '--files'
    );
  }
}

/**
 * Generates the diff for one side of a split by re-deriving it from the engine
 * working tree, scoped to `files`. Re-derived rather than sliced out of the
 * source patch so hunk context is correct for the new file set.
 */
export async function buildSplitDiff(
  engineDir: string,
  files: readonly string[],
  label: string,
  sourceFilename: string
): Promise<string> {
  for (const file of files) {
    if (!(await pathExists(join(engineDir, file)))) {
      throw new GeneralError(
        `Cannot split ${sourceFilename}: ${label} file is missing from the engine worktree: ${file}. ` +
          'Run "fireforge import" (or restore the file) so the worktree reflects the patch content first.'
      );
    }
  }
  const diff = await getDiffForFilesAgainstHead(engineDir, [...files]);
  if (!diff.trim()) {
    throw new GeneralError(
      `Cannot split ${sourceFilename}: the ${label} file set produces an empty diff against HEAD. ` +
        'The worktree must currently carry the patch content (run "fireforge import" first).'
    );
  }
  const actual = new Set(extractAffectedFiles(diff));
  const noHunks = files.filter((file) => !actual.has(file));
  if (noHunks.length > 0) {
    throw new GeneralError(
      `Cannot split ${sourceFilename}: ${noHunks.length} ${label} file(s) produced no diff hunks ` +
        `(${noHunks.join(', ')}). The worktree does not carry their patch content.`
    );
  }
  return diff;
}

/**
 * Finds patches declaring a staged-dependency forward-import whose `owner`
 * is the source patch and whose `creates` path moves to the new patch.
 */
export function findOwnerRewriteHolders(
  patches: readonly PatchMetadata[],
  sourceFilename: string,
  movedSet: ReadonlySet<string>
): string[] {
  return patches
    .filter((patch) =>
      (patch.stagedDependencies?.forwardImports ?? []).some(
        (fi) => fi.owner === sourceFilename && movedSet.has(fi.creates)
      )
    )
    .map((patch) => patch.filename);
}

/** Rewrites split-affected owners on one manifest row. */
export function rewriteSplitOwners(
  patch: PatchMetadata,
  sourceFilename: string,
  movedSet: ReadonlySet<string>,
  newFilename: string
): PatchMetadata {
  const forwardImports = patch.stagedDependencies?.forwardImports;
  if (!forwardImports?.some((fi) => fi.owner === sourceFilename && movedSet.has(fi.creates))) {
    return patch;
  }
  return {
    ...patch,
    stagedDependencies: {
      ...patch.stagedDependencies,
      forwardImports: forwardImports.map((fi) =>
        fi.owner === sourceFilename && movedSet.has(fi.creates) ? { ...fi, owner: newFilename } : fi
      ),
    },
  };
}

function buildEntryProjection(
  diff: string
): Pick<PatchQueueEntry, 'diff' | 'newFiles' | 'modifiedFileAdditions'> {
  const newFiles = new Map<string, string>();
  for (const path of detectNewFilesInDiff(diff)) {
    newFiles.set(path, extractNewFileContentFromDiff(diff, path));
  }
  return { diff, newFiles, modifiedFileAdditions: buildModifiedFileAdditionsFromDiff(diff) };
}

/** Builds the projected post-split queue entries (renumber + shrunken source + new patch). */
function buildProjectedSplitEntries(
  baseCtx: Awaited<ReturnType<typeof buildPatchQueueContext>>,
  plan: SplitPlan
): PatchQueueEntry[] {
  const movedSet = new Set(plan.movedFiles);
  const ownerLookup = (old: string): string | undefined =>
    plan.placement.renameMap.get(old)?.newFilename;

  const entries: PatchQueueEntry[] = baseCtx.entries.map((entry) => {
    let metadata = entry.metadata;
    if (metadata) {
      metadata = rewriteStagedDependencyOwners(metadata, ownerLookup);
      metadata = rewriteSplitOwners(
        metadata,
        plan.source.filename,
        movedSet,
        plan.placement.newFilename
      );
    }
    const rename = plan.placement.renameMap.get(entry.filename);
    const base = rename
      ? { ...entry, metadata, filename: rename.newFilename, order: rename.newOrder }
      : { ...entry, metadata };
    if (entry.filename !== plan.source.filename) return base;
    return { ...base, ...buildEntryProjection(plan.remainingDiff) };
  });

  entries.push({
    filename: plan.placement.newFilename,
    order: plan.placement.insertionOrder,
    metadata: null,
    ...buildEntryProjection(plan.movedDiff),
  });
  entries.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  return entries;
}

/**
 * Computes the staged forward-import declarations the split introduces:
 * forward edges from existing patches into the freshly-created patch (its
 * `creates` files are the moved files; the owner is the new patch, so it is
 * known). Keyed by the importing patch's projected (post-rename) filename.
 *
 * These edges did not exist before the split (importer and imported file
 * lived in the same patch), so they have no declaration yet — without this
 * the projected lint flags them while the real per-patch gate would resolve
 * them once declared. Auto-declaring keeps the two in lock-step and lets a
 * sound split read as sound.
 */
function computeSplitStagedDependencyAdditions(
  projectedEntries: PatchQueueEntry[],
  newFilename: string
): Map<string, PatchStagedForwardImport[]> {
  const additions = new Map<string, PatchStagedForwardImport[]>();
  for (const edge of collectForwardImportEdges({ entries: projectedEntries })) {
    if (edge.owner !== newFilename) continue;
    const decl: PatchStagedForwardImport = {
      file: edge.sitePath,
      specifier: edge.specifier,
      creates: edge.creates,
      owner: newFilename,
    };
    const list = additions.get(edge.entry) ?? [];
    const dup = list.some(
      (d) =>
        d.file === decl.file &&
        d.specifier === decl.specifier &&
        d.creates === decl.creates &&
        d.owner === decl.owner
    );
    if (!dup) list.push(decl);
    additions.set(edge.entry, list);
  }
  return additions;
}

/** Merges `decls` into a patch's `stagedDependencies.forwardImports` (no duplicates). */
export function mergeStagedForwardImports(
  patch: PatchMetadata,
  decls: readonly PatchStagedForwardImport[]
): PatchMetadata {
  if (decls.length === 0) return patch;
  const existing = patch.stagedDependencies?.forwardImports ?? [];
  const merged = [...existing];
  for (const decl of decls) {
    const dup = merged.some(
      (d) =>
        d.file === decl.file &&
        d.specifier === decl.specifier &&
        d.creates === decl.creates &&
        (d.owner ?? '') === (decl.owner ?? '')
    );
    if (!dup) merged.push(decl);
  }
  return {
    ...patch,
    stagedDependencies: { ...patch.stagedDependencies, forwardImports: merged },
  };
}

/** Injects the computed staged-dependency additions into projected entries' metadata. */
function injectStagedDependencyAdditions(
  entries: PatchQueueEntry[],
  additions: Map<string, PatchStagedForwardImport[]>
): void {
  for (const entry of entries) {
    const decls = additions.get(entry.filename);
    if (!decls?.length || !entry.metadata) continue;
    entry.metadata = mergeStagedForwardImports(entry.metadata, decls);
  }
}

/**
 * Projects the full split (renumber + shrunken source + synthetic new
 * patch + owner rewrites) through cross-patch lint, reporting only the
 * regressions the split itself would introduce. Forward edges into the new
 * patch are auto-declared (and the declarations returned) so the projection
 * matches the real per-patch gate the split leaves behind.
 */
export function runProjectedSplitLint(
  plan: SplitPlan,
  baseCtx: Awaited<ReturnType<typeof buildPatchQueueContext>>
): {
  conflicts: ConflictReport | null;
  stagedDependencyAdditions: Map<string, PatchStagedForwardImport[]>;
} {
  const projectedEntries = buildProjectedSplitEntries(baseCtx, plan);

  // Discover and auto-declare the forward edges this split introduces into
  // the new patch, then inject them before linting so they resolve.
  const stagedDependencyAdditions = computeSplitStagedDependencyAdditions(
    projectedEntries,
    plan.placement.newFilename
  );
  injectStagedDependencyAdditions(projectedEntries, stagedDependencyAdditions);

  const baselineIssues = lintPatchQueue(baseCtx).filter((i) => i.severity === 'error');
  const projectedIssues = lintPatchQueue({
    entries: projectedEntries,
    // Keep the projection patch-policy-aware whenever the baseline is, so
    // computeProjectedLintRegressions compares symmetric rule sets.
    ...(baseCtx.patchPolicy ? { patchPolicy: baseCtx.patchPolicy } : {}),
  }).filter((i) => i.severity === 'error');
  const regressions = computeProjectedLintRegressions(baselineIssues, projectedIssues);
  if (baselineIssues.length > 0 && regressions.length === 0) {
    warn(
      `Note: projected queue still has ${baselineIssues.length} pre-existing cross-patch ` +
        'error(s) unrelated to this split. Run "fireforge verify" to list them.'
    );
  }
  const conflicts =
    regressions.length === 0
      ? null
      : {
          reason: `split would introduce ${regressions.length} cross-patch lint error(s)`,
          details: regressions.map(formatPatchLintIssue),
        };
  return { conflicts, stagedDependencyAdditions };
}

/** Builds the projected manifest for policy enforcement. */
export function projectSplitManifest(
  manifest: { version: 1; patches: PatchMetadata[] },
  plan: SplitPlan,
  newMetadata: PatchMetadata
): ReturnType<typeof buildProjectedManifest> {
  const movedSet = new Set(plan.movedFiles);
  const renamed = applyRenameMapToManifest(manifest, plan.placement.renameMap);
  const effectiveSourceFilename =
    plan.placement.renameMap.get(plan.source.filename)?.newFilename ?? plan.source.filename;
  const patched = renamed.patches.map((patch) => {
    const withOwners = rewriteSplitOwners(
      patch,
      effectiveSourceFilename,
      movedSet,
      plan.placement.newFilename
    );
    if (patch.filename !== effectiveSourceFilename) return withOwners;
    return { ...withOwners, filesAffected: plan.remainingFiles };
  });
  return buildProjectedManifest(renamed, [...patched, newMetadata]);
}

/**
 * Builds the manifest row for the patch created by a split, carrying the
 * source's provenance (product, version, category) onto the new patch.
 */
export function buildNewPatchMetadata(plan: SplitPlan, config: FireForgeConfig): PatchMetadata {
  return {
    filename: plan.placement.newFilename,
    order: plan.placement.insertionOrder,
    category: plan.category,
    name: plan.name,
    description: plan.description,
    createdAt: new Date().toISOString(),
    ...buildPatchSourceMetadata(config.firefox),
    filesAffected: plan.movedFiles,
  };
}

/**
 * Renders the operator-facing summary lines for a planned split — the text
 * shown by `--dry-run` and by the destructive-operation confirmation prompt.
 */
export function buildSplitSummary(plan: SplitPlan): string[] {
  const summary = [
    `split ${plan.source.filename}`,
    `moved files (${plan.movedFiles.length}): ${plan.movedFiles.join(', ')}`,
    `source keeps (${plan.remainingFiles.length}): ${plan.remainingFiles.join(', ')}`,
    `new patch: ${plan.placement.newFilename} (order ${plan.placement.insertionOrder})`,
  ];
  if (plan.placement.renameMap.size > 0) {
    summary.push(`${plan.placement.renameMap.size} existing patch(es) renumbered to make room:`);
    for (const [oldName, entry] of [...plan.placement.renameMap.entries()].sort(
      (a, b) => a[1].newOrder - b[1].newOrder
    )) {
      summary.push(`  ${oldName}  →  ${entry.newFilename}`);
    }
  }
  if (plan.ownerRewrites.length > 0) {
    summary.push(
      `staged-dependency owners re-pointed to the new patch in: ${plan.ownerRewrites.join(', ')}`
    );
  }
  return summary;
}
