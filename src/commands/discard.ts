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
import { takeRecoverySnapshot } from '../core/recovery-snapshot.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { GitError } from '../errors/git.js';
import type { CommandContext } from '../types/cli.js';
import type { DiscardOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { info, intro, isCancel, outro, spinner, warn } from '../utils/logger.js';
import { addWaitLockOption, pickDefined } from '../utils/options.js';
import { runUnderEngineLock } from './with-engine-lock.js';

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
 * explicitly requests it.
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

/** How a batch of status entries was selected, for messages and the Furnace check. */
interface DiscardScope {
  /** Phrase completing "N file(s) ...", e.g. `under src/` or `across 3 paths`. */
  phrase: string;
  /** Engine-relative roots (`dir/` or file paths) the Furnace-prefix check compares. */
  roots: readonly string[];
  /** Usage hint when the run would prompt without a TTY. */
  hint: string;
}

/**
 * Discards a batch of status entries selected by one or more directory or
 * file arguments, from one status scan and one baseline plan.
 *
 * Mirrors the single-file path's confirmation, dry-run, and Furnace-aware
 * warning behaviour so the contract stays consistent. Each per-entry
 * discard runs sequentially under its own try/catch so a failure on one
 * file is reported but does not block the remaining files in the batch.
 */
async function discardEntries(
  projectRoot: string,
  engineDir: string,
  patchesDir: string,
  scope: DiscardScope,
  entries: ReadonlyArray<GitStatusEntry>,
  options: DiscardOptions
): Promise<void> {
  const proceed = await confirmDiscard(
    `Discard changes to ${entries.length} file${entries.length === 1 ? '' : 's'} ${scope.phrase}?`,
    scope.hint,
    options
  );
  if (!proceed) return;

  const plans = await planDiscards(patchesDir, engineDir, entries, options);

  if (options.dryRun) {
    info(`Would discard changes to ${entries.length} file(s) ${scope.phrase}:`);
    for (const plan of plans) {
      info(`  ${dryRunLabel(plan)}`);
    }
    outro('Dry run complete — no changes made');
    return;
  }

  await takeRecoverySnapshot(engineDir, 'discard', entryPaths(entries));

  const s = spinner(`Discarding ${entries.length} file(s) ${scope.phrase}...`);
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
      `Discarded ${succeeded} of ${entries.length} file(s) ${scope.phrase}${
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
      const touchesFurnace = [...furnacePrefixes].some((prefix) =>
        scope.roots.some((root) => root.startsWith(prefix) || prefix.startsWith(root))
      );
      if (touchesFurnace) {
        warn(
          'These paths are managed by Furnace. Run "fireforge furnace apply" to redeploy components if needed.'
        );
      }
    } catch {
      // Furnace config may not exist, so skip silently.
    }

    if (failures.length > 0) {
      throw new GeneralError(
        `Failed to discard ${failures.length} file(s) ${scope.phrase}. See warnings above.`
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

/** Every engine path a set of status entries touches, rename sources included. */
function entryPaths(entries: ReadonlyArray<GitStatusEntry>): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) => [entry.file, ...(entry.originalPath ? [entry.originalPath] : [])])
    ),
  ];
}

/**
 * Resolves each argument against the one status scan: an exact status entry
 * (either side of a rename), else every entry beneath it as a directory. The
 * `matched` entries are unique, in first-seen order; `unmatched` lists the
 * arguments that selected nothing.
 */
function selectEntries(
  statusEntries: ReadonlyArray<GitStatusEntry>,
  requested: readonly string[]
): { matched: GitStatusEntry[]; unmatched: string[] } {
  const matched = new Map<string, GitStatusEntry>();
  const unmatched: string[] = [];
  for (const arg of requested) {
    const exact = statusEntries.find((entry) => entry.file === arg || entry.originalPath === arg);
    // Normalize once: `discard foo/` (or `foo//`) must not produce doubled
    // slashes. The trailing-slash prefix keeps `foo/bar` from matching `foo/bar2/file`.
    const dirPrefix = `${arg.replace(/\/+$/, '')}/`;
    const selected =
      exact !== undefined
        ? [exact]
        : statusEntries.filter(
            (entry) => entry.file.startsWith(dirPrefix) || entry.originalPath?.startsWith(dirPrefix)
          );
    if (selected.length === 0) unmatched.push(arg);
    for (const entry of selected) matched.set(entry.file, entry);
  }
  return { matched: [...matched.values()], unmatched };
}

