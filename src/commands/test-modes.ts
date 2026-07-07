// SPDX-License-Identifier: EUPL-1.2
import { loadConfig } from '../core/config.js';
import { GeneralError } from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import { success } from '../utils/logger.js';
import type { TestRunOutcome } from './test-run.js';

type ProjectConfig = Awaited<ReturnType<typeof loadConfig>>;

/** Rejects pathless `fireforge test` unless the operator selected a pathless mode. */
export function assertPathlessTestMode(testPaths: readonly string[], options: TestOptions): void {
  if (
    testPaths.length === 0 &&
    options.auto !== true &&
    options.doctor !== true &&
    options.canary === undefined
  ) {
    throw new GeneralError(buildPathlessTestMessage());
  }
}

/** Rejects invalid combinations for mode-like `fireforge test` options. */
export function assertTestModeCombinations(
  testPaths: readonly string[],
  options: TestOptions,
  canaryPath: string | undefined
): void {
  if (options.auto === true && testPaths.length > 0) {
    throw new GeneralError(
      '`fireforge test --auto` is valid only when no explicit paths are provided.'
    );
  }
  if (options.canary !== undefined && testPaths.length > 0) {
    throw new GeneralError(
      '`fireforge test --canary` runs one canary path; do not pass positional test paths.'
    );
  }
  if (options.canary !== undefined && canaryPath === undefined) {
    throw new GeneralError(
      'No test canary path is configured.\n\n' +
        'Pass `fireforge test --canary <path>` or set `test.canaryPath` in fireforge.json.'
    );
  }
}

/** Resolves the canary path from CLI or config. */
export function resolveCanaryPath(
  options: TestOptions,
  projectConfig: ProjectConfig
): string | undefined {
  if (options.canary === undefined || options.canary === false) return undefined;
  if (typeof options.canary === 'string') return options.canary;
  return projectConfig.test?.canaryPath;
}

/** Returns the configured canary no-output budget, defaulting to 60 seconds. */
export function canaryTimeoutSeconds(projectConfig: ProjectConfig): number {
  return projectConfig.test?.canaryTimeoutSeconds ?? 60;
}

/** Emits or throws the one-word canary verdict. */
export function reportCanaryOutcome(outcome: TestRunOutcome): void {
  if (outcome.verdict.kind === 'tests-ran-ok') {
    success('Canary: green');
    return;
  }
  if (
    outcome.verdict.kind === 'harness-crash' &&
    outcome.verdict.signature?.reason.includes('no-output timeout')
  ) {
    throw new GeneralError(`Canary: hang\n\n${outcome.verdict.signature.line}`);
  }
  if (outcome.verdict.kind === 'harness-crash') {
    throw new GeneralError(
      `Canary: crash\n\n${outcome.verdict.signature ? outcome.verdict.signature.line : 'Harness crashed before the canary completed.'}`
    );
  }
  throw new GeneralError(
    'Canary: crash\n\nThe canary did not complete green; see mach output above.'
  );
}

function buildPathlessTestMessage(): string {
  return (
    '`fireforge test` now requires an explicit test path unless you choose a pathless mode.\n\n' +
    'Use one of:\n' +
    '  - `fireforge test <engine-relative test path>` for focused runs\n' +
    "  - `fireforge test --auto` to forward mach's own auto-selection mode\n" +
    '  - `fireforge test --doctor` to run the Marionette preflight only\n' +
    '  - `fireforge test --canary` to run the configured short harness canary'
  );
}
