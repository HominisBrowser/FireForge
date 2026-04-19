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
   * prints — but a diff-scoped summary makes it trivial to see which
   * errors the current task introduced.
   */
  since?: string;
  /**
   * When set together with {@link since}, scope the exit code to issues
   * tagged `introduced`. Cumulative pre-existing errors still print (so
   * the operator can still see the full queue state) but do not fail
   * lint. Motivating case: a branch whose diff is clean but whose repo
   * already carries unrelated `raw-color` / license-header errors from
   * older patches. Without this flag, CI treats the clean branch as
   * failing; with it, a branch "breaks the build" only when its own diff
   * introduced a new error.
   *
   * Requires {@link since}: without a revision to diff against there is
   * no distinction between introduced and cumulative, so the flag is
   * rejected up-front rather than silently ignored.
   */
  onlyIntroduced?: boolean;
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

  // `--only-introduced` scopes the exit code to `--since`-tagged issues, so
  // without a revision to anchor the diff there is no "introduced" subset
  // to scope to — reject the combination up-front so a misconfigured CI
  // invocation fails loud instead of silently treating every error as
  // cumulative and passing.
  if (options.onlyIntroduced && !options.since) {
    throw new GeneralError(
      '--only-introduced requires --since <git-rev> so introduced-vs-cumulative can be distinguished.'
    );
  }

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

  // Exit-code scope: `--only-introduced` narrows the failure criterion to
  // issues tagged `introduced`. Cumulative errors still print so the
  // operator sees the full queue state, but do not fail lint — the
  // motivating case is a branch whose own diff is clean but whose repo
  // already carries pre-existing queue errors from older patches.
  const failingErrors = options.onlyIntroduced
    ? errors.filter((i) => i.tag === 'introduced')
    : errors;

  if (failingErrors.length > 0) {
    outro('Lint failed');
    const cumulativeSuppressed =
      options.onlyIntroduced && errors.length > failingErrors.length
        ? ` (${errors.length - failingErrors.length} cumulative error(s) suppressed by --only-introduced)`
        : '';
    throw new GeneralError(
      `Patch lint found ${failingErrors.length} ${
        options.onlyIntroduced ? 'introduced ' : ''
      }error(s). Fix these before exporting.${cumulativeSuppressed}`
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
    .option(
      '--only-introduced',
      'Fail only on issues tagged [introduced] (requires --since). Cumulative errors still print but do not set a non-zero exit.'
    )
    .action(
      withErrorHandling(
        async (paths: string[], options: { since?: string; onlyIntroduced?: boolean }) => {
          const lintOptions: LintCommandOptions = {};
          if (options.since !== undefined) {
            lintOptions.since = options.since;
          }
          if (options.onlyIntroduced !== undefined) {
            lintOptions.onlyIntroduced = options.onlyIntroduced;
          }
          await lintCommand(getProjectRoot(), paths, lintOptions);
        }
      )
    );
}
