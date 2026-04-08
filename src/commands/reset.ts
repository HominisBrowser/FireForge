// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { hasChanges, isGitRepository, resetChanges } from '../core/git.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
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

  // Confirm reset unless --force is specified
  if (!options.force) {
    // Check for non-interactive mode
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

    if (!isInteractive) {
      throw new InvalidArgumentError(
        'Interactive confirmation not available. Use --force flag to reset without confirmation.',
        'Use: fireforge reset --force'
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
    s.stop('Changes reset');
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
    .option('-f, --force', 'Skip confirmation prompt (required for scripts/CI)')
    .option('--dry-run', 'Show what would be reset without doing it')
    .action(
      withErrorHandling(async (options: { force?: boolean; dryRun?: boolean }) => {
        await resetCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
