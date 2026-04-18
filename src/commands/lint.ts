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
import { buildPatchQueueContext, lintExportedPatch, lintPatchQueue } from '../core/patch-lint.js';
import { collectDiffFilePaths, tagLintIssues } from '../core/patch-lint-diff-tag.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

/** Options controlling how the lint command filters and tags its output. */
export interface LintCommandOptions {
  /**
   * When set, tag each issue as `introduced` or `cumulative` based on
   * whether its file changed since this git revision (e.g. `HEAD`, a
   * branch name, or a SHA). Issues are not filtered — the full set still
   * prints and the exit code is unchanged — but a diff-scoped summary
   * makes it trivial to see which errors the current task introduced.
   */
  since?: string;
}

/**
 * Runs the lint command to check engine changes against patch quality rules.
 * @param projectRoot - Root directory of the project
 * @param files - Optional file/directory paths to lint (relative to engine/)
 * @param options - Additional lint options such as `--since` diff-scoping
 */
export async function lintCommand(
  projectRoot: string,
  files: string[],
  options: LintCommandOptions = {}
): Promise<void> {
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

  // Build patch queue context once so it can be shared between the
  // per-patch ownership resolver and the cross-patch rules.
  let ctx: import('../core/patch-lint.js').PatchQueueContext | undefined;
  if (await pathExists(paths.patches)) {
    ctx = await buildPatchQueueContext(paths.patches);
  }

  const issues: PatchLintIssue[] = [
    ...(await lintExportedPatch(paths.engine, filesAffected, diff, config, ctx)),
  ];

  // Cross-patch rules operate over the whole queue, so run them whenever a
  // patches directory exists — they surface duplicate /dev/null creations
  // and forward-import chains that the per-patch orchestrator cannot see.
  if (ctx) {
    issues.push(...lintPatchQueue(ctx));
  }

  if (issues.length === 0) {
    success('No lint issues found.');
    outro('Lint passed');
    return;
  }

  // Diff-scoping: tag each issue as introduced-in-current-task vs
  // cumulative-pre-existing-drift. Never filters — full set still prints
  // and exit code semantics are unchanged — but the per-line prefix and
  // summary make triage trivial on a large patch series.
  const sinceActive = Boolean(options.since);
  if (options.since) {
    const diffFiles = await collectDiffFilePaths(paths.engine, options.since);
    tagLintIssues(issues, diffFiles);
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const notices = issues.filter((i) => i.severity === 'notice');

  const tagPrefix = (issue: PatchLintIssue): string =>
    sinceActive && issue.tag ? `[${issue.tag}] ` : '';

  for (const issue of notices) {
    info(`${tagPrefix(issue)}NOTICE [${issue.check}] ${issue.file}: ${issue.message}`);
  }
  for (const issue of warnings) {
    warn(`${tagPrefix(issue)}[${issue.check}] ${issue.file}: ${issue.message}`);
  }
  for (const issue of errors) {
    warn(`${tagPrefix(issue)}ERROR [${issue.check}] ${issue.file}: ${issue.message}`);
  }

  if (sinceActive) {
    const introducedErrors = errors.filter((i) => i.tag === 'introduced').length;
    const introducedWarnings = warnings.filter((i) => i.tag === 'introduced').length;
    const cumulativeErrors = errors.length - introducedErrors;
    const cumulativeWarnings = warnings.length - introducedWarnings;
    info(
      `\nLint: ${introducedErrors} introduced error(s), ${introducedWarnings} introduced warning(s); ${cumulativeErrors} cumulative error(s), ${cumulativeWarnings} cumulative warning(s)`
    );
  } else {
    info(`\nLint: ${errors.length} error(s), ${warnings.length} warning(s)`);
  }

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
    .option(
      '--since <git-rev>',
      'Tag issues as [introduced] or [cumulative] based on whether the file changed since <git-rev> (e.g. HEAD, a branch, a SHA)'
    )
    .action(
      withErrorHandling(async (paths: string[], options: { since?: string }) => {
        const lintOptions: LintCommandOptions = {};
        if (options.since !== undefined) {
          lintOptions.since = options.since;
        }
        await lintCommand(getProjectRoot(), paths, lintOptions);
      })
    );
}
