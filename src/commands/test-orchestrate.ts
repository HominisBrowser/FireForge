// SPDX-License-Identifier: EUPL-1.2
/**
 * Multi-run orchestration for `fireforge test`, all under the one
 * engine-session lock hold the command already has:
 *
 *  - mixed harness paths run as two consecutive mach invocations, xpcshell
 *    first, with one pre-test build (when `--build`) packaging both halves;
 *  - `--repeat <n>` runs the same selection n times, building once;
 *  - `--negative-control <diff>` first dispatches the selection unmutated, then
 *    applies a reviewed mutation after the build and right before each
 *    dispatch, and restores it after the run. Only a selection green without
 *    the mutation can show the mutation is what turned it red.
 *
 * Each sub-run is the ordinary single-run body. Its verdict line is
 * captured rather than printed (see `setVerdictCapture`) and echoed as a
 * `FIREFORGE-RUN:` line, and the invocation ends with one aggregate
 * `FIREFORGE-VERDICT:` line. A request that needs none of this runs the
 * body exactly as before.
 */

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ControlBuildStamp } from '../core/build-baseline-types.js';
import { getProjectPaths } from '../core/config.js';
import { invalidateEngineState } from '../core/engine-state.js';
import {
  type ActiveNegativeControl,
  applyNegativeControl,
  type NegativeControlPaths,
  type NegativeControlPlan,
  planNegativeControl,
  recoverPendingNegativeControl,
  restoreNegativeControl,
  verifyNegativeControlForDispatch,
} from '../core/negative-control.js';
import {
  formatCompiledControlBuildNotice,
  formatCompiledControlRefusal,
} from '../core/negative-control-compiled.js';
import { getActiveRunLogPath, writeToActiveRunLog } from '../core/run-log.js';
import { GeneralError, InvalidArgumentError, PreflightRefusalError } from '../errors/base.js';
import { TestFailureError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import { info, notice, success } from '../utils/logger.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { controlBuildRecorded, runControlRestoreBuild } from './test-control-restore.js';
import { classifyTestHarnesses } from './test-modes.js';
import {
  CONTROL_BASELINE_REPETITION,
  type ControlOutcome,
  deriveControlOutcome,
  describeControlOutcome,
  formatAggregateBody,
  formatBaselineFailureBody,
  formatRunLine,
  parseCapturedVerdict,
  type SubRunResult,
  worstRun,
} from './test-multi-verdict.js';
import { rearmSpentWaits } from './test-prelock.js';
import { recordCompiledControlRestore, recordControlEvidence } from './test-results.js';
import {
  emitAggregateVerdict,
  emitFailVerdict,
  setVerdictCapture,
  setVerdictRunAttribute,
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
  /**
   * Runs right before the pre-test build: a negative control on compiled
   * source, which only reaches the binary when the build compiles it.
   */
  beforeBuild?: () => Promise<void>;
  /**
   * Why the pre-test build must be a full `mach build`: `mach build faster`
   * compiles nothing, so a compiled control's binary needs the full one.
   */
  fullBuildReason?: string;
  /**
   * Stamp the pre-test build records on its baseline because it compiles a
   * negative control in (see `BuildBaseline.controlBuild`).
   */
  controlBuild?: ControlBuildStamp;
  /**
   * The stamp the first run's control build recorded, on every run after
   * it: those runs test the binary that carries the control, with the
   * control applied again, so the build-less gates accept that stamp and
   * the fresh mtimes its restore left on the control's own targets.
   */
  ownControlBuild?: ControlBuildStamp;
  /** A negative control with no `--build` anywhere in this invocation. */
  controlWithoutBuild?: boolean;
  /** `--repeat` run this sub-run is (1-based), for `--results`. */
  repetition?: number;
  /** Where dispatches write their mozlog raw logs (`--results`, `--shard-size`). */
  rawLogDir?: string;
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
  // A later run follows the earlier runs' work under the same lock hold, so
  // its browser and port checks wait out the budgets again.
  const later = { ...rearmSpentWaits(options) };
  delete later.build;
  delete later.extendCoverage;
  delete later.refuseUnexportedDrift;
  delete later.doctor;
  delete later.furnaceApply;
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
        hooks: {
          repetition,
          ...(first && union !== undefined ? { coveragePaths: union } : {}),
        },
      });
    }
  }
  return runs;
}

/**
 * Puts the control's unmutated baseline in front of the mutated runs: one
 * dispatch of each harness half, which takes over the first run's build. A
 * compiled control keeps a build of its own on its first mutated run, since
 * only that build carries the mutation into the binary.
 */
