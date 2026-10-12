// SPDX-License-Identifier: EUPL-1.2
/**
 * Multi-run orchestration for `fireforge test`, all under the one
 * engine-session lock hold the command already has:
 *
 *  - mixed harness paths run as two consecutive mach invocations, xpcshell
 *    first, with one pre-test build (when `--build`) packaging both halves;
 *  - `--repeat <n>` runs the same selection n times, building once;
 *  - `--negative-control <diff>` applies a reviewed mutation after the
 *    build and right before each dispatch, and restores it after the run.
 *
 * Each sub-run is the ordinary single-run body. Its verdict line is
 * captured rather than printed (see `setVerdictCapture`) and echoed as a
 * `FIREFORGE-RUN:` line, and the invocation ends with one aggregate
 * `FIREFORGE-VERDICT:` line. A request that needs none of this runs the
 * body exactly as before.
 */

import { getProjectPaths } from '../core/config.js';
import {
  type ActiveNegativeControl,
  applyNegativeControl,
  type NegativeControlPaths,
  type NegativeControlPlan,
  planNegativeControl,
  recoverPendingNegativeControl,
  restoreNegativeControl,
} from '../core/negative-control.js';
import { getActiveRunLogPath, writeToActiveRunLog } from '../core/run-log.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { TestFailureError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { info, notice, success } from '../utils/logger.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { classifyTestHarnesses } from './test-modes.js';
import {
  type ControlOutcome,
  deriveControlOutcome,
  describeControlOutcome,
  formatAggregateBody,
  formatRunLine,
  parseCapturedVerdict,
  type SubRunResult,
  worstRun,
} from './test-multi-verdict.js';
import {
  emitAggregateVerdict,
  emitFailVerdict,
  setVerdictCapture,
  verdictEmitted,
} from './test-verdict.js';

/** What the orchestrator asks of one sub-run beyond its paths and options. */
export interface TestRunHooks {
  /**
   * Paths the pre-test build packages and records as coverage when they
   * are wider than this run's own: the union of a mixed invocation's
   * halves, so the second half runs build-less against the same build.
   */
  coveragePaths?: string[];
  /** Runs after every preflight gate and the pre-test build, right before dispatch. */
  beforeDispatch?: () => Promise<void>;
}

/** The single-run body (`runTestCommandBody`), injected to avoid an import cycle. */
export type TestRunBody = (
  paths: string[],
  options: TestOptions,
  hooks: TestRunHooks
) => Promise<void>;

interface PlannedRun {
  repetition: number;
  harness?: 'xpcshell' | 'mochitest';
  paths: string[];
  options: TestOptions;
  hooks: TestRunHooks;
}

function assertMultiRunUsage(testPaths: readonly string[], options: TestOptions): void {
  const flag = options.negativeControl !== undefined ? '--negative-control' : '--repeat';
  if (testPaths.length === 0) {
    throw new InvalidArgumentError(`${flag} needs explicit test paths.`, flag);
  }
  if (options.buildOnly === true || options.canary !== undefined || options.auto === true) {
    throw new InvalidArgumentError(
      `${flag} runs tests, so it cannot be combined with --build-only, --canary or --auto.`,
      flag
    );
  }
}

async function splitHarnesses(
  engineDir: string,
  testPaths: readonly string[],
  options: TestOptions
): Promise<Array<{ harness: 'xpcshell' | 'mochitest'; paths: string[] }> | undefined> {
  // `--build-only` packages a mixed union itself and dispatches nothing.
  if (testPaths.length === 0 || options.buildOnly === true || options.canary !== undefined) {
    return undefined;
  }
  const normalized = testPaths.map((path) => stripEnginePrefix(path).trim());
  const classification = await classifyTestHarnesses(engineDir, normalized);
  if (classification.xpcshell.length === 0 || classification.nonXpcshell.length === 0) {
    return undefined;
  }
  notice(
    `Mixed harnesses: running ${classification.xpcshell.length} xpcshell path(s), then ` +
      `${classification.nonXpcshell.length} browser/mochitest path(s), as two mach invocations ` +
      'under this lock hold' +
      (options.build === true ? ', after one pre-test build that packages both.' : '.')
  );
  return [
    { harness: 'xpcshell', paths: classification.xpcshell },
    { harness: 'mochitest', paths: classification.nonXpcshell },
  ];
}

/** Options for every run after the first: the build and doctor run once. */
function laterRunOptions(options: TestOptions): TestOptions {
  const later = { ...options };
  delete later.build;
  delete later.extendCoverage;
  delete later.refuseUnexportedDrift;
  delete later.doctor;
  return later;
}

async function planRuns(
  engineDir: string,
  testPaths: string[],
  options: TestOptions
): Promise<PlannedRun[] | undefined> {
  const repeat = options.repeat ?? 1;
  const control = options.negativeControl !== undefined;
  if (repeat > 1 || control) assertMultiRunUsage(testPaths, options);
  const halves = await splitHarnesses(engineDir, testPaths, options);
  if (halves === undefined && repeat === 1 && !control) return undefined;
  const groups: Array<{ harness?: 'xpcshell' | 'mochitest'; paths: string[] }> = halves ?? [
    { paths: testPaths },
  ];
  const union = halves?.flatMap((half) => half.paths);
  const runs: PlannedRun[] = [];
  for (let repetition = 1; repetition <= repeat; repetition += 1) {
    for (const group of groups) {
      const first = runs.length === 0;
      runs.push({
        repetition,
        ...(group.harness === undefined ? {} : { harness: group.harness }),
        paths: group.paths,
        options: first ? options : laterRunOptions(options),
        hooks: first && union !== undefined ? { coveragePaths: union } : {},
      });
    }
  }
  return runs;
}

