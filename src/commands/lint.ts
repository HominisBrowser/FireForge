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
import { loadPatchesManifest } from '../core/patch-manifest.js';
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
  /**
   * Lint each patch in the queue as its own isolated diff, rather than
   * the aggregate `git diff HEAD` across all applied patches.
   *
   * Motivating case: running `fireforge lint` (no args) on a repo where
   * `fireforge import` or `fireforge rebase` has just applied the full
   * patch queue produces an aggregate diff (every patch's changes
   * summed). The patch-size advisory rules (`large-patch-lines`,
   * `large-patch-files`) then fire against the sum — e.g. "Patch is
   * 37529 lines" on a queue of 22 individually-fine patches — which
   * reads as a task-specific regression when it is really an artefact
   * of the aggregation. `--per-patch` rescopes the diff to each patch's
   * own `filesAffected`, honours the patch's own `lintIgnore`, and runs
   * the cross-patch rules once over the whole queue so queue-level
   * findings (duplicate creations, forward imports) still surface.
   *
   * Mutually exclusive with passing explicit file paths — the two
   * scope contracts are different.
   */
  perPatch?: boolean;
}

/**
 * Resolves the diff the lint command should run against. Returns `null` when
 * there is nothing to lint (e.g. no matching files, clean tree, or empty
 * diff content) — callers treat that as the early-exit signal and stop.
 *
 * Extracted from {@link lintCommand} so that function stays under the
 * per-function LOC budget as the command grows; the two file-mode and
 * aggregate-mode branches share no state with the post-lint reporting
 * pipeline, so the split is a pure rename rather than a refactor.
 */
