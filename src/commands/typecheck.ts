// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge typecheck`: whole-project TypeScript type checking driven by
 * user-supplied jsconfig.json paths.
 *
 * Distinct from `patchLint.checkJs`: that pass is patch-hygiene (scoped to
 * patch-owned `.sys.mjs`, run automatically by `fireforge lint`). This
 * command is CI-grade: it runs whole projects with the user's own compiler
 * options. The two share their Firefox-globals shim and the same
 * suppressed-diagnostic set so a file that lints clean cannot fail typecheck
 * for a reason the operator could not have inferred from the docs.
 *
 * Exits non-zero on any error-severity diagnostic. Warnings print but do not
 * fail.
 */

import { Command, Option } from 'commander';

import { assertSourcePath } from '../core/authored/paths.js';
import {
  authoredGateContext,
  checkAuthoredTypes,
  type SourceGateContext,
} from '../core/authored-gates.js';
import { resolveSourceScope } from '../core/authored-scope.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import {
  findJsconfigPathsDrift,
  GENERATED_TYPES_REMEDY,
  syncJsconfigPaths,
  typecheckJsconfigList,
} from '../core/furnace-jsconfig.js';
import { syncFurnaceTagMap } from '../core/furnace-tag-map.js';
import { withPrivateGitIndex } from '../core/git-readonly-index.js';
import { recordDerivedOutput } from '../core/jobs/derived.js';
import { buildPatchQueueContext } from '../core/patch-lint.js';
import { relativeForDisplay, runTypecheck } from '../core/typecheck.js';
import { explainTypecheckFile } from '../core/typecheck-explain.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectPaths, TypecheckConfig } from '../types/config.js';
import type { FurnaceConfig } from '../types/furnace.js';
import type { TypecheckIssue, TypecheckProjectResult } from '../types/typecheck.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, message, notice, outro, success, warn } from '../utils/logger.js';
import { buildPerRunCheckJs } from './lint-per-run-checkjs.js';
import { formatTypecheckExplanation } from './typecheck-explain.js';

/** Command-line options Commander forwards from `fireforge typecheck`. */
export interface TypecheckCommandOptions {
  /** Strict source-scoped feedback; complete project type proof remains required. */
  sourceFiles?: string[];
  /**
   * Override `typecheck.projects` with these jsconfig.json paths (`--project`,
   * repeatable). Replaces (does not augment) the config: a one-off re-run of
   * one project after a fix, or a task's proof typing only the projects its
   * change reaches.
   */
  project?: string | readonly string[];
  /**
   * Explain how both passes see this file instead of running a check
   * (`--explain <file>`).
   */
  explain?: string;
}

/**
 * Resolves the project list to type-check. `--project` wins over
 * config. If neither is set, throws a clear error pointing at both
 * paths to a fix (add the config field or pass --project).
 */
export function resolveTypecheckProjects(
  configTypecheck: TypecheckConfig | undefined,
  override: string | readonly string[] | undefined
): TypecheckConfig {
  if (override !== undefined) {
    const projects = typeof override === 'string' ? [override] : [...override];
    if (projects.length === 0 || projects.some((project) => project.trim() === '')) {
      throw new InvalidArgumentError('--project requires a non-empty path', '--project');
    }
    // Every other setting carries over (`extraShim`, the matching
    // `projectOverrides` entry, `litTypes`, `undefinedIdentifiers`), so a
    // one-off run checks each project exactly as the configured run does.
    return { ...configTypecheck, projects: [...new Set(projects)] };
  }
  if (!configTypecheck) {
    throw new GeneralError(
      'No typecheck configuration found. Add a "typecheck": { "projects": [...] } block to ' +
        'fireforge.json, or pass --project <path> for a one-off run.'
    );
  }
  return configTypecheck;
}

/**
 * Formats a single issue for CLI display. `[<project>] <file>:<line>:<col> TS<code> <message>`
 * matches the format `tsc -p` produces with `--pretty false`, so output
 * piped into editor jump-lists works without per-tool tweaks.
 */
function formatIssue(projectRoot: string, issue: TypecheckIssue): string {
  const file = relativeForDisplay(projectRoot, issue.file);
  const codeLabel = issue.code > 0 ? ` TS${issue.code}` : '';
  return `[${issue.project}] ${file}:${issue.line}:${issue.column}${codeLabel} ${issue.message}`;
}

