// SPDX-License-Identifier: EUPL-1.2
import { type Finding, type LintReport, runLint, type TokenPolicy } from '../lint/index.js';
import type { ChangeGroup } from '../project/index.js';
import { engineFiles, textChangeSet, type TextStep } from './changes.js';
import { testConfig } from './config.js';

/** What {@link lintSteps} lints besides the steps. */
export interface LintStepsOptions {
  readonly groups?: readonly (string | ChangeGroup)[];
  /** Root keys of fireforge.json. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Engine files around the changes. */
  readonly engine?: Readonly<Record<string, string>>;
  readonly sequential?: boolean;
  readonly tokens?: TokenPolicy;
  readonly paths?: readonly string[];
  readonly projectRoot?: string;
  readonly cacheDir?: string;
}

/**
 * Lints text steps and returns the report.
 *
 * @param steps - The owned changes
 * @param options - See {@link LintStepsOptions}
 */
export function lintReport(
  steps: readonly TextStep[],
  options: LintStepsOptions = {}
): Promise<LintReport> {
  return runLint(
    textChangeSet(steps, options.groups),
    engineFiles(options.engine),
    testConfig(options.config),
    {
      projectRoot: options.projectRoot ?? '/nonexistent-project',
      ...(options.sequential === undefined ? {} : { sequential: options.sequential }),
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    }
  );
}

/**
 * Lints text steps and returns the surfaced findings of the given rules.
 *
 * @param rules - Rule IDs to keep
 * @param steps - The owned changes
 * @param options - See {@link LintStepsOptions}
 */
export async function lintSteps(
  rules: readonly string[],
  steps: readonly TextStep[],
  options: LintStepsOptions = {}
): Promise<Finding[]> {
  const report = await lintReport(steps, options);
  return report.findings.filter((finding) => rules.includes(finding.rule));
}
