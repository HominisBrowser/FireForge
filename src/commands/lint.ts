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
import { clearPerPatchLintCache } from '../core/lint-cache.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import {
  buildPatchQueueContext,
  countNonBinaryDiffLines,
  lintExportedPatch,
  lintPatchQueue,
  lintPatchSize,
} from '../core/patch-lint.js';
import { collectDiffFilePaths, tagLintIssues } from '../core/patch-lint-diff-tag.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { LintCommandOptions, PatchLintIssue } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { lintPerPatch } from './lint-per-patch.js';

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

function buildMaxWarningsMessage(count: number, maxWarnings: number, scope?: string): string {
  const scoped = scope ? ` ${scope}` : '';
  const base = `Patch lint found ${count} warning(s)${scoped}, exceeding --max-warnings ${maxWarnings}.`;
  return (
    base +
    ' If this is a release gate, run with --per-patch to identify the owning patch. For intentional staged imports, use patch staged-dependency; for ownership repairs, preview patch move-files, patch reorder --dry-run, or re-export --files --dry-run; add scoped lintIgnore only after review.'
  );
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
 * Up-front flag validation for `lintCommand`: rejects `--only-introduced`
 * without `--since`, non-integer `--max-warnings`, and `--per-patch`
 * combined with explicit file paths — each a misconfiguration that should
 * fail loud rather than silently narrow the result.
 */
function validateLintFlags(options: LintCommandOptions, files: string[]): void {
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

  if (
    options.maxWarnings !== undefined &&
    (!Number.isInteger(options.maxWarnings) || options.maxWarnings < 0)
  ) {
    throw new GeneralError('--max-warnings must be a non-negative integer.');
  }

  // `--per-patch` rescopes the diff from "aggregate engine state" to "each
  // patch's own filesAffected". Mixing in explicit engine file paths would
  // produce an ambiguous set — is the file list an additional filter, or
  // does it replace the per-patch scope? Reject up-front, but point at the
  // first-class subset filter so an operator who wanted to target patches
  // (not engine files) knows the supported syntax.
  if (options.perPatch && files.length > 0) {
    throw new GeneralError(
      '--per-patch cannot be combined with explicit engine file paths. ' +
        'To lint a subset of patches, use `--per-patch --patches <name…>`; ' +
        'to lint specific engine files, drop --per-patch.'
    );
  }

  // `--patches` only means something in per-patch mode (it filters the
  // queue); in aggregate/file-list mode there is no patch loop to narrow.
  if (options.patches !== undefined && !options.perPatch) {
    throw new GeneralError('--patches requires --per-patch.');
  }
}

/**
 * Aggregate-mode patch-size softening: when the linted diff is every
 * applied patch summed (no explicit file scope, multi-patch queue), the
 * `large-patch-lines` / `large-patch-files` counts are an artefact of
 * aggregation rather than a property of any one patch. Surface the
 * `--per-patch` hint and downgrade those two rules to warnings; per-patch
 * mode keeps them as errors.
 */
function downgradeAggregateSizeRules(
  issues: PatchLintIssue[],
  files: string[],
  ctx: import('../core/patch-lint.js').PatchQueueContext | undefined
): void {
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
}

/**
 * Evaluates the patch-size rules (`large-patch-files` / `large-patch-lines`)
 * for an ad-hoc explicit-file-list lint, scoped to each file's **owning
 * patch** rather than the combined file list.
 *
 * The default file-list path used to feed every passed file to
 * `lintExportedPatch` as one synthetic patch, so a cross-patch selection of
 * eight files belonging to four patches reported `Patch affects 8 files`
 * even though no single owning patch was oversized. This helper instead
 * groups the affected files by their owning patch (via the manifest's
 * `filesAffected`), then runs `lintPatchSize` against each owner's real file
 * count + diff, honouring that owner's `tier` and `lintIgnore` — so
 * `lint <files>`, `lint --per-patch`, and `re-export --dry-run` agree on the
 * same size findings for the same files. Files no patch claims are evaluated
 * together as one prospective new patch, preserving the pre-export
 * oversized-change warning.
 *
 * @param engineDir - Absolute engine directory
 * @param filesAffected - Engine-relative files touched by the ad-hoc diff
 * @param ctx - Patch queue context used to attribute file → owning patch
 * @returns Size issues, each attributed to its owning patch by message prefix
 */
async function lintOwningPatchSizes(
  engineDir: string,
  filesAffected: string[],
  ctx: import('../core/patch-lint.js').PatchQueueContext
): Promise<PatchLintIssue[]> {
  const listed = new Set(filesAffected);
  const owners = new Map<string, (typeof ctx.entries)[number]>();
  const ownedListed = new Set<string>();
  for (const entry of ctx.entries) {
    const md = entry.metadata;
    if (!md) continue;
    let ownsAny = false;
    for (const f of md.filesAffected) {
      if (listed.has(f)) {
        ownedListed.add(f);
        ownsAny = true;
      }
    }
    if (ownsAny) owners.set(entry.filename, entry);
  }

  const issues: PatchLintIssue[] = [];

  const lineCountForFiles = async (relPaths: string[]): Promise<number> => {
    const existing: string[] = [];
    for (const f of relPaths) {
      if (await pathExists(join(engineDir, f))) existing.push(f);
    }
    if (existing.length === 0) return 0;
    const diff = await getDiffForFilesAgainstHead(engineDir, existing);
    return countNonBinaryDiffLines(diff).textLines;
  };

  for (const entry of owners.values()) {
    const md = entry.metadata;
    if (!md) continue;
    const lineCount = await lineCountForFiles(md.filesAffected);
    const ignore = md.lintIgnore?.length ? new Set(md.lintIgnore) : undefined;
    for (const issue of lintPatchSize(md.filesAffected, lineCount, md.tier)) {
      if (ignore?.has(issue.check)) continue;
      issues.push({ ...issue, message: `${entry.filename}: ${issue.message}` });
    }
  }

  // Files no patch claims are a prospective new patch: evaluate them as one
  // unit so a genuinely oversized fresh change still surfaces.
  const unowned = filesAffected.filter((f) => !ownedListed.has(f));
  if (unowned.length > 0) {
    const lineCount = await lineCountForFiles(unowned);
    issues.push(...lintPatchSize(unowned, lineCount));
  }

  return issues;
}

/**
 * Reporting + exit phase of `lintCommand`: tags issues against `--since`,
 * renders every notice/warning/error row, prints the summary, and applies
 * the failure criteria (`--only-introduced` scoping, `--max-warnings`)
 * by throwing GeneralError. Issues must be non-empty.
 */
async function reportLintOutcome(
  engineDir: string,
  issues: PatchLintIssue[],
  options: LintCommandOptions
): Promise<void> {
  // Diff-scoping: tag each issue as introduced-in-current-task vs
  // cumulative-pre-existing-drift. Never filters — full set still prints
  // and exit code semantics are unchanged — but the per-line prefix and
  // summary make triage trivial on a large patch series.
  const sinceActive = Boolean(options.since);
  if (options.since) {
    const diffFiles = await collectDiffFilePaths(engineDir, options.since);
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

  if (options.maxWarnings !== undefined && warnings.length > options.maxWarnings) {
    outro('Lint failed');
    throw new GeneralError(buildMaxWarningsMessage(warnings.length, options.maxWarnings));
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

  validateLintFlags(options, files);

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
    await lintPerPatch(projectRoot, paths, options);
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
    ctx = await buildPatchQueueContext(paths.patches, config);
  }

  // Ad-hoc explicit-file-list mode evaluates the patch-size rules per
  // owning patch (see `lintOwningPatchSizes`), so suppress the synthetic
  // combined-list size check in the shared pass — otherwise a cross-patch
  // selection synthesises a phantom oversized patch from the file count.
  const fileListMode = files.length > 0 && ctx !== undefined;
  let issues: PatchLintIssue[] = [
    ...(await lintExportedPatch(
      paths.engine,
      filesAffected,
      diff,
      config,
      ctx,
      undefined,
      undefined,
      fileListMode ? { skipPatchSize: true } : undefined
    )),
  ];

  if (files.length > 0 && ctx) {
    issues.push(...(await lintOwningPatchSizes(paths.engine, filesAffected, ctx)));
  }

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

  downgradeAggregateSizeRules(issues, files, ctx);

  if (issues.length === 0) {
    success('No lint issues found.');
    outro('Lint passed');
    return;
  }

  await reportLintOutcome(paths.engine, issues, options);
}

/** Registers the lint command on the CLI program. */
export function registerLint(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const lint = program
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
    .option(
      '--patches <names...>',
      'With --per-patch, lint only the named patches. Accepts repeated flags, comma lists, full filenames/stems, manifest names, category-prefixed slugs, or bare slugs.'
    )
    .option(
      '--max-warnings <n>',
      'Fail when lint reports more than <n> warning(s); use 0 for warning-clean release gates.'
    )
    .option('--no-cache', 'Bypass per-patch lint result cache reads and writes.')
    .action(
      withErrorHandling(
        async (
          paths: string[],
          options: {
            since?: string;
            onlyIntroduced?: boolean;
            perPatch?: boolean;
            patches?: string[];
            maxWarnings?: string;
            cache?: boolean;
          }
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
          if (options.patches !== undefined) {
            lintOptions.patches = options.patches;
          }
          if (options.maxWarnings !== undefined) {
            const maxWarnings = Number(options.maxWarnings);
            if (!Number.isInteger(maxWarnings) || maxWarnings < 0) {
              throw new GeneralError('--max-warnings must be a non-negative integer.');
            }
            lintOptions.maxWarnings = maxWarnings;
          }
          if (options.cache === false) {
            lintOptions.noCache = true;
          }
          await lintCommand(getProjectRoot(), paths, lintOptions);
        }
      )
    );

  const lintCache = lint
    .command('cache')
    .description('Manage the per-patch lint result cache')
    // Commander routes `fireforge lint cache` here even when the operator
    // meant to lint an engine directory literally named `cache`. A bare
    // `lint cache` (no subcommand) used to silently do nothing — make the
    // ambiguity explicit instead of doing the wrong operation quietly.
    .action(
      withErrorHandling(() => {
        info(
          'Nothing to do: "lint cache" manages the lint result cache (try "lint cache clear"). ' +
            'To lint a directory named cache/, disambiguate with a trailing slash: "fireforge lint cache/".'
        );
        return Promise.resolve();
      })
    );
  lintCache
    .command('clear')
    .description('Clear cached per-patch lint results')
    .action(
      withErrorHandling(async () => {
        intro('FireForge Lint Cache');
        await clearPerPatchLintCache(getProjectRoot());
        success('Cleared per-patch lint cache.');
        outro('Lint cache cleared');
      })
    );
}
