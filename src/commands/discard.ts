// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { stdioIsInteractive } from '../core/destructive.js';
import {
  applyDiscardBaseline,
  describeConflictWarning,
  describeDiscardBaseline,
  describeDiscardOutcome,
  type DiscardBaselinePlan,
  planDiscardBaselines,
  planUpstreamDiscards,
  summarizeDiscardBaselines,
} from '../core/discard-baseline.js';
import { assertEngineGitReady } from '../core/engine-precondition.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import type { GitStatusEntry } from '../core/git-base.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { GitError } from '../errors/git.js';
import type { CommandContext } from '../types/cli.js';
import type { DiscardOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { info, intro, isCancel, outro, spinner, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Shared interactive confirmation for the single-file and directory paths.
 * Returns false when the operator cancelled (the caller printed the outro).
 */
async function confirmDiscard(
  message: string,
  hint: string,
  options: DiscardOptions
): Promise<boolean> {
  if (options.yes || options.dryRun) return true;
  const isInteractive = stdioIsInteractive();
  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Interactive confirmation not available. Use --yes flag to discard without confirmation.',
      hint
    );
  }
  const confirmed = await confirm({ message, initialValue: false });
  if (isCancel(confirmed) || !confirmed) {
    outro('Discard cancelled');
    return false;
  }
  return true;
}

/**
 * Plans the restore baseline for `entries`: the patch-applied baseline for
 * patch-claimed paths, or pristine HEAD when `--to-upstream`
 * explicitly requests the legacy semantics.
 */
async function planDiscards(
  patchesDir: string,
  engineDir: string,
  entries: ReadonlyArray<DiscardBaselinePlan['entry']>,
  options: DiscardOptions
): Promise<DiscardBaselinePlan[]> {
  if (options.toUpstream) return planUpstreamDiscards(entries);
  return planDiscardBaselines(patchesDir, engineDir, entries);
}

/** Dry-run label including the rename pair and the restore-baseline suffix. */
function dryRunLabel(plan: DiscardBaselinePlan): string {
  const { entry } = plan;
  const target =
    entry.originalPath && entry.originalPath !== entry.file
      ? `${entry.originalPath} -> ${entry.file}`
      : entry.file;
  return `${target} (${describeDiscardBaseline(plan)})`;
}

/**
 * Discards every status entry whose path lives under `dirPath`. Used by
 * `discardCommand` as a directory-recursion fallback when the operator
 * passed a directory path that contains modified or untracked entries
 * but is not itself a status entry.
 *
 * Mirrors the single-file path's confirmation, dry-run, and Furnace-aware
 * warning behaviour so the contract stays consistent. Each per-entry
 * discard runs sequentially under its own try/catch so a failure on one
 * file is reported but does not block the remaining files in the batch.
 */
async function discardDirectoryEntries(
  projectRoot: string,
  engineDir: string,
  patchesDir: string,
  dirPath: string,
  entries: ReadonlyArray<GitStatusEntry>,
  options: DiscardOptions
): Promise<void> {
  const proceed = await confirmDiscard(
    `Discard changes to ${entries.length} file${entries.length === 1 ? '' : 's'} under ${dirPath}/?`,
    'Use: fireforge discard <directory> --yes',
    options
  );
  if (!proceed) return;

  const plans = await planDiscards(patchesDir, engineDir, entries, options);

  if (options.dryRun) {
    info(`Would discard changes to ${entries.length} file(s) under ${dirPath}/:`);
    for (const plan of plans) {
      info(`  ${dryRunLabel(plan)}`);
    }
    outro('Dry run complete — no changes made');
    return;
  }

  const s = spinner(`Discarding ${entries.length} file(s) under ${dirPath}/...`);
  let succeeded = 0;
  const failures: string[] = [];
  const appliedPlans: DiscardBaselinePlan[] = [];
  try {
    for (const plan of plans) {
      try {
        await applyDiscardBaseline(engineDir, plan);
        appliedPlans.push(plan);
        succeeded += 1;
      } catch (error: unknown) {
        failures.push(`${plan.entry.file}: ${toError(error).message}`);
      }
    }
    s.stop(
      `Discarded ${succeeded} of ${entries.length} file(s) under ${dirPath}/${
        failures.length > 0 ? ` (${failures.length} failed)` : ''
      }`
    );
    for (const failure of failures) {
      warn(`  ${failure}`);
    }
    for (const plan of appliedPlans) {
      if (plan.conflicted) warn(describeConflictWarning(plan));
    }

    try {
      const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
      const dirIsFurnace = [...furnacePrefixes].some(
        (prefix) => `${dirPath}/`.startsWith(prefix) || prefix.startsWith(`${dirPath}/`)
      );
      if (dirIsFurnace) {
        warn(
          'These paths are managed by Furnace. Run "fireforge furnace apply" to redeploy components if needed.'
        );
      }
    } catch {
      // Furnace config may not exist, so skip silently.
    }

    if (failures.length > 0) {
      throw new GeneralError(
        `Failed to discard ${failures.length} file(s) under ${dirPath}/. See warnings above.`
      );
    }

    outro(summarizeDiscardBaselines(appliedPlans, succeeded));
  } catch (error: unknown) {
    if (!(error instanceof GeneralError)) {
      s.error('Discard failed');
    }
    throw error;
  }
}

