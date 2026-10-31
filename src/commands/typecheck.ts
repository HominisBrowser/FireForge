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

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import {
  findJsconfigPathsDrift,
  syncJsconfigPaths,
  typecheckJsconfigList,
} from '../core/furnace-jsconfig.js';
import { syncFurnaceTagMap } from '../core/furnace-tag-map.js';
import { withPrivateGitIndex } from '../core/git-readonly-index.js';
import { buildPatchQueueContext } from '../core/patch-lint.js';
import { relativeForDisplay, runTypecheck } from '../core/typecheck.js';
import { explainTypecheckFile } from '../core/typecheck-explain.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectPaths, TypecheckConfig } from '../types/config.js';
import type { TypecheckIssue, TypecheckProjectResult } from '../types/typecheck.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, message, outro, success, warn } from '../utils/logger.js';
import { buildPerRunCheckJs } from './lint-per-run-checkjs.js';
import { formatTypecheckExplanation } from './typecheck-explain.js';

/** Command-line options Commander forwards from `fireforge typecheck`. */
export interface TypecheckCommandOptions {
  /**
   * Override `typecheck.projects` with a single jsconfig.json path
   * for one-off verification. Replaces (does not augment) the config,
   * which is useful to re-run a single project after fixing one of its
   * issues without waiting for the full set.
   */
  project?: string;
  /**
   * Build every project from scratch and write no incremental build info
   * (`--no-cache`).
   */
  noCache?: boolean;
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
  override: string | undefined
): TypecheckConfig {
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new InvalidArgumentError('--project requires a non-empty path', '--project');
    }
    // Every other setting carries over (`extraShim`, the matching
    // `projectOverrides` entry, `litTypes`, `undefinedIdentifiers`), so a
    // one-off run checks the project exactly as the configured run does.
    return { ...configTypecheck, projects: [override] };
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

  // Read-only to the operator, an index WRITER to git without this scope:
  // the Furnace jsconfig reconciler and the project resolution
  // below touch `engine/`, and any git plumbing they reach would refresh
  // the primary checkout's index under a concurrent `fireforge test`.
  return withPrivateGitIndex(getProjectPaths(projectRoot).engine, () =>
    runTypecheckCommandBody(projectRoot, options)
  );
}

async function runTypecheckCommandBody(
  projectRoot: string,
  options: TypecheckCommandOptions
): Promise<void> {
  // Validate project is initialised. `loadConfig` throws on missing
  // fireforge.json, and withErrorHandling at the CLI layer renders the
  // resulting `ConfigNotFoundError` cleanly, so we don't need to
  // re-wrap.
  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);

  if (options.explain !== undefined) {
    await explainFile(paths, config, options);
    return;
  }

  const cfg = resolveTypecheckProjects(config.typecheck, options.project);

  // Regenerate a stale Furnace-managed jsconfig before running: the generated
  // `compilerOptions.paths` shim drifts when components are added or renamed
  // without a re-deploy, and a stale shim reports type errors in files the
  // session never touched. Run the same reconciler `furnace deploy`/`sync`
  // use so typecheck checks against the current workspace.
  await regenerateStaleGeneratedJsconfig(projectRoot);

  info(`Running typecheck across ${cfg.projects.length} project(s): ${cfg.projects.join(', ')}`);

  const results = await runTypecheck(projectRoot, cfg, {
    ...(options.noCache === true ? { noCache: true } : {}),
  });
  // Fold the EXPORT-TIME authority into this pass. Per-patch lint runs
  // checkJs over the queue's patch-owned modules in relative isolation and
  // resolves imported typedefs differently from the whole-project pass, so
  // `typecheck` can report 0 errors across every project while the very next
  // `export` fails per-patch lint with `checkjs-type-error` findings. Two
  // authorities that disagree, with the stricter one speaking only at export
  // time, is not a usable CI gate: running both here makes `typecheck` green
  // MEAN export-clean types.
  const patchIssues = await collectPatchLintCheckJsIssues(projectRoot);
  reportResults(projectRoot, results, patchIssues);
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
async function collectPatchLintCheckJsIssues(projectRoot: string): Promise<PatchLintIssue[]> {
  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  if (config.patchLint?.checkJs !== true) return [];
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
 */
async function regenerateStaleGeneratedJsconfig(projectRoot: string): Promise<void> {
  if (!(await furnaceConfigExists(projectRoot))) return;
  const furnaceConfig = await loadFurnaceConfig(projectRoot);
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
 * Prints all issues, computes the per-project + total counts, and
 * throws on errors. Extracted so it can be exercised directly by
 * the CLI test without spawning a child process.
 */
export function reportResults(
  projectRoot: string,
  results: ReadonlyArray<TypecheckProjectResult>,
  patchLintIssues: ReadonlyArray<PatchLintIssue> = []
): void {
  let totalErrors = 0;
  let totalWarnings = 0;
  // Per-patch checkJs findings are reported in the SAME tally: a split
  // report would let an operator read "0 errors" off the project summary
  // and still be refused at export.
  for (const issue of patchLintIssues) {
    if (issue.severity === 'error') totalErrors += 1;
    else totalWarnings += 1;
    warn(`[per-patch ${issue.check}] ${issue.file}: ${issue.message}`);
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
      ? ` (including ${patchLintIssues.length} per-patch checkJs finding(s))`
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
      'Override typecheck.projects with a single jsconfig.json path (one-off run)'
    )
    .option(
      '--no-cache',
      'Check every project from scratch; neither read nor write the incremental build info in .fireforge/typecheck/'
    )
    .option(
      '--explain <file>',
      'Run no check; print which typecheck projects include <file> and with which shim settings, ' +
        'and whether a per-patch checkJs program checks it (owning patch, heads, resolvable ' +
        'modules, imports typed any)'
    )
    .action(
      withErrorHandling(
        async (options: { project?: string; cache?: boolean; explain?: string }) => {
          const opts: TypecheckCommandOptions = {};
          if (options.project !== undefined) {
            opts.project = options.project;
          }
          if (options.cache === false) {
            opts.noCache = true;
          }
          if (options.explain !== undefined) {
            opts.explain = options.explain;
          }
          await typecheckCommand(getProjectRoot(), opts);
        }
      )
    );
}