/**
 * Top-level entry point invoked by the registered Commander action.
 * Loads config, resolves projects, runs typecheck, prints the result,
 * and throws `GeneralError` to set a non-zero exit on errors.
 */
export async function typecheckCommand(
  projectRoot: string,
  options: TypecheckCommandOptions
): Promise<void> {
  intro('FireForge typecheck');
  const config = await loadConfig(projectRoot);
  if (config.sources) return runTypecheckCommandBody(projectRoot, options, config);

  // Read-only to the operator, an index WRITER to git without this scope:
  // the Furnace jsconfig reconciler and the project resolution
  // below touch `engine/`, and any git plumbing they reach would refresh
  // the primary checkout's index under a concurrent `fireforge test`.
  return withPrivateGitIndex(getProjectPaths(projectRoot).engine, () =>
    runTypecheckCommandBody(projectRoot, options, config)
  );
}

async function runTypecheckCommandBody(
  projectRoot: string,
  options: TypecheckCommandOptions,
  config: FireForgeConfig
): Promise<void> {
  // Validate project is initialised. `loadConfig` throws on missing
  // fireforge.json, and withErrorHandling at the CLI layer renders the
  // resulting `ConfigNotFoundError` cleanly, so we don't need to
  // re-wrap.
  const paths = getProjectPaths(projectRoot);

  if (options.sourceFiles !== undefined) {
    if (!config.sources || options.sourceFiles.length === 0 || options.project || options.explain)
      throw new InvalidArgumentError(
        '--source-files requires authored mode and cannot combine with --project or --explain.',
        '--source-files'
      );
    options.sourceFiles.forEach((path) => {
      assertSourcePath(path);
    });
    const context = await authoredGateContext(projectRoot);
    const scope = resolveSourceScope(
      context.snapshot.files.map((file) => file.path),
      options.sourceFiles,
      '--source-files'
    );
    info(`Checking ${scope.size} source file(s) selected by --source-files.`);
    const issues = await checkAuthoredTypes(context, scope);
    reportResults(projectRoot, [], issues, 'authored scope');
    return;
  }

  if (options.explain !== undefined) {
    await explainFile(paths, config, options);
    return;
  }

  // Source mode outside a job judges a private view of a snapshot: it has no
  // engine to read and no admitted phase to record generated outputs under. The
  // view holds no pristine files, so a project's own program, which reads upstream
  // through `engine/`, would report every upstream symbol as missing. Unless one was
  // named, those programs wait for a slot, and the result says so.
  const view =
    config.sources && process.env['FIREFORGE_JOB_ID'] === undefined
      ? await authoredGateContext(projectRoot)
      : undefined;
  if (view !== undefined && options.project === undefined) {
    if (config.typecheck?.projects.length) {
      notice(
        `Strict source typing only: ${config.typecheck.projects.join(', ')} need the full engine a slot has, and run in "fireforge job run --check".`
      );
    }
    reportResults(view.projectRoot, [], await checkAuthoredTypes(view), 'authored source');
    return;
  }
  const cfg = resolveTypecheckProjects(config.typecheck, options.project);
  const checkedRoot = view?.projectRoot ?? projectRoot;

  // Regenerate a stale Furnace-managed jsconfig before running: the generated
  // `compilerOptions.paths` shim drifts when components are added or renamed
  // without a re-deploy, and a stale shim reports type errors in files the
  // session never touched. Run the same reconciler `furnace deploy`/`sync`
  // use so typecheck checks against the current workspace. A source-mode job
  // judges the committed copies instead.
  await regenerateStaleGeneratedJsconfig(checkedRoot, config.sources !== undefined && !view);

  info(`Running typecheck across ${cfg.projects.length} project(s): ${cfg.projects.join(', ')}`);

  const results = await runTypecheck(checkedRoot, cfg);
  // Fold the EXPORT-TIME authority into this pass. Per-patch lint runs
  // checkJs over the queue's patch-owned modules in relative isolation and
  // resolves imported typedefs differently from the whole-project pass, so
  // `typecheck` can report 0 errors across every project while the very next
  // `export` fails per-patch lint with `checkjs-type-error` findings. Two
  // authorities that disagree, with the stricter one speaking only at export
  // time, is not a usable CI gate: running both here makes `typecheck` green
  // MEAN export-clean types.
  const patchIssues = await collectPatchLintCheckJsIssues(projectRoot, view);
  reportResults(
    checkedRoot,
    results,
    patchIssues,
    config.sources ? 'authored source' : 'per-patch'
  );
}

