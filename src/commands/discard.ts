// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getHead, isGitRepository, isMissingHeadError } from '../core/git.js';
import { discardStatusEntry } from '../core/git-file-ops.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { GitError } from '../errors/git.js';
import type { CommandContext } from '../types/cli.js';
import type { DiscardOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, isCancel, outro, spinner, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

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
  dirPath: string,
  entries: ReadonlyArray<Awaited<ReturnType<typeof expandUntrackedDirectoryEntries>>[number]>,
  options: DiscardOptions
): Promise<void> {
  if (!options.yes && !options.dryRun) {
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    if (!isInteractive) {
      throw new InvalidArgumentError(
        'Interactive confirmation not available. Use --yes flag to discard without confirmation.',
        'Use: fireforge discard <directory> --yes'
      );
    }
    const confirmed = await confirm({
      message: `Discard changes to ${entries.length} file${entries.length === 1 ? '' : 's'} under ${dirPath}/?`,
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) {
      outro('Discard cancelled');
      return;
    }
  }

  if (options.dryRun) {
    info(`Would discard changes to ${entries.length} file(s) under ${dirPath}/:`);
    for (const entry of entries) {
      const target =
        entry.originalPath && entry.originalPath !== entry.file
          ? `${entry.originalPath} -> ${entry.file}`
          : entry.file;
      info(`  ${target}`);
    }
    outro('Dry run complete — no changes made');
    return;
  }

  const s = spinner(`Discarding ${entries.length} file(s) under ${dirPath}/...`);
  let succeeded = 0;
  const failures: string[] = [];
  try {
    for (const entry of entries) {
      try {
        await discardStatusEntry(engineDir, entry);
        succeeded += 1;
      } catch (error: unknown) {
        failures.push(`${entry.file}: ${toError(error).message}`);
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
      // Furnace config may not exist — skip silently
    }

    if (failures.length > 0) {
      throw new GeneralError(
        `Failed to discard ${failures.length} file(s) under ${dirPath}/. See warnings above.`
      );
    }

    outro(`${succeeded} file(s) restored to original state`);
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
  // as untracked — a discard against that state is never what the operator
  // wants, and the guidance names the actual fix.
  try {
    await getHead(paths.engine);
  } catch (headError: unknown) {
    if (!isMissingHeadError(headError)) throw headError;
    throw new GeneralError(
      'Engine repository has no baseline commit yet — a previous "fireforge download" was interrupted before git created the initial Firefox source commit. Re-run "fireforge download --force" to recreate the baseline repository cleanly.'
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

  // Directory recursion fallback: when the explicit path does not match a
  // single status entry but DOES correspond to one or more entries below
  // it, treat the input as a directory and discard everything inside.
  // 2026-04-25 eval Finding 20: `discard browser/components/storybook/
  // stories/furnace --yes` failed with "no changes to discard" even
  // though `status --unmanaged` listed 23 files under that directory —
  // operators were forced to discard each file individually or fall
  // back to non-FireForge cleanup commands. Match against the
  // directory-with-trailing-slash form so a path like `foo/bar` doesn't
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
      await discardDirectoryEntries(projectRoot, paths.engine, dirPath, dirEntries, options);
      return;
    }
    throw new GeneralError(`File "${file}" has no changes to discard.`);
  }

  if (!options.yes && !options.dryRun) {
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    if (!isInteractive) {
      throw new InvalidArgumentError(
        'Interactive confirmation not available. Use --yes flag to discard without confirmation.',
        'Use: fireforge discard <file> --yes'
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
    // Show the rename pair regardless of which side the operator passed —
    // passing the NEW path of a rename used to hide that discarding also
    // resurrects the old path, exactly when the full picture matters most.
    const target = statusEntry.originalPath
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

    // Warn when the discarded file is managed by Furnace so the user knows
    // to re-apply if they want the component's deployed state back.
    try {
      const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
      if ([...furnacePrefixes].some((prefix) => file.startsWith(prefix))) {
        warn('This file is managed by Furnace. Run "fireforge furnace apply" to restore it.');
      }
    } catch {
      // Furnace config may not exist — skip silently
    }

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
      'Discard changes to a specific file (deletes untracked files). Pass a directory path to discard every modified or untracked file beneath it; the operation walks the status output and reverts each match individually.'
    )
    .option('--dry-run', 'Show what would be discarded without doing it')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      withErrorHandling(async (file: string, options: { dryRun?: boolean; yes?: boolean }) => {
        await discardCommand(getProjectRoot(), file, pickDefined(options));
      })
    );
}
