// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { clearAppliedFurnaceState } from '../core/furnace-config.js';
import {
  getHead,
  hasChanges,
  isGitRepository,
  isMissingHeadError,
  resetChanges,
} from '../core/git.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { warnIfStaticComponentsStale } from '../core/test-stale-check.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ResetOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { cancel, info, intro, isCancel, outro, spinner, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Runs the reset command to restore clean Firefox state.
 * @param projectRoot - Root directory of the project
 * @param options - Reset options
 */
export async function resetCommand(projectRoot: string, options: ResetOptions): Promise<void> {
  intro('FireForge Reset');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Check if it's a git repository
  if (!(await isGitRepository(paths.engine))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

  // Unborn-HEAD guard (mirrors status): an interrupted download leaves a
  // repo with no baseline commit, where the entire ~300k-file tree reads
  // as untracked — a reset against that state is never what the operator
  // wants, and the guidance names the actual fix.
  try {
    await getHead(paths.engine);
  } catch (headError: unknown) {
    if (!isMissingHeadError(headError)) throw headError;
    throw new GeneralError(
      'Engine repository has no baseline commit yet — a previous "fireforge download" was interrupted before git created the initial Firefox source commit. Re-run "fireforge download --force" to recreate the baseline repository cleanly.'
    );
  }

  // Check for changes
  const hasUncommittedChanges = await hasChanges(paths.engine);

  if (!hasUncommittedChanges) {
    info('No changes to reset');
    outro('Working tree already clean');
    return;
  }

  // Dry-run: show what would be reset
  if (options.dryRun) {
    const statusEntries = await expandUntrackedDirectoryEntries(
      paths.engine,
      await getWorkingTreeStatus(paths.engine)
    );
    info(`Would reset ${statusEntries.length} file${statusEntries.length === 1 ? '' : 's'}:`);
    for (const entry of statusEntries) {
      const label = entry.originalPath ? `${entry.originalPath} -> ${entry.file}` : entry.file;
      info(`  ${label}`);
    }
    outro('Dry run complete — no changes made');
    return;
  }

  // Confirm reset unless --yes is specified
  if (!options.yes) {
    // Check for non-interactive mode
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

    if (!isInteractive) {
      throw new InvalidArgumentError(
        'Interactive confirmation not available. Use --yes flag to reset without confirmation.',
        'Use: fireforge reset --yes'
      );
    }

    warn(
      'This will discard all uncommitted changes in the engine directory, including staged additions and untracked files.'
    );

    const confirmed = await confirm({
      message: 'Are you sure you want to reset?',
      initialValue: false,
    });

    if (isCancel(confirmed) || !confirmed) {
      cancel('Reset cancelled');
      return;
    }
  }

  const s = spinner('Resetting changes...');

  try {
    await resetChanges(paths.engine);

    // Clearing furnace-state.json is the honest representation of what just
    // happened: any previously deployed Furnace files have been discarded
    // with the engine reset. Without this, a subsequent `furnace apply`
    // would match on workspace checksums and report "up to date" against
    // an engine that no longer contains the deployed copies. (The drift
    // check in apply also catches this, but clearing here keeps state
    // consistent regardless of the drift oracle.) Preserve pendingRepair:
    // authoring-side rollback markers are about the workspace/component
    // tree, not the engine checkout, so reset must not silently forget them.
    await clearAppliedFurnaceState(projectRoot);

    s.stop('Changes reset');

    // The reset may have moved components.conf away from what the last full
    // build compiled in — surface that now instead of at the next test
    // refusal (FORGE F13).
    await warnIfStaticComponentsStale(projectRoot, paths.engine);

    outro('Working tree restored to clean state');
  } catch (error: unknown) {
    s.error('Reset failed');
    throw error;
  }
}

/** Registers the reset command on the CLI program. */
export function registerReset(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('reset')
    .description('Reset engine/ to clean state')
    .option('-y, --yes', 'Skip confirmation prompt (required for scripts/CI)')
    .option('--dry-run', 'Show what would be reset without doing it')
    .action(
      withErrorHandling(async (options: { yes?: boolean; dryRun?: boolean }) => {
        await resetCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
