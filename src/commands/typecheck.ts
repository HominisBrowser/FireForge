// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge typecheck` — whole-project TypeScript type checking
 * driven by user-supplied jsconfig.json paths.
 *
 * Distinct from `patchLint.checkJs`: that pass is patch-hygiene
 * (scoped to patch-owned `.sys.mjs`, run automatically by
 * `fireforge lint`); this command is CI-grade — it runs whole
 * projects with the user's own compiler options and is intended as
 * a CI gate. The two share their Firefox-globals shim and the same
 * suppressed-diagnostic set so a file that lints clean cannot fail
 * typecheck for a reason the operator could not have inferred from
 * the docs.
 *
 * Exits non-zero on any error-severity diagnostic. Warnings print
 * but do not fail. Designed for CI use.
 */

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { relativeForDisplay, runTypecheck } from '../core/typecheck.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { TypecheckConfig } from '../types/config.js';
import type { TypecheckIssue, TypecheckProjectResult } from '../types/typecheck.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

/** Command-line options Commander forwards from `fireforge typecheck`. */
export interface TypecheckCommandOptions {
  /**
   * Override `typecheck.projects` with a single jsconfig.json path
   * for one-off verification. Replaces (does not augment) the config
   * — useful to re-run a single project after fixing one of its
   * issues without waiting for the full set.
   */
  project?: string;
}

/**
 * Resolves the project list to type-check. `--project` wins over
 * config; if neither is set, throws a clear error pointing at both
 * paths to a fix (add the config field or pass --project).
 */
export function resolveTypecheckProjects(
  configTypecheck: TypecheckConfig | undefined,
  override: string | undefined
): TypecheckConfig {
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new GeneralError('--project requires a non-empty path');
    }
    return {
      projects: [override],
      ...(configTypecheck?.extraShim !== undefined ? { extraShim: configTypecheck.extraShim } : {}),
    };
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
  const codeLabel = issue.code > 0 ? ` TS${String(issue.code)}` : '';
  return `[${issue.project}] ${file}:${String(issue.line)}:${String(issue.column)}${codeLabel} ${issue.message}`;
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

  // Validate project is initialised. `loadConfig` throws on missing
  // fireforge.json — withErrorHandling at the CLI layer renders the
  // resulting `ConfigNotFoundError` cleanly, so we don't need to
  // re-wrap.
  getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);

  const cfg = resolveTypecheckProjects(config.typecheck, options.project);

  info(
    `Running typecheck across ${String(cfg.projects.length)} project(s): ${cfg.projects.join(', ')}`
  );

  const results = await runTypecheck(projectRoot, cfg);
  reportResults(projectRoot, results);
}

/**
 * Prints all issues, computes the per-project + total counts, and
 * throws on errors. Extracted so it can be exercised directly by
 * the CLI test without spawning a child process.
 */
export function reportResults(
  projectRoot: string,
  results: ReadonlyArray<TypecheckProjectResult>
): void {
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const result of results) {
    const errors = result.issues.filter((i) => i.category === 'error');
    const warnings = result.issues.filter((i) => i.category === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;

    for (const issue of warnings) warn(formatIssue(projectRoot, issue));
    for (const issue of errors) warn(formatIssue(projectRoot, issue));
  }

  const summary = `Typecheck: ${String(totalErrors)} error(s), ${String(totalWarnings)} warning(s) across ${String(results.length)} project(s)`;
  if (totalErrors === 0) {
    success(summary);
    outro(totalWarnings > 0 ? 'Typecheck passed with warnings' : 'Typecheck passed');
    return;
  }

  info(summary);
  outro('Typecheck failed');
  throw new GeneralError(
    `Typecheck found ${String(totalErrors)} error(s) across ${String(results.length)} project(s).`
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
    .action(
      withErrorHandling(async (options: { project?: string }) => {
        const opts: TypecheckCommandOptions = {};
        if (options.project !== undefined) {
          opts.project = options.project;
        }
        await typecheckCommand(getProjectRoot(), opts);
      })
    );
}
