// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths } from '../core/config.js';
import { appendHistory, confirmDestructive, type ConflictReport } from '../core/destructive.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { computeProjectedLintRegressions } from '../core/lint-projection.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { updatePatchAndMetadata } from '../core/patch-export.js';
import {
  buildModifiedFileAdditionsFromDiff,
  buildPatchQueueContext,
  detectNewFilesInDiff,
  lintPatchQueue,
  type PatchQueueEntry,
} from '../core/patch-lint.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { buildProjectedManifest, enforcePatchPolicy } from '../core/patch-policy.js';
import { extractNewFileContentFromDiff } from '../core/patch-transform.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { info, outro, success, warn } from '../utils/logger.js';
import { runPatchLint } from './export-shared.js';

/**
 * Computes the effective `tier` and `lintIgnore` carrying both the
 * patch's existing values and the CLI flag overrides. Pure helper —
 * extracted from {@link reExportFilesInPlace} both to share with the
 * standard re-export path conceptually and to keep the orchestrator
 * function under the per-file LOC budget.
 *
 * Tier resolution: the CLI flag takes precedence; the patch's existing
 * tier is the fallback. Lint-ignore resolution: union of the patch's
 * existing list and the CLI flag values, de-duplicated; an empty
 * result returns `undefined` so the caller can drop the field rather
 * than write an empty array.
 */
function resolveEffectiveTierAndLintIgnore(
  target: PatchMetadata,
  options: ReExportOptions
): {
  effectiveTier: 'branding' | undefined;
  effectiveLintIgnore: string[] | undefined;
  flagIgnoreSet: Set<string>;
} {
  const existingIgnoreSet = new Set<string>(target.lintIgnore ?? []);
  const flagIgnoreSet = new Set<string>(options.lintIgnore ?? []);
  const mergedIgnoreSet = new Set<string>([...existingIgnoreSet, ...flagIgnoreSet]);
  const effectiveLintIgnore = mergedIgnoreSet.size > 0 ? [...mergedIgnoreSet] : undefined;
  const effectiveTier = options.tier ?? target.tier;
  return { effectiveTier, effectiveLintIgnore, flagIgnoreSet };
}

/**
 * Projects the cross-patch context (replace the target entry with its
 * shrunken self), runs the patch-queue lint against the projection,
 * and returns a conflict report only for regressions introduced *by*
 * this shrink. Pre-existing cross-patch errors are surfaced as a
 * non-blocking warning so the user does not walk away thinking the
 * queue is clean. Extracted from {@link reExportFilesInPlace} to keep
 * the orchestrator function under the per-file LOC budget.
 */
async function runProjectedCrossPatchLint(
  patchesDir: string,
  targetFilename: string,
  projectedDiff: string
): Promise<ConflictReport | null> {
  const baseCtx = await buildPatchQueueContext(patchesDir);
  const projectedNewFiles = new Map<string, string>();
  for (const path of detectNewFilesInDiff(projectedDiff)) {
    projectedNewFiles.set(path, extractNewFileContentFromDiff(projectedDiff, path));
  }
  const projectedModifiedFileAdditions = buildModifiedFileAdditionsFromDiff(projectedDiff);
  const projectedEntries: PatchQueueEntry[] = baseCtx.entries.map((entry) => {
    if (entry.filename !== targetFilename) return entry;
    return {
      ...entry,
      diff: projectedDiff,
      newFiles: projectedNewFiles,
      modifiedFileAdditions: projectedModifiedFileAdditions,
    };
  });

  const baselineIssues = lintPatchQueue(baseCtx).filter((i) => i.severity === 'error');
  const projectedIssues = lintPatchQueue({ entries: projectedEntries }).filter(
    (i) => i.severity === 'error'
  );
  const regressions = computeProjectedLintRegressions(baselineIssues, projectedIssues);

  if (baselineIssues.length > 0 && regressions.length === 0) {
    warn(
      `Note: projected queue still has ${baselineIssues.length} pre-existing ` +
        `cross-patch error(s) unrelated to this shrink. Run "fireforge verify" to list them.`
    );
  }

  if (regressions.length === 0) return null;
  return {
    reason: `projected --files state introduces ${regressions.length} new cross-patch lint error(s)`,
    details: regressions.map((i) => `[${i.check}] ${i.file}: ${i.message}`),
  };
}

/**
 * Builds the `Partial<PatchMetadata>` payload for the `--files` write,
 * folding in the CLI flag overrides for `tier` and `lintIgnore` only
 * when the operator actually asked for them. Extracted to keep
 * {@link reExportFilesInPlace} under the per-file LOC budget.
 */