/**
 * `--explain <file>`: prints which programs see the file and how, then
 * stops. Read-only: no check runs and the Furnace jsconfigs are not
 * regenerated.
 */
async function explainFile(
  paths: ProjectPaths,
  config: FireForgeConfig,
  options: TypecheckCommandOptions
): Promise<void> {
  const file = options.explain ?? '';
  if (file.trim() === '') {
    throw new InvalidArgumentError('--explain requires a file path', '--explain');
  }
  const typecheck =
    options.project !== undefined || config.typecheck !== undefined
      ? resolveTypecheckProjects(config.typecheck, options.project)
      : undefined;
  const explanation = await explainTypecheckFile(paths, config, typecheck, file);
  for (const [title, lines] of formatTypecheckExplanation(explanation)) {
    message(lines.length > 0 ? `${title}\n${lines.join('\n')}` : title);
  }
  outro('Explained; no check ran');
}

/**
 * Runs the per-patch-lint checkJs pass (the same program `export` and
 * `lint --per-patch` use) and returns its findings.
 *
 * Returns an empty list when `patchLint.checkJs` is off or the project has
 * no patch queue: there is no second authority to reconcile then.
 */
async function collectPatchLintCheckJsIssues(
  projectRoot: string,
  view: SourceGateContext | undefined
): Promise<PatchLintIssue[]> {
  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  if (config.patchLint?.checkJs !== true) return [];
  if (config.sources) return checkAuthoredTypes(view ?? (await authoredGateContext(projectRoot)));
  if (!(await pathExists(paths.patches))) return [];

  const ctx = await buildPatchQueueContext(paths.patches, config);
  const checkJs = buildPerRunCheckJs(projectRoot, paths, config, ctx);
  if (checkJs === undefined) return [];

  info('Also running the per-patch checkJs pass (the authority `export` enforces).');
  const grouped = await checkJs.getGrouped();
  return [...grouped.global, ...[...grouped.byFile.values()].flat()];
}

/**
 * Staleness-checks and regenerates each Furnace-managed jsconfig
 * (`furnace.json` → `typecheckJsconfig`) and the tag map
 * (`typecheckTagMap`) before typecheck runs. No-op when the project has no
 * furnace.json or configures neither.
 * A missing `typecheckJsconfig` file surfaces the reconciler's own clear
 * error rather than producing phantom type diagnostics.
 *
 * @param projectRoot - Root to reconcile: the checkout, a slot, or a private view
 * @param recordDerived - This is an admitted job phase, which records what it derives
 */
async function regenerateStaleGeneratedJsconfig(
  projectRoot: string,
  recordDerived: boolean
): Promise<void> {
  if (!(await furnaceConfigExists(projectRoot))) return;
  const furnaceConfig = await loadFurnaceConfig(projectRoot);
  if (recordDerived) {
    await recordCommittedGeneratedTypes(projectRoot, furnaceConfig);
    return;
  }
  for (const jsconfig of typecheckJsconfigList(furnaceConfig)) {
    const drift = await findJsconfigPathsDrift(projectRoot, furnaceConfig, jsconfig);
    if (!drift.changed) continue;
    info(
      `Regenerating stale generated jsconfig ${jsconfig} before typecheck ` +
        `(+${drift.added.length} added, ~${drift.updated.length} updated, ` +
        `-${drift.pruned.length} pruned).`
    );
    await syncJsconfigPaths(projectRoot, furnaceConfig, jsconfig);
  }
  const tagMap = await syncFurnaceTagMap(projectRoot, furnaceConfig, { dryRun: true });
  if (tagMap?.changed === true) {
    info(`Regenerating stale generated tag map ${tagMap.file} before typecheck.`);
    await syncFurnaceTagMap(projectRoot, furnaceConfig);
  }
}

/**
 * Source mode: the committed copies are what every slot gets, so a job
 * types against them as captured and records them as its derived outputs.
 * A stale one is left alone and named here; `furnace validate` fails on it.
 */
