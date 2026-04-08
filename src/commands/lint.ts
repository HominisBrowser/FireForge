// SPDX-License-Identifier: EUPL-1.2
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { getStatusWithCodes, hasChanges, isGitRepository } from '../core/git.js';
import { getAllDiff, getDiffForFilesAgainstHead } from '../core/git-diff.js';
import {
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
} from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { lintExportedPatch } from '../core/patch-lint.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

/**
 * Runs the lint command to check engine changes against patch quality rules.
 * @param projectRoot - Root directory of the project
 * @param files - Optional file/directory paths to lint (relative to engine/)
 */
export async function lintCommand(projectRoot: string, files: string[]): Promise<void> {
  intro('FireForge Lint');

  const paths = getProjectPaths(projectRoot);

  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  if (!(await isGitRepository(paths.engine))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

  let diff: string;

  if (files.length > 0) {
    // Collect specific files/directories
    const collectedFiles = new Set<string>();

    let fileStatuses: { status: string; file: string }[] | undefined;
    let untrackedFiles: string[] | undefined;

    for (const inputPath of files) {
      const fullInputPath = join(paths.engine, inputPath);
      let isDirectory = false;
      try {
        const fileStat = await stat(fullInputPath);
        isDirectory = fileStat.isDirectory();
      } catch {
        // Treat as file
      }

      if (isDirectory) {
        const dirPath = inputPath.endsWith('/') ? inputPath.slice(0, -1) : inputPath;
        const modifiedFiles = await getModifiedFilesInDir(paths.engine, dirPath);
        const dirUntrackedFiles = await getUntrackedFilesInDir(paths.engine, dirPath);
        for (const f of modifiedFiles) collectedFiles.add(f);
        for (const f of dirUntrackedFiles) collectedFiles.add(f);
      } else {
        if (!fileStatuses) {
          fileStatuses = await getStatusWithCodes(paths.engine);
        }
        if (!untrackedFiles) {
          untrackedFiles = await getUntrackedFiles(paths.engine);
        }
        const hasStatus =
          fileStatuses.some((s) => s.file === inputPath) || untrackedFiles.includes(inputPath);
        if (hasStatus) {
          collectedFiles.add(inputPath);
        }
      }
    }

    if (collectedFiles.size === 0) {
      info('No modified files found in the specified paths.');
      outro('Nothing to lint');
      return;
    }

    diff = await getDiffForFilesAgainstHead(paths.engine, [...collectedFiles].sort());
  } else {
    // Lint all changes
    if (!(await hasChanges(paths.engine))) {
      info('No changes to lint.');
      outro('Nothing to lint');
      return;
    }

    diff = await getAllDiff(paths.engine);
  }

  if (!diff.trim()) {
    info('No diff content to lint.');
    outro('Nothing to lint');
    return;
  }

  const config = await loadConfig(projectRoot);
  const filesAffected = extractAffectedFiles(diff);
  const issues = await lintExportedPatch(paths.engine, filesAffected, diff, config);

  if (issues.length === 0) {
    success('No lint issues found.');
    outro('Lint passed');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  for (const issue of warnings) {
    warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
  }
  for (const issue of errors) {
    warn(`ERROR [${issue.check}] ${issue.file}: ${issue.message}`);
  }

  info(`\nLint: ${errors.length} error(s), ${warnings.length} warning(s)`);

  if (errors.length > 0) {
    outro('Lint failed');
    throw new GeneralError(
      `Patch lint found ${errors.length} error(s). Fix these before exporting.`
    );
  }

  outro('Lint passed with warnings');
}

/** Registers the lint command on the CLI program. */
export function registerLint(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('lint [paths...]')
    .description('Lint engine changes against patch quality rules')
    .action(
      withErrorHandling(async (paths: string[]) => {
        await lintCommand(getProjectRoot(), paths);
      })
    );
}