/**
 * Runs the discard command to revert changes to a specific file.
 * @param projectRoot - Root directory of the project
 * @param file - File path to discard (relative to engine/)
 * @param options - Discard options
 */
export async function discardCommand(
  projectRoot: string,
  file: string,
  options: DiscardOptions = {}
): Promise<void> {
  intro('FireForge Discard');

  const paths = getProjectPaths(projectRoot);

  await assertEngineGitReady(paths.engine);

  // Check if the file has changes
  const statusEntries = await expandUntrackedDirectoryEntries(
    paths.engine,
    await getWorkingTreeStatus(paths.engine)
  );
  const statusEntry = statusEntries.find(
    (entry) => entry.file === file || entry.originalPath === file
  );

  // Directory recursion fallback: when the explicit path does not match a
  // single status entry but does correspond to one or more entries below it,
  // treat the input as a directory and discard everything inside. Otherwise
  // `discard <dir> --yes` fails with "no changes to discard" even though
  // `status --unmanaged` lists files under that directory, forcing the
  // operator to discard each file individually. Match against the
  // directory-with-trailing-slash form so a path like `foo/bar` does not
  // accidentally match `foo/bar2/file`.
  if (!statusEntry) {
    // Normalize the operator's input once: `discard foo/` (or `foo//`) must
    // not produce doubled slashes in the messages and prefix comparisons
    // below, which all append `/` themselves.
    const dirPath = file.replace(/\/+$/, '');
    const dirPrefix = `${dirPath}/`;
    const dirEntries = statusEntries.filter(
      (entry) => entry.file.startsWith(dirPrefix) || entry.originalPath?.startsWith(dirPrefix)
    );
    if (dirEntries.length > 0) {
      await discardDirectoryEntries(
        projectRoot,
        paths.engine,
        paths.patches,
        dirPath,
        dirEntries,
        options
      );
      return;
    }
    throw new GeneralError(`File "${file}" has no changes to discard.`);
  }

  const proceed = await confirmDiscard(
    `Discard all changes to ${statusEntry.file}?`,
    'Use: fireforge discard <file> --yes',
    options
  );
  if (!proceed) return;

  const [plan] = await planDiscards(paths.patches, paths.engine, [statusEntry], options);
  if (!plan) {
    throw new GeneralError(`File "${file}" has no changes to discard.`);
  }

  if (options.dryRun) {
    // Show the rename pair regardless of which side the operator passed.
    // Passing the new path of a rename used to hide that discarding also
    // resurrects the old path, exactly when the full picture matters most.
    info(`Would discard changes to: ${dryRunLabel(plan)}`);
    outro('Dry run complete — no changes made');
    return;
  }

  const s = spinner(`Discarding changes to ${file}...`);

  try {
    await applyDiscardBaseline(paths.engine, plan);
    s.stop(`Discarded changes to ${file}`);

    if (plan.conflicted) {
      warn(describeConflictWarning(plan));
    }

    // Warn when the discarded file is managed by Furnace so the user knows
    // to re-apply if they want the component's deployed state back.
    try {
      const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
      if ([...furnacePrefixes].some((prefix) => file.startsWith(prefix))) {
        warn('This file is managed by Furnace. Run "fireforge furnace apply" to restore it.');
      }
    } catch {
      // Furnace config may not exist, so skip silently.
    }

    outro(describeDiscardOutcome(plan, options.toUpstream === true));
  } catch (error: unknown) {
    s.error('Discard failed');
    if (error instanceof GitError || error instanceof GeneralError) {
      throw error;
    }
    throw new GitError(
      `Failed to discard ${file}`,
      plan.kind === 'unmanaged'
        ? statusEntry.isUntracked
          ? `rm ${statusEntry.file}`
          : `restore --source HEAD --staged --worktree -- ${statusEntry.file}`
        : `write patch baseline for ${statusEntry.file}`,
      // Always attach the cause via toError so thrown primitives (strings,
      // numbers) produced by poorly-behaved utilities still propagate as
      // an Error, preserving stack traces for verbose-mode triage.
      toError(error)
    );
  }
}

/** Registers the discard command on the CLI program. */
export function registerDiscard(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('discard <file>')
    .description(
      'Discard changes to a specific file, restoring patch-claimed paths to their patch-applied baseline (unmanaged untracked files are deleted). Pass a directory path to discard every modified or untracked file beneath it; the operation walks the status output and reverts each match individually.'
    )
    .option('--dry-run', 'Show what would be discarded without doing it')
    .option(
      '--to-upstream',
      'Restore to pristine upstream (HEAD) instead of the patch-applied baseline; deletes patch-created files'
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      withErrorHandling(
        async (
          file: string,
          options: { dryRun?: boolean; toUpstream?: boolean; yes?: boolean }
        ) => {
          await discardCommand(getProjectRoot(), file, pickDefined(options));
        }
      )
    );
}
