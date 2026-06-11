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
import { computeProjectedLintRegressions } from '../../core/lint-projection.js';
import { extractAffectedFiles } from '../../core/patch-apply.js';
import {
  buildModifiedFileAdditionsFromDiff,
  buildPatchQueueContext,
  detectNewFilesInDiff,
  lintPatchQueue,
  type PatchQueueEntry,
} from '../../core/patch-lint.js';
import { rewriteStagedDependencyOwners } from '../../core/patch-manifest.js';
import { applyRenameMapToManifest, buildProjectedManifest } from '../../core/patch-policy.js';
import { buildPatchSourceMetadata } from '../../core/patch-source-metadata.js';
import { extractNewFileContentFromDiff } from '../../core/patch-transform.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
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
}

/**
 *
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
 *
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

/**
 * Projects the full split (renumber + shrunken source + synthetic new
 * patch + owner rewrites) through cross-patch lint, reporting only the
 * regressions the split itself would introduce.
 */
export async function runProjectedSplitLint(
  patchesDir: string,
  plan: SplitPlan
): Promise<ConflictReport | null> {
  const movedSet = new Set(plan.movedFiles);
  const ownerLookup = (old: string): string | undefined =>
    plan.placement.renameMap.get(old)?.newFilename;
  const baseCtx = await buildPatchQueueContext(patchesDir);

  const projectedEntries: PatchQueueEntry[] = baseCtx.entries.map((entry) => {
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

  projectedEntries.push({
    filename: plan.placement.newFilename,
    order: plan.placement.insertionOrder,
    metadata: null,
    ...buildEntryProjection(plan.movedDiff),
  });
  projectedEntries.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));

  const baselineIssues = lintPatchQueue(baseCtx).filter((i) => i.severity === 'error');
  const projectedIssues = lintPatchQueue({ entries: projectedEntries }).filter(
    (i) => i.severity === 'error'
  );
  const regressions = computeProjectedLintRegressions(baselineIssues, projectedIssues);
  if (baselineIssues.length > 0 && regressions.length === 0) {
    warn(
      `Note: projected queue still has ${baselineIssues.length} pre-existing cross-patch ` +
        'error(s) unrelated to this split. Run "fireforge verify" to list them.'
    );
  }
  if (regressions.length === 0) return null;
  return {
    reason: `split would introduce ${regressions.length} cross-patch lint error(s)`,
    details: regressions.map((i) => `[${i.check}] ${i.file}: ${i.message}`),
  };
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
 *
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
 *
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
