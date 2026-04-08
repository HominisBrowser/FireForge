// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { isGitRepository } from '../core/git.js';
import { discardStatusEntry } from '../core/git-file-ops.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { GitError } from '../errors/git.js';
import type { CommandContext } from '../types/cli.js';
import type { DiscardOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, isCancel, outro, spinner } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

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

  // Check if the file has changes
  const statusEntries = await expandUntrackedDirectoryEntries(
    paths.engine,
    await getWorkingTreeStatus(paths.engine)
  );
  const statusEntry = statusEntries.find(
    (entry) => entry.file === file || entry.originalPath === file
  );

  if (!statusEntry) {
    throw new GeneralError(`File "${file}" has no changes to discard.`);
  }

  if (!options.force && !options.dryRun) {
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    if (!isInteractive) {
      throw new InvalidArgumentError(
        'Interactive confirmation not available. Use --force flag to discard without confirmation.',
        'Use: fireforge discard <file> --force'
      );
    }
    const confirmed = await confirm({
      message: `Discard all changes to ${statusEntry.file}?`,
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) {
      outro('Discard cancelled');
      return;
    }
  }

  if (options.dryRun) {
    const target =
      statusEntry.originalPath === file
        ? `${statusEntry.originalPath} -> ${statusEntry.file}`
        : statusEntry.file;
    info(`Would discard changes to: ${target}`);
    outro('Dry run complete — no changes made');
    return;
  }

  const s = spinner(`Discarding changes to ${file}...`);

  try {
    await discardStatusEntry(paths.engine, statusEntry);
    s.stop(`Discarded changes to ${file}`);
    outro('File restored to original state');
  } catch (error: unknown) {
    s.error('Discard failed');
    if (error instanceof GitError) {
      throw error;
    }
    throw new GitError(
      `Failed to discard ${file}`,
      statusEntry.isUntracked
        ? `rm ${statusEntry.file}`
        : `restore --source HEAD --staged --worktree -- ${statusEntry.file}`,
      error instanceof Error ? error : undefined
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
    .description('Discard changes to a specific file (deletes untracked files)')
    .option('--dry-run', 'Show what would be discarded without doing it')
    .option('--force', 'Skip confirmation prompt')
    .action(
      withErrorHandling(async (file: string, options: { dryRun?: boolean; force?: boolean }) => {
        await discardCommand(getProjectRoot(), file, pickDefined(options));
      })
    );
}