async function resolveLintDiff(engineDir: string, files: string[]): Promise<string | null> {
  if (files.length > 0) {
    const collectedFiles = new Set<string>();
    let fileStatuses: { status: string; file: string }[] | undefined;
    let untrackedFiles: string[] | undefined;

    for (const inputPath of files) {
      const fullInputPath = join(engineDir, inputPath);
      let isDirectory = false;
      try {
        const fileStat = await stat(fullInputPath);
        isDirectory = fileStat.isDirectory();
      } catch {
        // Treat as file
      }

      if (isDirectory) {
        const dirPath = inputPath.endsWith('/') ? inputPath.slice(0, -1) : inputPath;
        const modifiedFiles = await getModifiedFilesInDir(engineDir, dirPath);
        const dirUntrackedFiles = await getUntrackedFilesInDir(engineDir, dirPath);
        for (const f of modifiedFiles) collectedFiles.add(f);
        for (const f of dirUntrackedFiles) collectedFiles.add(f);
      } else {
        if (!fileStatuses) fileStatuses = await getStatusWithCodes(engineDir);
        if (!untrackedFiles) untrackedFiles = await getUntrackedFiles(engineDir);
        const hasStatus =
          fileStatuses.some((s) => s.file === inputPath) || untrackedFiles.includes(inputPath);
        if (hasStatus) collectedFiles.add(inputPath);
      }
    }

    if (collectedFiles.size === 0) {
      info('No modified files found in the specified paths.');
      outro('Nothing to lint');
      return null;
    }

    const diff = await getDiffForFilesAgainstHead(engineDir, [...collectedFiles].sort());
    if (!diff.trim()) {
      info('No diff content to lint.');
      outro('Nothing to lint');
      return null;
    }
    return diff;
  }

  if (!(await hasChanges(engineDir))) {
    info('No changes to lint.');
    outro('Nothing to lint');
    return null;
  }
  const diff = await getAllDiff(engineDir);
  if (!diff.trim()) {
    info('No diff content to lint.');
    outro('Nothing to lint');
    return null;
  }
  return diff;
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

  // `--per-patch` rescopes the diff from "aggregate engine state" to "each
  // patch's own filesAffected". Mixing in explicit file paths would produce
  // an ambiguous set — is the file list an additional filter, or does it
  // replace the per-patch scope? Reject up-front so the operator gets a
  // clear error rather than a silently-narrowed result.
  if (options.perPatch && files.length > 0) {
    throw new GeneralError(
      '--per-patch cannot be combined with explicit file paths. Pass either --per-patch or a file list, not both.'
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

  if (options.perPatch) {
    await lintPerPatch(projectRoot, paths);
    return;
  }

  const diff = await resolveLintDiff(paths.engine, files);
  if (diff === null) return;

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

  // When a queue manifest exists AND files were NOT scoped explicitly, the
  // "diff" we just linted is every applied patch summed together. Patch-
  // size rules (`large-patch-lines`, `large-patch-files`) then fire against
  // the aggregate rather than any individual patch, producing counts like
  // "Patch is 37529 lines" that read as a task-specific regression but are
  // really an artefact of aggregation. Surface a one-line note pointing at
  // `--per-patch` so the operator knows the per-patch scope exists before
  // they read the error message as "my queue is broken".
  const aggregateHintApplicable = files.length === 0 && ctx !== undefined && ctx.entries.length > 1;
  if (
    aggregateHintApplicable &&
    issues.some((i) => i.check === 'large-patch-lines' || i.check === 'large-patch-files')
  ) {
    info(
      'NOTE: aggregate diff across all applied patches. Use `fireforge lint --per-patch` to lint each patch individually; patch-size rules fire against the sum in aggregate mode.'
    );
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

/**
 * Lints each patch in the queue as its own isolated diff, honouring
 * per-patch `lintIgnore` entries. Cross-patch rules still run once over
 * the whole queue so queue-level findings (duplicate creations, forward
 * imports) are not lost by the rescoping.
 *
 * Kept separate from {@link lintCommand}'s aggregate path because the
 * two scopes have genuinely different contracts — the aggregate path
 * reports what `git diff HEAD` looks like right now, the per-patch
 * path reports what each patch's own slice of that diff looks like.
 * Sharing a loop would hide the distinction and force the caller to
 * decide semantics mid-function.
 */
async function lintPerPatch(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>
): Promise<void> {
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    info('No patches in manifest — nothing to lint per-patch.');
    outro('Nothing to lint');
    return;
  }

  const config = await loadConfig(projectRoot);
  const ctx = await buildPatchQueueContext(paths.patches);

  const issues: PatchLintIssue[] = [];
  let linted = 0;
  for (const patch of manifest.patches) {
    const existing: string[] = [];
    for (const f of patch.filesAffected) {
      if (await pathExists(join(paths.engine, f))) existing.push(f);
    }
    if (existing.length === 0) continue;

    const diff = await getDiffForFilesAgainstHead(paths.engine, existing);
    if (!diff.trim()) continue;

    const ignore = patch.lintIgnore?.length ? new Set<string>(patch.lintIgnore) : undefined;
    const patchIssues = await lintExportedPatch(paths.engine, existing, diff, config, ctx, ignore);
    for (const issue of patchIssues) {
      issues.push({ ...issue, file: `${patch.filename} :: ${issue.file}` });
    }
    linted++;
  }

  // Cross-patch rules over the whole queue — rescoping per-patch would
  // lose these findings, so they run exactly once against the full
  // context.
  issues.push(...lintPatchQueue(ctx));

  if (issues.length === 0) {
    success(`No lint issues found across ${linted} patch(es).`);
    outro('Lint passed');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const notices = issues.filter((i) => i.severity === 'notice');
  for (const issue of notices) info(`NOTICE [${issue.check}] ${issue.file}: ${issue.message}`);
  for (const issue of warnings) warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
  for (const issue of errors) warn(`ERROR [${issue.check}] ${issue.file}: ${issue.message}`);

  info(
    `\nLint (per-patch over ${linted} patch(es)): ${errors.length} error(s), ${warnings.length} warning(s)`
  );

  if (errors.length > 0) {
    outro('Lint failed');
    throw new GeneralError(
      `Patch lint found ${errors.length} error(s) across ${linted} patch(es). Fix these before exporting.`
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
    .description(
      'Lint engine changes against patch quality rules. Default: aggregate diff against HEAD ' +
        '(every applied patch summed). Use --per-patch for per-patch scope, or pass explicit ' +
        'file paths to narrow to those.'
    )
    .option(
      '--since <git-rev>',
      'Tag issues as [introduced] or [cumulative] based on whether the file changed since <git-rev> (e.g. HEAD, a branch, a SHA)'
    )
    .option(
      '--only-introduced',
      'Fail only on issues tagged [introduced] (requires --since). Cumulative errors still print but do not set a non-zero exit.'
    )
    .option(
      '--per-patch',
      "Lint each patch in the queue as its own isolated diff. Rescopes patch-size rules so they fire against individual patches rather than the aggregate. Honours each patch's `lintIgnore` entries."
    )
    .action(
      withErrorHandling(
        async (
          paths: string[],
          options: { since?: string; onlyIntroduced?: boolean; perPatch?: boolean }
        ) => {
          const lintOptions: LintCommandOptions = {};
          if (options.since !== undefined) {
            lintOptions.since = options.since;
          }
          if (options.onlyIntroduced !== undefined) {
            lintOptions.onlyIntroduced = options.onlyIntroduced;
          }
          if (options.perPatch !== undefined) {
            lintOptions.perPatch = options.perPatch;
          }
          await lintCommand(getProjectRoot(), paths, lintOptions);
        }
      )
    );
}