function writeRunLine(line: string): void {
  process.stdout.write(`${line}\n`);
  writeToActiveRunLog(`${line}\n`);
}

/** State of one control across a sub-run, so restore can find what apply did. */
interface ControlSlot {
  applied?: ActiveNegativeControl;
}

function controlHook(
  paths: NegativeControlPaths,
  plan: NegativeControlPlan,
  slot: ControlSlot
): () => Promise<void> {
  return async () => {
    slot.applied = await applyNegativeControl(paths, plan);
    notice(
      `Negative control applied to ${plan.targets.map((target) => `engine/${target.enginePath}`).join(', ')}; ` +
        'it stays in place until this run has finished.'
    );
  };
}

/**
 * Throws the invocation's error after the aggregate verdict, or returns
 * when the invocation succeeded (all runs green, or a control caught).
 */
function finishInvocation(
  results: readonly SubRunResult[],
  plannedTotal: number,
  control: ControlOutcome | undefined
): void {
  if (control !== undefined) info(describeControlOutcome(control));
  if (control === 'caught') {
    success('Negative control caught.');
    return;
  }
  if (control === 'missed') {
    throw new TestFailureError(
      'Negative control stayed green: no run went red with the mutation applied, so the selected tests do not detect it.',
      'mach test',
      undefined,
      getActiveRunLogPath()
    );
  }
  const worst = worstRun(results);
  if (worst === undefined) return;
  if (worst.reason === 'preflight' || worst.reason === 'inconclusive') {
    throw worst.error instanceof Error
      ? worst.error
      : new GeneralError(`Run ${results.indexOf(worst) + 1} was refused.`);
  }
  const failing = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.passed)
    .map(({ result, index }) => `run ${index + 1} (${result.reason ?? 'failed'})`);
  throw new TestFailureError(
    `${failing.length} of ${plannedTotal} run(s) did not pass: ${failing.join(', ')}. See each FIREFORGE-RUN line above.`,
    'mach test',
    undefined,
    getActiveRunLogPath()
  );
}

/**
 * Runs `fireforge test` as one or several sub-runs. Always recovers a
 * negative control a killed earlier run left applied, first.
 *
 * @param projectRoot - Project root
 * @param testPaths - The positional test paths
 * @param options - Parsed test options
 * @param body - The single-run body
 * @param onRefusal - Renders a sub-run's preflight refusal and emits its
 *   `FAIL reason=preflight` verdict (captured), as `testCommand` does for a
 *   single run
 */
export async function orchestrateTestRuns(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions,
  body: TestRunBody,
  onRefusal: (error: unknown) => void
): Promise<void> {
  const projectPaths = getProjectPaths(projectRoot);
  const controlPaths: NegativeControlPaths = {
    engineDir: projectPaths.engine,
    fireforgeDir: projectPaths.fireforgeDir,
  };
  await recoverPendingNegativeControl(controlPaths);
  const runs = await planRuns(projectPaths.engine, testPaths, options);
  if (runs === undefined) {
    await body(testPaths, options, {});
    return;
  }
  const plan =
    options.negativeControl === undefined
      ? undefined
      : await planNegativeControl(projectRoot, projectPaths.engine, options.negativeControl, {
          deferApplyCheck: options.build === true,
        });

  const results: SubRunResult[] = [];
  let restoreError: unknown;
  for (const [index, run] of runs.entries()) {
    notice(
      `Run ${index + 1}/${runs.length}${run.harness === undefined ? '' : ` (${run.harness})`}` +
        `${plan === undefined ? '' : ', negative control'}: ${run.paths.join(' ')}`
    );
    const capture: { line?: string } = {};
    const slot: ControlSlot = {};
    let error: unknown;
    setVerdictCapture(capture);
    try {
      await body(run.paths, run.options, {
        ...run.hooks,
        ...(plan === undefined ? {} : { beforeDispatch: controlHook(controlPaths, plan, slot) }),
      });
    } catch (caught: unknown) {
      error = caught;
      if (capture.line === undefined) onRefusal(caught);
    } finally {
      setVerdictCapture(undefined);
    }
    // Only a kill writes a real verdict while a capture is installed (see
    // emitKilledVerdict). The invocation is over: restore, start nothing
    // more, print nothing after that line.
    const killed = verdictEmitted();
    if (slot.applied !== undefined) {
      try {
        const restored = await restoreNegativeControl(slot.applied);
        info(`Negative control restored byte-exact: ${restored.restored.length} file(s).`);
      } catch (caught: unknown) {
        restoreError = caught;
      }
    }
    if (killed) throw toError(restoreError ?? error ?? new GeneralError('The run was killed.'));
    const result: SubRunResult = {
      repetition: run.repetition,
      ...(run.harness === undefined ? {} : { harness: run.harness }),
      ...parseCapturedVerdict(capture.line),
      ...(error === undefined ? {} : { error }),
    };
    results.push(result);
    writeRunLine(formatRunLine(result, index, runs.length));
    if (restoreError !== undefined) break;
    if (result.reason === 'preflight' || result.reason === 'inconclusive') break;
  }

  if (restoreError !== undefined) {
    emitFailVerdict('inconclusive', 'negative-control-restore');
    throw toError(restoreError);
  }
  const repetitions = options.repeat ?? 1;
  const control =
    plan === undefined
      ? undefined
      : deriveControlOutcome(results, repetitions, results.length === runs.length);
  emitAggregateVerdict(formatAggregateBody(results, runs.length, control));
  finishInvocation(results, runs.length, control);
}
