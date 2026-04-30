// SPDX-License-Identifier: EUPL-1.2
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { isBrandingManagedPath } from '../core/branding.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getStatusWithCodes, hasChanges, isGitRepository } from '../core/git.js';
import { getAllDiff, getDiffForFilesAgainstHead } from '../core/git-diff.js';
import {
  expandUntrackedDirectoryEntries,
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
  getWorkingTreeStatus,
} from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import {
  buildPatchQueueContext,
  lintExportedPatch,
  lintPatchQueue,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import { collectDiffFilePaths, tagLintIssues } from '../core/patch-lint-diff-tag.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { stripEnginePrefix } from '../utils/paths.js';

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
 *
 * When `binaryName` is provided, the aggregate-mode branch (no
 * explicit file list) excludes paths under `browser/branding/<binaryName>/`
 * from the diff. `status` classifies those paths as `branding` —
 * tool-managed material the operator did not author directly — and
 * the 2026-04-21 eval (Finding #2) reported that `fireforge lint` on
 * a fresh project immediately failed `large-patch-lines` /
 * `large-patch-files` / `missing-license-header` on the generated
 * branding tree. File-list mode (explicit paths) preserves the
 * previous behaviour: passing a branding file explicitly still lints
 * it, so operators who need to audit branding content can do so.
 */
async function resolveLintDiff(
  engineDir: string,
  files: string[],
  binaryName?: string,
  furnacePrefixes?: ReadonlySet<string>
): Promise<string | null> {
  if (files.length > 0) {
    const collectedFiles = new Set<string>();
    let fileStatuses: { status: string; file: string }[] | undefined;
    let untrackedFiles: string[] | undefined;

    // Strip a leading `engine/` segment up-front so the rest of the lookup
    // pipeline (directory stat, modified-files-in-dir, status probe) all
    // see the engine-relative form. Without this, passing
    // `engine/browser/base/content/foo.js` fell through to "No modified
    // files found in the specified paths." because git sees every path
    // relative to engine/. The same normalization runs in `register`,
    // `test`, and `export` via `stripEnginePrefix`.
    const normalizedFiles = files.map((inputPath) => stripEnginePrefix(inputPath));

    for (const inputPath of normalizedFiles) {
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

  // Aggregate-mode branding exclusion. A fresh-setup workspace (after
  // `fireforge setup` + `download` + `bootstrap` + `build`) carries a
  // large tool-managed branding diff that the operator did not
  // author; running the default lint against it fires size and
  // license-header rules on content that was never intended to
  // survive in the patch queue as-is. The exclusion mirrors the
  // `branding` bucket in `fireforge status` so the two views stay
  // consistent.
  //
  // `expandUntrackedDirectoryEntries` promotes collapsed `?? dir/`
  // status rows to individual file entries before the diff pass.
  // Without it, a patch that introduces a new directory shows up as
  // `?? browser/modules/<fork>/` and `getDiffForFilesAgainstHead`
  // crashed with EISDIR reading the directory as if it were a file
  // (eval finding: aggregate lint unusable on a real imported queue).
  if (binaryName) {
    const rawStatus = await getWorkingTreeStatus(engineDir);
    const expanded = await expandUntrackedDirectoryEntries(engineDir, rawStatus);
    const allPaths = [...new Set(expanded.map((entry) => entry.file))];
    const nonBrandingPaths = allPaths.filter((path) => !isBrandingManagedPath(path, binaryName));
    const brandingExcluded = allPaths.length - nonBrandingPaths.length;
    // Drop Furnace-managed paths the same way branding is dropped: their
    // contents are tool output (overrides, custom widgets, preview-
    // generated stories) that the operator did not author and never
    // intended to land on the patch queue. Without this carve-out, a
    // post-`furnace preview` aggregate `lint` failed with one
    // `missing-license-header` error per generated story file (eval
    // Finding 19) — each story is intentionally header-less because it's
    // re-generated from component metadata on every preview run.
    const filteredPaths = furnacePrefixes
      ? nonBrandingPaths.filter((path) => ![...furnacePrefixes].some((p) => path.startsWith(p)))
      : nonBrandingPaths;
    const furnaceExcluded = nonBrandingPaths.length - filteredPaths.length;
    if (brandingExcluded > 0) {
      info(
        `Excluded ${brandingExcluded} tool-managed branding file${brandingExcluded === 1 ? '' : 's'} from lint. Pass the path explicitly or use \`fireforge lint <path>\` to include them.`
      );
    }
    if (furnaceExcluded > 0) {
      info(
        `Excluded ${furnaceExcluded} Furnace-managed file${furnaceExcluded === 1 ? '' : 's'} from lint (deployed components and preview-generated stories). Pass the path explicitly to include them.`
      );
    }
    if (filteredPaths.length === 0) {
      info('No non-branding, non-Furnace changes to lint.');
      outro('Nothing to lint');
      return null;
    }
    const diff = await getDiffForFilesAgainstHead(engineDir, filteredPaths.sort());
    if (!diff.trim()) {
      info('No diff content to lint.');
      outro('Nothing to lint');
      return null;
    }
    return diff;
  }

  // Fallback path: no binaryName available (e.g. a legacy caller
  // without a loaded config). Retain the pre-0.16.0 behaviour of
  // linting the full diff so the lint surface is at least as broad
  // as before.
  const diff = await getAllDiff(engineDir);
  if (!diff.trim()) {
    info('No diff content to lint.');
    outro('Nothing to lint');
    return null;
  }
  return diff;
}

/**
 * Result of {@link applyAggregateLintIgnoreSuppression}.
 */
export interface AggregateLintIgnoreResult {
  /** Issues remaining after suppression. */
  issues: PatchLintIssue[];
  /** Number of issues dropped because an owning patch listed the check in `lintIgnore`. */
  dropped: number;
}

/**
 * Filters aggregate-mode lint issues against per-patch `lintIgnore`
 * lists drawn from the manifest. An issue is dropped when at least one
 * patch whose `filesAffected` covers `issue.file` lists `issue.check`
 * in its `lintIgnore`.
 *
 * Mirrors the per-patch contract: `--per-patch` mode threads each
 * patch's `lintIgnore` directly into `lintExportedPatch`, so a check
 * the operator explicitly waived in `patches.json` does not surface.
 * Aggregate `--since` mode previously rediscovered the suppressed
 * warning every CI run because the diff was treated as a single unit
 * with no patch-level scope. Attributing each issue's file to its
 * owning patch via `filesAffected` re-establishes the same suppression
 * semantics. Cross-patch findings (forward-import, duplicate-creation)
 * still attribute via `issue.file` because the `file` field is the
 * offending site, which is owned by some patch.
 *
 * Multiple owners: an issue is dropped if **any** owning patch waived
 * the rule. Conservative — never adds new findings, only drops
 * already-explicitly-waived ones.
 *
 * @param issues - Issues collected from the aggregate lint run.
 * @param ctx - Patch queue context used to attribute file → patch.
 * @returns Filtered issue list and the count of dropped findings.
 */
export function applyAggregateLintIgnoreSuppression(
  issues: PatchLintIssue[],
  ctx: import('../core/patch-lint.js').PatchQueueContext
): AggregateLintIgnoreResult {
  const suppressionsByFile = new Map<string, Set<string>>();
  for (const entry of ctx.entries) {
    const ignoreList = entry.metadata?.lintIgnore;
    if (!ignoreList || ignoreList.length === 0) continue;
    for (const f of entry.metadata?.filesAffected ?? []) {
      let bucket = suppressionsByFile.get(f);
      if (!bucket) {
        bucket = new Set<string>();
        suppressionsByFile.set(f, bucket);
      }
      for (const id of ignoreList) bucket.add(id);
    }
  }
  if (suppressionsByFile.size === 0) {
    return { issues, dropped: 0 };
  }
  const filtered = issues.filter((issue) => !suppressionsByFile.get(issue.file)?.has(issue.check));
  return { issues: filtered, dropped: issues.length - filtered.length };
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

  // Load the config before resolving the diff so we can pass
  // `binaryName` into the aggregate-mode branding exclusion in
  // `resolveLintDiff`. The config was previously loaded only after
  // the diff was resolved; hoisting it is cheap and keeps the two
  // call sites close together.
  const config = await loadConfig(projectRoot);
  // Pull the Furnace-managed prefix set up-front so aggregate lint can
  // mirror the branding exclusion for Furnace material — without it,
  // preview-generated stories under `browser/components/storybook/
  // stories/furnace/` show up as license-header errors on every
  // post-preview lint run.
  const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
  const diff = await resolveLintDiff(paths.engine, files, config.binaryName, furnacePrefixes);
  if (diff === null) return;

  const filesAffected = extractAffectedFiles(diff);

  // Build patch queue context once so it can be shared between the
  // per-patch ownership resolver and the cross-patch rules.
  let ctx: import('../core/patch-lint.js').PatchQueueContext | undefined;
  if (await pathExists(paths.patches)) {
    ctx = await buildPatchQueueContext(paths.patches);
  }

  let issues: PatchLintIssue[] = [
    ...(await lintExportedPatch(paths.engine, filesAffected, diff, config, ctx)),
  ];

  // Cross-patch rules operate over the whole queue, so run them whenever a
  // patches directory exists — they surface duplicate /dev/null creations
  // and forward-import chains that the per-patch orchestrator cannot see.
  if (ctx) {
    issues.push(...lintPatchQueue(ctx));
  }

  // Honor per-patch `lintIgnore` in aggregate mode by attributing each
  // issue's file to its owning patches via the manifest's
  // `filesAffected`. Per-patch mode threads `lintIgnore` directly into
  // `lintExportedPatch`; aggregate mode previously had no patch-level
  // scope to consult, so a check an operator had explicitly waived in
  // `patches.json` re-surfaced on every `--since` run (CI default).
  if (ctx) {
    const result = applyAggregateLintIgnoreSuppression(issues, ctx);
    issues = result.issues;
    if (result.dropped > 0) {
      info(`Suppressed ${result.dropped} issue(s) via per-patch lintIgnore (aggregate mode).`);
    }
  }

  // When a queue manifest exists AND files were NOT scoped explicitly, the
  // "diff" we just linted is every applied patch summed together. Patch-
  // size rules (`large-patch-lines`, `large-patch-files`) then fire against
  // the aggregate rather than any individual patch, producing counts like
  // "Patch is 37529 lines" that read as a task-specific regression but are
  // really an artefact of aggregation. Surface a one-line note pointing at
  // `--per-patch` so the operator knows the per-patch scope exists before
  // they read the error message as "my queue is broken".
  //
  // In aggregate mode over a multi-patch queue we also downgrade the two
  // size rules from `error` to `warning`. Before this downgrade, a
  // fresh-imported patch stack of 20+ patches hard-failed `fireforge lint`
  // on lines-per-aggregate counts that are mathematically impossible to
  // satisfy without splitting patches that were already split — the
  // actionable unit is the individual patch, and `--per-patch` is the
  // mode that matches. Per-patch mode keeps errors as errors (see
  // `lintPerPatch` below).
  const aggregateHintApplicable = files.length === 0 && ctx !== undefined && ctx.entries.length > 1;
  if (
    aggregateHintApplicable &&
    issues.some((i) => i.check === 'large-patch-lines' || i.check === 'large-patch-files')
  ) {
    info(
      'NOTE: aggregate diff across all applied patches. Use `fireforge lint --per-patch` to lint each patch individually; patch-size rules fire against the sum in aggregate mode and are reported as warnings rather than errors here.'
    );
    for (const issue of issues) {
      if (
        (issue.check === 'large-patch-lines' || issue.check === 'large-patch-files') &&
        issue.severity === 'error'
      ) {
        issue.severity = 'warning';
      }
    }
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

  // Notices are advisory and don't count as warnings — emitting "passed
  // with warnings" when only notices fired contradicts the preceding
  // `0 warning(s)` summary line and reads as a regression. Distinguish
  // the three pass states explicitly. Errors suppressed by
  // --only-introduced still warrant the "with warnings" outro — they
  // print as ERROR rows but no longer fail the run, which is the same
  // contract the operator gets from a real warning.
  const suppressedErrors = options.onlyIntroduced && errors.length > 0;
  if (warnings.length > 0 || suppressedErrors) {
    outro('Lint passed with warnings');
  } else if (notices.length > 0) {
    outro('Lint passed with notices');
  } else {
    outro('Lint passed');
  }
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
  let skipped = 0;
  for (const patch of manifest.patches) {
    const existing: string[] = [];
    for (const f of patch.filesAffected) {
      if (await pathExists(join(paths.engine, f))) existing.push(f);
    }
    if (existing.length === 0) {
      skipped++;
      continue;
    }

    const diff = await getDiffForFilesAgainstHead(paths.engine, existing);
    if (!diff.trim()) {
      skipped++;
      continue;
    }

    const ignore = patch.lintIgnore?.length ? new Set<string>(patch.lintIgnore) : undefined;
    const decision = resolvePatchSizeTier(existing, patch.tier);
    if (decision.tier === 'branding') {
      info(
        decision.source === 'explicit'
          ? `${patch.filename}: branding threshold tier applied via patches.json \`tier: "branding"\` opt-in.`
          : `${patch.filename}: branding threshold tier applied (all files under browser/branding/ plus registration siblings).`
      );
    }
    const patchIssues = await lintExportedPatch(
      paths.engine,
      existing,
      diff,
      config,
      ctx,
      ignore,
      patch.tier
    );
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
    // 2026-04-26 eval Finding 7: pre-fix the success line read
    // `No lint issues found across 0 patch(es).` whenever the queue
    // had not been applied to the engine — every patch's
    // `filesAffected` filtered out, so `existing` was empty and the
    // patch was silently skipped. Operators read that as "the queue
    // is clean" when in reality nothing was checked. Surface the
    // skipped count and, when nothing was linted at all, point at
    // `fireforge import` as the missing prerequisite.
    if (linted === 0 && skipped > 0) {
      info(
        `No patches in the queue have been applied to engine/. Run "fireforge import" first if you want lint findings against the staged hunks; otherwise this is expected.`
      );
    }
    const summary =
      skipped > 0
        ? `No lint issues found across ${linted} patch(es) (${skipped} skipped — files not present in engine/).`
        : `No lint issues found across ${linted} patch(es).`;
    success(summary);
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

  if (warnings.length > 0) {
    outro('Lint passed with warnings');
  } else if (notices.length > 0) {
    outro('Lint passed with notices');
  } else {
    outro('Lint passed');
  }
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