async function recordCommittedGeneratedTypes(
  projectRoot: string,
  furnaceConfig: FurnaceConfig
): Promise<void> {
  for (const jsconfig of typecheckJsconfigList(furnaceConfig)) {
    if ((await findJsconfigPathsDrift(projectRoot, furnaceConfig, jsconfig)).changed) {
      warn(`${jsconfig} is out of date with the component workspace. ${GENERATED_TYPES_REMEDY}`);
      continue;
    }
    await recordDerivedOutput(projectRoot, jsconfig, { generatorVersion: 'furnace-jsconfig-v1' });
  }
  const tagMap = await syncFurnaceTagMap(projectRoot, furnaceConfig, { dryRun: true });
  if (tagMap === undefined) return;
  if (tagMap.changed) {
    warn(
      `${tagMap.file} ${tagMap.missing ? 'is not in the captured source' : 'is out of date with the component workspace'}. ${GENERATED_TYPES_REMEDY}`
    );
    return;
  }
  await recordDerivedOutput(projectRoot, tagMap.file, { generatorVersion: 'furnace-tag-map-v1' });
}

/**
 * Prints all issues, computes the per-project + total counts, and
 * throws on errors. Extracted so it can be exercised directly by
 * the CLI test without spawning a child process.
 */
export function reportResults(
  projectRoot: string,
  results: ReadonlyArray<TypecheckProjectResult>,
  patchLintIssues: ReadonlyArray<PatchLintIssue> = [],
  sourceLabel = 'per-patch'
): void {
  let totalErrors = 0;
  let totalWarnings = 0;
  // Per-patch checkJs findings are reported in the SAME tally: a split
  // report would let an operator read "0 errors" off the project summary
  // and still be refused at export.
  for (const issue of patchLintIssues) {
    if (issue.severity === 'error') totalErrors += 1;
    else totalWarnings += 1;
    warn(`[${sourceLabel} ${issue.check}] ${issue.file}: ${issue.message}`);
  }
  for (const result of results) {
    const errors = result.issues.filter((i) => i.category === 'error');
    const warnings = result.issues.filter((i) => i.category === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;

    for (const issue of warnings) warn(formatIssue(projectRoot, issue));
    for (const issue of errors) warn(formatIssue(projectRoot, issue));
  }

  const summary =
    `Typecheck: ${totalErrors} error(s), ${totalWarnings} warning(s) across ` +
    `${results.length} project(s)` +
    (patchLintIssues.length > 0
      ? ` (including ${patchLintIssues.length} ${sourceLabel} checkJs finding(s))`
      : '');
  if (totalErrors === 0) {
    success(summary);
    outro(totalWarnings > 0 ? 'Typecheck passed with warnings' : 'Typecheck passed');
    return;
  }

  info(summary);
  outro('Typecheck failed');
  throw new GeneralError(
    `Typecheck found ${totalErrors} error(s) across ${results.length} project(s).`
  );
}

/**
 * Registers the `typecheck` command on the CLI program.
 */
export function registerTypecheck(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('typecheck')
    .description(
      'Run TypeScript type checking against project-owned jsconfig.json files (CI-grade, whole-project)'
    )
    .option(
      '--project <path>',
      'Override typecheck.projects with this jsconfig.json path; repeat to check several',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value]
    )
    .option(
      '--source-files <paths...>',
      'Strict authored source-scoped feedback with the complete resolution universe; full project proof remains required'
    )
    .option(
      '--explain <file>',
      'Run no check; print which typecheck projects include <file> and with which shim settings, ' +
        'and whether a per-patch checkJs program checks it (owning patch, heads, resolvable ' +
        'modules, imports typed any)'
    )
    .addOption(new Option('--no-cache', 'Accepted and ignored').hideHelp())
    .action(
      withErrorHandling(
        async (options: {
          project?: string[];
          explain?: string;
          sourceFiles?: string[];
          cache?: boolean;
        }) => {
          if (options.cache === false) info('--no-cache has no effect: typecheck keeps no cache.');
          const opts: TypecheckCommandOptions = {};
          if (options.sourceFiles !== undefined) opts.sourceFiles = options.sourceFiles;
          if (options.project !== undefined) {
            opts.project = options.project;
          }
          if (options.explain !== undefined) {
            opts.explain = options.explain;
          }
          await typecheckCommand(getProjectRoot(), opts);
        }
      )
    );
}
