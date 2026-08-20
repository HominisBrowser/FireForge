// SPDX-License-Identifier: EUPL-1.2
import { loadConfig } from '../core/config.js';
import { findNearestXpcshellManifest } from '../core/xpcshell-appdir.js';
import { GeneralError } from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import { info, success } from '../utils/logger.js';
import type { TestRunOutcome } from './test-run.js';
import { emitHarnessVerdict } from './test-verdict.js';

type ProjectConfig = Awaited<ReturnType<typeof loadConfig>>;

/** Rejects pathless `fireforge test` unless the operator selected a pathless mode. */
export function assertPathlessTestMode(testPaths: readonly string[], options: TestOptions): void {
  if (
    testPaths.length === 0 &&
    options.auto !== true &&
    options.doctor !== true &&
    options.buildOnly !== true &&
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
  if (
    options.buildOnly === true &&
    (options.doctor === true || options.canary !== undefined || options.auto === true)
  ) {
    throw new GeneralError(
      '`fireforge test --build-only` builds and exits without dispatching tests; it cannot be combined with --doctor, --canary, or --auto.'
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
  // Written raw as the run's last stdout line on green and throw paths
  // alike — see the FIREFORGE-VERDICT contract in test-harness-crash.ts.
  try {
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
  } finally {
    emitHarnessVerdict(outcome.verdict);
  }
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

/** Per-harness bucketing of the requested test paths. */
export interface HarnessClassification {
  xpcshell: string[];
  nonXpcshell: string[];
}

async function classifyTestHarnesses(
  engineDir: string,
  normalizedPaths: readonly string[]
): Promise<HarnessClassification> {
  const result: HarnessClassification = { xpcshell: [], nonXpcshell: [] };
  for (const testPath of normalizedPaths) {
    const manifest = await findNearestXpcshellManifest(engineDir, testPath);
    if (manifest) {
      result.xpcshell.push(testPath);
    } else {
      result.nonXpcshell.push(testPath);
    }
  }
  return result;
}

function buildMixedHarnessMessage(classification: HarnessClassification): string {
  return (
    'FireForge cannot run xpcshell and browser/mochitest paths in the same mach invocation.\n\n' +
    'Split this into separate `fireforge test` commands so each manifest selects its own harness:\n' +
    `  - xpcshell: ${classification.xpcshell.join(', ')}\n` +
    `  - browser/mochitest: ${classification.nonXpcshell.join(', ')}`
  );
}

/**
 * Harness classification is a pure path→manifest lookup and must precede
 * the build dispatch: a mixed xpcshell+mochitest request can never
 * dispatch, so refusing it before spending minutes in a pre-test build
 * is strictly better. A nonexistent path classifies as
 * nonXpcshell (findNearestXpcshellManifest returns null), so classifying
 * before assertTestPathsExist is harmless — existence is still asserted
 * after the stale/coverage gates, preserving their precedence over
 * missing-path errors. `xpcshellOnly` (non-empty request, zero
 * nonXpcshell paths) gates the Marionette preflight and the mochitest
 * client flags; pathless runs keep the full-suite behavior.
 */
export async function classifyBeforeDispatch(
  engineDir: string,
  normalizedPaths: string[],
  options?: { allowMixed?: boolean }
): Promise<{ classification: HarnessClassification; xpcshellOnly: boolean }> {
  const classification = await classifyTestHarnesses(engineDir, normalizedPaths);
  if (classification.xpcshell.length > 0 && classification.nonXpcshell.length > 0) {
    // `--build-only` never dispatches, so a mixed request is legal there —
    // packaging the union is the whole point.
    if (options?.allowMixed !== true) {
      throw new GeneralError(buildMixedHarnessMessage(classification));
    }
  }
  return {
    classification,
    xpcshellOnly: normalizedPaths.length > 0 && classification.nonXpcshell.length === 0,
  };
}

/**
 * Prints the `--build-only` completion guidance: the union build is
 * recorded as the packaging-coverage claim, so each harness half can now
 * run build-less without tripping the stale/coverage gate.
 */
export function reportBuildOnlyCompletion(
  classification: HarnessClassification,
  normalizedPaths: readonly string[]
): void {
  info('Build complete. The recorded packaging coverage includes every requested path.');
  if (classification.xpcshell.length > 0 && classification.nonXpcshell.length > 0) {
    info('Run each harness separately without --build:');
    info(`  fireforge test ${classification.xpcshell.join(' ')}`);
    info(`  fireforge test ${classification.nonXpcshell.join(' ')}`);
  } else if (normalizedPaths.length > 0) {
    info(`Run: fireforge test ${normalizedPaths.join(' ')}`);
  }
}
