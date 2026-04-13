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
import { extractNewFileContentFromDiff } from '../core/patch-transform.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { info, outro, success, warn } from '../utils/logger.js';
import { runPatchLint } from './export-shared.js';

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
  const isDryRun = options.dryRun === true;
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
  // runPatchLint does in the standard re-export path.
  await runPatchLint(paths.engine, actualProjectedFiles, projectedDiff, config, options.skipLint);

  // Project the cross-patch context: replace the target entry with its
  // would-be shrunken self (new diff + new newFiles + new
  // modifiedFileAdditions). The projected entry must repopulate both
  // source-site maps so the forward-import rule sees imports the
  // shrunken diff would add — or stop adding — consistently with how a
  // real rebuild would see them.
  const baseCtx = await buildPatchQueueContext(paths.patches);
  const projectedNewFiles = new Map<string, string>();
  for (const path of detectNewFilesInDiff(projectedDiff)) {
    projectedNewFiles.set(path, extractNewFileContentFromDiff(projectedDiff, path));
  }
  const projectedModifiedFileAdditions = buildModifiedFileAdditionsFromDiff(projectedDiff);
  const projectedEntries: PatchQueueEntry[] = baseCtx.entries.map((entry) => {
    if (entry.filename !== target.filename) return entry;
    return {
      ...entry,
      diff: projectedDiff,
      newFiles: projectedNewFiles,
      modifiedFileAdditions: projectedModifiedFileAdditions,
    };
  });

  // Baseline-vs-projected diffing: only regressions introduced *by* this
  // shrink should block. A pre-existing cross-patch error elsewhere in
  // the queue must not prevent the user from shrinking an unrelated
  // patch (which is often exactly the tool they reach for to repair
  // such a queue).
  const baselineIssues = lintPatchQueue(baseCtx).filter((i) => i.severity === 'error');
  const projectedIssues = lintPatchQueue({ entries: projectedEntries }).filter(
    (i) => i.severity === 'error'
  );
  const regressions = computeProjectedLintRegressions(baselineIssues, projectedIssues);
  const conflicts: ConflictReport | null =
    regressions.length > 0
      ? {
          reason: `projected --files state introduces ${regressions.length} new cross-patch lint error(s)`,
          details: regressions.map((i) => `[${i.check}] ${i.file}: ${i.message}`),
        }
      : null;

  // Surface pre-existing errors as a non-blocking warning so the user
  // doesn't walk away thinking the queue is clean.
  if (baselineIssues.length > 0 && regressions.length === 0) {
    warn(
      `Note: projected queue still has ${baselineIssues.length} pre-existing ` +
        `cross-patch error(s) unrelated to this shrink. Run "fireforge verify" to list them.`
    );
  }

  // Shrinks are destructive (previously-owned files become unmanaged).
  // Additive-only changes still deserve a prompt because --files asserts
  // an authoritative file set.
  const summary: string[] = [
    `re-export ${target.filename} with --files scope`,
    `current files (${target.filesAffected.length}): ${target.filesAffected.join(', ') || '(none)'}`,
    `new files (${actualProjectedFiles.length}): ${actualProjectedFiles.join(', ') || '(none)'}`,
  ];
  if (removed.length > 0) {
    summary.push(`would drop (become unmanaged): ${removed.join(', ')}`);
  }
  if (added.length > 0) {
    summary.push(`would add: ${added.join(', ')}`);
  }
  if (missingFiles.length > 0) {
    summary.push(`missing on disk (will be dropped): ${missingFiles.join(', ')}`);
  }

  const decision = await confirmDestructive({
    operation: 're-export-files',
    title: `Re-export ${target.filename} with --files`,
    summary,
    yes: options.yes === true,
    dryRun: isDryRun,
    unsafeOverride: options.forceUnsafe === true,
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
    { filesAffected: actualProjectedFiles },
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
    }
  );

  success(`Re-exported ${target.filename}`);
  outro('Re-export complete');
}