function buildFilesModeMetadataUpdates(
  actualProjectedFiles: string[],
  options: ReExportOptions,
  effectiveLintIgnore: string[] | undefined,
  flagIgnoreSet: Set<string>
): Partial<PatchMetadata> {
  const updates: Partial<PatchMetadata> = {
    filesAffected: actualProjectedFiles,
  };
  if (options.tier !== undefined) {
    updates.tier = options.tier;
  }
  if (effectiveLintIgnore !== undefined && flagIgnoreSet.size > 0) {
    updates.lintIgnore = effectiveLintIgnore;
  }
  return updates;
}

async function confirmFilesModeProjection(args: {
  target: PatchMetadata;
  retained: string[];
  removed: string[];
  added: string[];
  actualProjectedFiles: string[];
  missingFiles: string[];
  options: ReExportOptions;
  conflicts: ConflictReport | null;
}): Promise<'proceed' | 'dry-run' | 'cancelled'> {
  const {
    target,
    retained,
    removed,
    added,
    actualProjectedFiles,
    missingFiles,
    options,
    conflicts,
  } = args;
  const isDryRun = options.dryRun === true;
  const summary: string[] = [
    `re-export ${target.filename} with --files scope`,
    `current files (${target.filesAffected.length}): ${target.filesAffected.join(', ') || '(none)'}`,
    `retained files (${retained.length}): ${retained.join(', ') || '(none)'}`,
    `projected files (${actualProjectedFiles.length}): ${actualProjectedFiles.join(', ') || '(none)'}`,
  ];
  if (removed.length > 0) {
    summary.push(`removed files (${removed.length}; become unmanaged): ${removed.join(', ')}`);
  }
  if (added.length > 0) {
    summary.push(`newly included files (${added.length}): ${added.join(', ')}`);
  }
  if (missingFiles.length > 0) {
    summary.push(`missing on disk (will be dropped): ${missingFiles.join(', ')}`);
  }

  if (!isDryRun && removed.length > 0 && options.allowShrink !== true) {
    warn(`Refusing to shrink ${target.filename} without --allow-shrink.`);
    for (const line of summary) {
      info(`  ${line}`);
    }
    throw new InvalidArgumentError(
      `Refusing to re-export ${target.filename} with --files because it would remove ${removed.length} existing patch-owned file${removed.length === 1 ? '' : 's'}. Run again with --allow-shrink after reviewing the dry-run output.`,
      '--allow-shrink'
    );
  }

  return confirmDestructive({
    operation: 're-export-files',
    title: `Re-export ${target.filename} with --files`,
    summary,
    yes: removed.length === 0 && missingFiles.length === 0 ? true : options.yes === true,
    dryRun: isDryRun,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });
}

/**
 * Handles `re-export --files` end-to-end: computes the projected diff,
 * runs the per-patch and cross-patch lint against a context in which the
 * target patch has been replaced with the projected state, gates on
 * confirmDestructive, and writes atomically.
 *
 * Lives outside reExportSinglePatch because the --files path has strictly
 * different semantics (authoritative file list, destructive shrink
 * confirmation, cross-patch projection lint) and shoehorning it through
 * the generic single-patch helper is what led to the earlier bug where
 * the projection lint ran against the current (unchanged) queue instead
 * of the projected state.
 */