function withControlBaseline(
  runs: readonly PlannedRun[],
  options: TestOptions,
  compiled: boolean
): PlannedRun[] {
  const baseline = runs
    .filter((run) => run.repetition === 1)
    .map((run) => ({
      ...run,
      repetition: CONTROL_BASELINE_REPETITION,
      hooks: { ...run.hooks, repetition: CONTROL_BASELINE_REPETITION },
    }));
  const mutated = runs.map((run, index) => {
    if (index !== 0 || compiled) return run;
    return { ...run, options: laterRunOptions(options), hooks: { repetition: run.repetition } };
  });
  return [...baseline, ...mutated];
}

function writeRunLine(line: string): void {
  process.stdout.write(`${line}\n`);
  writeToActiveRunLog(`${line}\n`);
}

/** State of one control across a sub-run, so restore can find what apply did. */
interface ControlSlot {
  applied?: ActiveNegativeControl;
}

/** Restoration receipts bind to the mutation parsed before dispatch, and reread restored bytes/modes. */
async function restoreWithEvidence(
  control: ActiveNegativeControl,
  run: PlannedRun,
  index: number,
  compiled: boolean
): Promise<void> {
  const restored = await restoreNegativeControl(control);
  invalidateEngineState(control.paths.engineDir);
  const targets = [];
  for (const entry of control.journal.entries) {
    const path = join(control.paths.engineDir, entry.enginePath);
    targets.push({
      path: entry.enginePath,
      originalSha256: entry.originalSha256,
      mutatedSha256: entry.mutatedSha256,
      mode: entry.mode & 0o7777,
      restoredSha256: sha256Hex(await readFile(path)),
      restoredMode: (await lstat(path)).mode & 0o7777,
    });
  }
  recordControlEvidence({
    run: run.repetition,
    dispatch: index + 1,
    ...(run.harness === undefined ? {} : { harness: run.harness }),
    diffDigest: control.diffDigest,
    mutationVerified: control.verifiedForDispatch === true,
    restored: targets.every(
      (target) =>
        target.originalSha256 === target.restoredSha256 && target.mode === target.restoredMode
    ),
    compiled,
    targets,
  });
  if (
    targets.some(
      (target) =>
        target.originalSha256 !== target.restoredSha256 || target.mode !== target.restoredMode
    )
  )
    throw new GeneralError(
      'Negative-control restoration changed before its evidence was captured.'
    );
  info(`Negative control restored byte-exact: ${restored.restored.length} file(s).`);
}

function controlHook(
  paths: NegativeControlPaths,
  plan: NegativeControlPlan,
  slot: ControlSlot,
  verify = true
): () => Promise<void> {
  return async () => {
    slot.applied = await applyNegativeControl(paths, plan);
    invalidateEngineState(paths.engineDir);
    if (verify) await verifyNegativeControlForDispatch(slot.applied);
    notice(
      `Negative control applied to ${plan.targets.map((target) => `engine/${target.enginePath}`).join(', ')}; ` +
        'it stays in place until this run has finished.'
    );
  };
}

/** A planned negative control, as each of its mutated runs needs it. */
interface PlannedControl {
  paths: NegativeControlPaths;
  plan: NegativeControlPlan;
  /** The stamp a compiled control's own build records. */
  stamp?: ControlBuildStamp;
}

/**
 * The hooks of one mutated run. A compiled control goes in before its first run's
 * build, which compiles it; every other mutated run applies it before dispatch.
 */
function controlHooks(
  control: PlannedControl,
  slot: ControlSlot,
  firstMutated: boolean
): TestRunHooks {
  const { paths, plan, stamp } = control;
  if (plan.compiled === undefined || !firstMutated) {
    return {
      beforeDispatch: controlHook(paths, plan, slot),
      ...(stamp === undefined ? {} : { ownControlBuild: stamp }),
    };
  }
  return {
    beforeBuild: controlHook(paths, plan, slot, false),
    beforeDispatch: async () => {
      if (slot.applied === undefined) {
        throw new GeneralError('Compiled control was not applied before build.');
      }
      await verifyNegativeControlForDispatch(slot.applied);
    },
    fullBuildReason: formatCompiledControlBuildNotice(plan.compiled),
    ...(stamp === undefined ? {} : { controlBuild: stamp }),
  };
}

/**
 * Whether the runs after this one would not be comparable: a refusal or an
 * inconclusive run, or a control's baseline that was not green.
 */
function endsInvocation(result: SubRunResult): boolean {
  if (result.reason === 'preflight' || result.reason === 'inconclusive') return true;
  return result.repetition === CONTROL_BASELINE_REPETITION && !result.passed;
}

/** The notice opening one sub-run. */
function describeRun(
  run: PlannedRun,
  mutatedIndex: number,
  plannedTotal: number,
  isControl: boolean
): string {
  const baseline = run.repetition === CONTROL_BASELINE_REPETITION;
  const which = baseline ? 'Baseline run, no mutation' : `Run ${mutatedIndex + 1}/${plannedTotal}`;
  const harness = run.harness === undefined ? '' : ` (${run.harness})`;
  const mutation = isControl && !baseline ? ', negative control' : '';
  return `${which}${harness}${mutation}: ${run.paths.join(' ')}`;
}