/**
 * Runs the discard command to revert changes to files or directories.
 * @param projectRoot - Root directory of the project
 * @param requested - Paths to discard (relative to engine/); one status scan serves them all
 * @param options - Discard options
 */
export async function discardCommand(
  projectRoot: string,
  requested: string | readonly string[],
  options: DiscardOptions = {}
): Promise<void> {
  intro('FireForge Discard');
  const args = typeof requested === 'string' ? [requested] : [...requested];

  const paths = getProjectPaths(projectRoot);

  await assertEngineGitReady(paths.engine);

  const statusEntries = await expandUntrackedDirectoryEntries(
    paths.engine,
    await getWorkingTreeStatus(paths.engine)
  );
  const { matched, unmatched } = selectEntries(statusEntries, args);
  if (unmatched.length > 0) {
    throw new GeneralError(
      args.length === 1
        ? `File "${unmatched[0]}" has no changes to discard.`
        : `No changes to discard for: ${unmatched.join(', ')}. Nothing was discarded.`
    );
  }

  const [file = ''] = args;
  const [statusEntry] = matched;
  const singleFile =
    args.length === 1 &&
    statusEntry !== undefined &&
    matched.length === 1 &&
    (statusEntry.file === file || statusEntry.originalPath === file);

  if (!singleFile) {
    // A lone directory keeps its own phrasing; anything else counts paths.
    const dirPath = args.length === 1 ? file.replace(/\/+$/, '') : undefined;
    await discardEntries(
      projectRoot,
      paths.engine,
      paths.patches,
      dirPath !== undefined
        ? {
            phrase: `under ${dirPath}/`,
            roots: [`${dirPath}/`],
            hint: 'Use: fireforge discard <directory> --yes',
          }
        : {
            phrase: `across ${args.length} paths`,
            roots: matched.map((entry) => entry.file),
            hint: 'Use: fireforge discard <path>... --yes',
          },
      matched,
      options
    );
    return;
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
    // Discarding the new path of a rename also resurrects the old path, so
    // the preview names both, exactly when the full picture matters most.
    info(`Would discard changes to: ${dryRunLabel(plan)}`);
    outro('Dry run complete — no changes made');
    return;
  }

  await takeRecoverySnapshot(paths.engine, 'discard', entryPaths([statusEntry]));

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
  const command = program
    .command('discard <paths...>')
    .description(
      'Discard changes to files, restoring patch-claimed paths to their patch-applied baseline (unmanaged untracked files are deleted, emptied directories pruned). Pass several paths to discard them from one status scan. A directory path discards every modified or untracked file beneath it. A recovery snapshot is saved first.'
    )
    .option('--dry-run', 'Show what would be discarded without doing it')
    .option(
      '--to-upstream',
      'Restore to pristine upstream (HEAD) instead of the patch-applied baseline; deletes patch-created files'
    )
    .option('-y, --yes', 'Skip confirmation prompt');
  addWaitLockOption(command).action(
    withErrorHandling(
      async (
        files: string[],
        options: {
          dryRun?: boolean;
          toUpstream?: boolean;
          yes?: boolean;
          waitLock?: boolean | number;
        }
      ) => {
        const projectRoot = getProjectRoot();
        await runUnderEngineLock(projectRoot, 'discard', options, () =>
          discardCommand(projectRoot, files, pickDefined(options))
        );
      }
    )
  );
}