export async function reExportFilesInPlace(
  paths: ReturnType<typeof getProjectPaths>,
  selectedPatches: PatchMetadata[],
  options: ReExportOptions,
  config: FireForgeConfig
): Promise<void> {
  const target = selectedPatches[0];
  if (!target) {
    throw new InvalidArgumentError('--files requires a target patch.', '--files');
  }
  const filesOption = options.files;
  if (filesOption === undefined) {
    throw new InvalidArgumentError('reExportFilesInPlace called with no --files.', '--files');
  }

  const requested = [...new Set(filesOption)].sort();
  const removed = target.filesAffected.filter((f) => !requested.includes(f));
  const added = requested.filter((f) => !target.filesAffected.includes(f));
  const retained = target.filesAffected.filter((f) => requested.includes(f));

  // Filter out paths that no longer exist on disk; we cannot include
  // them in the new diff because getDiffForFilesAgainstHead would fail.
  // Missing files are still dropped from the manifest so the resulting
  // filesAffected reflects reality.
  const missingFiles: string[] = [];
  for (const file of requested) {
    const filePath = join(paths.engine, file);
    if (!(await pathExists(filePath))) {
      missingFiles.push(file);
    }
  }
  const missingSet = new Set(missingFiles);
  const diffableFiles = requested.filter((f) => !missingSet.has(f));
  for (const file of missingFiles) {
    warn(`${target.filename}: requested file is missing on disk and will be dropped: ${file}`);
  }

  // Compute the projected diff up front. This is the same diff the real
  // write would produce, so we get an exact preview through the lint
  // gate and avoid computing it twice.
  const projectedDiff =
    diffableFiles.length > 0 ? await getDiffForFilesAgainstHead(paths.engine, diffableFiles) : '';

  if (!projectedDiff.trim()) {
    throw new InvalidArgumentError(
      `Refusing to re-export ${target.filename} with --files because the projected scope ` +
        'produces an empty patch. FireForge does not write zero-hunk patch files; ' +
        `use "fireforge patch delete ${target.filename}" if this patch should be removed entirely.`,
      '--files'
    );
  }

  const actualProjectedFiles = extractAffectedFiles(projectedDiff);
  const actualProjectedSet = new Set(actualProjectedFiles);
  const noDiffFiles = diffableFiles.filter((file) => !actualProjectedSet.has(file));
  if (noDiffFiles.length > 0) {
    throw new InvalidArgumentError(
      `Refusing to re-export ${target.filename} with --files because ${noDiffFiles.length} requested path${noDiffFiles.length === 1 ? '' : 's'} produced no diff hunks (${noDiffFiles.join(', ')}). ` +
        'Keeping them in filesAffected would desync patches.json from the patch body. ' +
        'Remove those paths from --files or modify them before retrying.',
      '--files'
    );
  }

  // Run the per-patch lint against the projected diff. This mirrors what
  // runPatchLint does in the standard re-export path. The target patch's
  // `lintIgnore` threads through so a shrink of an advisory-noisy-but-
  // intentional patch (branding bundle, localised-resource pack) does not
  // have to choose between `--skip-lint` (blunt) and the full rebase path.
  // `target.tier` threads the explicit branding-threshold opt-in for
  // the branding patch that also touches a non-allowlisted sibling.
  // CLI flags `--tier` and `--lint-ignore` participate too, with
  // append/union semantics on the lint-ignore list (matching the
  // standard re-export path).
  const { effectiveTier, effectiveLintIgnore, flagIgnoreSet } = resolveEffectiveTierAndLintIgnore(
    target,
    options
  );
  const ignoreChecks = effectiveLintIgnore ? new Set<string>(effectiveLintIgnore) : undefined;

  const patchQueueCtx = (await pathExists(paths.patches))
    ? await buildPatchQueueContext(paths.patches)
    : undefined;
  await runPatchLint(
    paths.engine,
    actualProjectedFiles,
    projectedDiff,
    config,
    options.skipLint,
    patchQueueCtx,
    ignoreChecks,
    effectiveTier
  );

  const conflicts = await runProjectedCrossPatchLint(paths.patches, target.filename, projectedDiff);
  const filesUpdates = buildFilesModeMetadataUpdates(
    actualProjectedFiles,
    options,
    effectiveLintIgnore,
    flagIgnoreSet
  );
  const manifest = await loadPatchesManifest(paths.patches);
  if (manifest) {
    enforcePatchPolicy({
      config,
      manifest: buildProjectedManifest(
        manifest,
        manifest.patches.map((entry) =>
          entry.filename === target.filename ? { ...entry, ...filesUpdates } : entry
        )
      ),
      command: 're-export --files',
      forceUnsafe: options.forceUnsafe === true,
    });
  }

  const decision = await confirmFilesModeProjection({
    target,
    retained,
    removed,
    added,
    actualProjectedFiles,
    missingFiles,
    options,
    conflicts,
  });

  if (decision === 'cancelled') {
    outro('Re-export cancelled');
    return;
  }
  if (decision === 'dry-run') {
    info(`[dry-run] ${target.filename}: ${actualProjectedFiles.length} file(s) in projected scope`);
    outro('Dry run complete — no changes made');
    return;
  }

  // Execute the write. At this point the projected diff is guaranteed to
  // be non-empty and `actualProjectedFiles` is guaranteed to match the
  // paths the body really touches, so the manifest cannot drift from the
  // regenerated patch body. The history append runs inside the same patch
  // directory lock as the mutation (via the onCommitted hook) so two
  // concurrent re-exports cannot interleave records and a crash between
  // mutation and append cannot orphan the audit trail.
  await updatePatchAndMetadata(
    paths.patches,
    target.filename,
    projectedDiff,
    filesUpdates,
    async () => {
      await appendHistory(paths.patches, {
        operation: 're-export-files',
        args: {
          filename: target.filename,
          files: actualProjectedFiles,
          previousFiles: target.filesAffected,
          missingFilesDropped: missingFiles,
        },
        ...(options.yes === true ? { yes: true } : {}),
        ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
        result: 'ok',
      });
    },
    {
      config,
      command: 're-export --files',
      forceUnsafe: options.forceUnsafe === true,
    }
  );

  success(`Re-exported ${target.filename}`);
  outro('Re-export complete');
}