/** The invocation's verdict body. A control's baseline is not one of its runs. */
function aggregateBody(
  results: readonly SubRunResult[],
  plannedTotal: number,
  outcome: ControlOutcome | undefined
): string {
  const isBaseline = (result: SubRunResult): boolean =>
    result.repetition === CONTROL_BASELINE_REPETITION;
  const failed = results.find((result) => isBaseline(result) && !result.passed);
  if (failed !== undefined) return formatBaselineFailureBody(failed, plannedTotal);
  return formatAggregateBody(
    results.filter((result) => !isBaseline(result)),
    plannedTotal,
    outcome
  );
}

/** The stamp a compiled control's pre-test build records on its baseline. */
function compiledControlStamp(
  options: TestOptions,
  compiled: readonly string[] | undefined
): ControlBuildStamp | undefined {
  if (compiled === undefined || options.negativeControl === undefined) return undefined;
  return {
    diffFile: options.negativeControl,
    targets: [...compiled],
    appliedAt: new Date().toISOString(),
  };
}

/**
 * After a compiled control was restored, rebuilds the binary that still
 * carries it, when this run's control build recorded its stamp, and
 * stamps `control-restore-build=done|failed` on the verdict.
 */
async function rebuildAfterCompiledControl(
  projectRoot: string,
  stamp: ControlBuildStamp | undefined,
  options: TestOptions
): Promise<'done' | 'failed' | 'not-built'> {
  if (stamp === undefined || !(await controlBuildRecorded(projectRoot, stamp))) return 'not-built';
  const state = await runControlRestoreBuild(projectRoot, stamp, options.harnessRetries);
  setVerdictRunAttribute('control-restore-build', state);
  return state;
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
  const planned = await planRuns(projectPaths.engine, testPaths, options);
  if (planned === undefined) {
    await body(testPaths, options, {});
    return;
  }
  const plan =
    options.negativeControl === undefined
      ? undefined
      : await planNegativeControl(projectRoot, projectPaths.engine, options.negativeControl, {
          deferApplyCheck: options.build === true,
        });
  // A compiled target only reaches the binary through a build, so its
  // control goes in before the first run's pre-test build.
  const compiled = plan?.compiled;
  const compiledControl = compiled !== undefined;
  if (compiledControl) {
    if (options.build !== true) {
      throw new PreflightRefusalError(formatCompiledControlRefusal(compiled), 'negative-control');
    }
    setVerdictRunAttribute('control-build', 'compiled');
  }
  const controlStamp = compiledControlStamp(options, compiled);
  const control: PlannedControl | undefined =
    plan === undefined
      ? undefined
      : {
          paths: controlPaths,
          plan,
          ...(controlStamp === undefined ? {} : { stamp: controlStamp }),
        };
  const runs =
    plan === undefined ? planned : withControlBaseline(planned, options, compiledControl);
  const baselineCount = runs.length - planned.length;
  const controlWithoutBuild = plan !== undefined && options.build !== true;

  const results: SubRunResult[] = [];
  let restoreError: unknown;
  for (const [index, run] of runs.entries()) {
    const isBaseline = run.repetition === CONTROL_BASELINE_REPETITION;
    const mutatedIndex = index - baselineCount;
    notice(describeRun(run, mutatedIndex, planned.length, plan !== undefined));
    const capture: { line?: string } = {};
    const slot: ControlSlot = {};
    let error: unknown;
    setVerdictCapture(capture);
    try {
      await body(run.paths, run.options, {
        ...run.hooks,
        ...(controlWithoutBuild ? { controlWithoutBuild } : {}),
        ...(control === undefined || isBaseline
          ? {}
          : controlHooks(control, slot, mutatedIndex === 0)),
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
        await restoreWithEvidence(slot.applied, run, index, compiledControl);
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
    writeRunLine(formatRunLine(result, mutatedIndex, planned.length));
    if (restoreError !== undefined || endsInvocation(result)) break;
  }

  if (restoreError !== undefined) {
    emitFailVerdict('inconclusive', 'negative-control-restore');
    throw toError(restoreError);
  }
  // The source is back byte-exact, but the binary still carries the
  // compiled control: rebuild it under this same hold (see
  // test-control-restore.ts). Only after every run, since a later
  // `--repeat` run tests the same control-built binary.
  recordCompiledControlRestore(
    await rebuildAfterCompiledControl(projectRoot, controlStamp, options)
  );
  const repetitions = options.repeat ?? 1;
  const outcome =
    plan === undefined
      ? undefined
      : deriveControlOutcome(results, repetitions, results.length === runs.length);
  emitAggregateVerdict(aggregateBody(results, planned.length, outcome));
  finishInvocation(results, runs.length, outcome);
}
