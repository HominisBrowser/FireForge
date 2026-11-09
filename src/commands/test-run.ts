// SPDX-License-Identifier: EUPL-1.2
/**
 * Run orchestration for `fireforge test`: bounded harness-crash retries and
 * sequential per-file sharding of multi-path invocations.
 *
 * Sharding exists because passing several browser-chrome files to one mach
 * invocation destabilizes later files: cross-file profile/pref bleed in the
 * shared mochitest profile makes the second file time out at window-open
 * while each file passes in isolation. Sequential single-file harness runs
 * cost startup time but make results reproducible. The combined invocation
 * stays available via `--no-shard`.
 */

import { dirname, join } from 'node:path';

import {
  createHarnessPortTracker,
  type HarnessPortTracker,
  type HarnessServerPorts,
} from '../core/harness-port-reservation.js';
import { type MachCommandResult, type MachTestSuiteKind, runMachTestSuite } from '../core/mach.js';
import { parentExited } from '../core/parent-exit-watchdog.js';
import { activeRunLogLine, getActiveRunLogPath } from '../core/run-log.js';
import { changedPrefNoiseVerdictNote } from '../core/test-changed-prefs.js';
import {
  classifyHarnessRun,
  type HarnessCrashSignature,
  type HarnessRunVerdict,
  headedDisplayAsleepVerdictNote,
} from '../core/test-harness-crash.js';
import {
  type DisplaySleepState,
  type HostLoadPeak,
  mergeHostAttributes,
  reportLoadPeak,
  reportTestHost,
  sampleTestHost,
  stampPerfHost,
  type TestHostState,
  watchForHostSleep,
  watchHostLoad,
} from '../core/test-host-state.js';
import {
  type CoverageReport,
  finishJsCoverage,
  prepareJsCoverage,
} from '../core/test-js-coverage.js';
import {
  forwardedRawLogPath,
  hasForwardedRawLog,
  type RawTestLog,
  type RawTestResult,
  readRawTestLog,
  summarizeRawLog,
  trimsAnnouncedTests,
} from '../core/test-raw-log.js';
import {
  createStartMarkerTracker,
  type StartMarkerTracker,
  vetoIncompletePass,
} from '../core/test-run-completeness.js';
import { retryAfterXpcshellSymlinkRepair } from '../core/test-xpcshell-retry.js';
import { withXpcshellProfileDir } from '../core/xpcshell-profile-dir.js';
import { TestFailureError } from '../errors/build.js';
import { warn } from '../utils/logger.js';
import { getPlatform } from '../utils/platform.js';
import { maybeInjectAppdirArg } from './test-appdir.js';
import { createHarnessTeardown } from './test-harness-teardown.js';
import { recordTestResults } from './test-results.js';
import {
  getVerdictRunAttribute,
  setVerdictRunAttribute,
  verdictRunStartedAt,
} from './test-verdict.js';

/** Default bounded retry budget for recognized harness crashes. */
export const DEFAULT_HARNESS_RETRIES = 2;

/**
 * Which mach command a run dispatches to. Single-suite runs use the
 * suite-specific command (`mach xpcshell-test` / `mach mochitest`), which
 * skips the mozlog resource monitor that crashes generic `mach test` on a
 * broken host. `generic` is the plain `mach test` path (mixed/all-tests runs,
 * or the `--generic-mach-test` opt-out).
 */
export type TestSuite = 'xpcshell' | 'mochitest' | 'generic';

/** Resolves the mach test command a suite dispatches to. */
function machKindForSuite(suite: TestSuite): MachTestSuiteKind {
  if (suite === 'xpcshell') return 'xpcshell-test';
  if (suite === 'mochitest') return 'mochitest';
  return 'test';
}

/** Inputs shared by every harness invocation in one `fireforge test` run. */
export interface TestRunContext {
  /** Persistent root for unique per-attempt coverage artifacts. */
  coverageDir?: string;
  /** A perf run changed power source; no green result can be trusted. */
  powerChanged?: boolean;
  /** The display state at the end of the latest dispatch. */
  lastDisplayState?: DisplaySleepState;
  engineDir: string;
  objDir: string | undefined;
  classification: { xpcshell: string[]; nonXpcshell: string[] };
  /** Suite-specific dispatch target for this run (E1). */
  suite: TestSuite;
  /** Extra mach args before per-shard appdir injection. */
  baseExtraArgs: readonly string[];
  /** Bounded harness-crash retry budget (0 disables retries). */
  harnessRetries: number;
  /** Whether --headless was requested (crash-hint copy only). */
  headless: boolean;
  /** Extra environment variables for the mach process. */
  env?: Record<string, string>;
  /**
   * Pass full mozbuild verbosity through for the TEST phase, by unsetting
   * the coding-agent markers that quiet it. Off by default.
   */
  fullOutput?: boolean;
  /** `--pgid-file`: where each dispatch publishes its harness process group id. */
  pgidFile?: string | undefined;
  /**
   * Where each dispatch writes its mozlog raw log (`--results`,
   * `--shard-size`). Unset: no `--log-raw` is added and nothing is parsed.
   */
  rawLogDir?: string | undefined;
  /** `--repeat` run this dispatch belongs to (1-based), for `--results`. */
  repetition?: number | undefined;
  /** Prefix for every echoed and logged output line (`--jobs` instances). */
  outputPrefix?: string | undefined;
}

/** Outcome of one (possibly retried) harness invocation. */
export interface TestRunOutcome {
  result: MachCommandResult;
  verdict: HarnessRunVerdict;
  attempts: number;
  /** Whether xpcshell appdir injection was attempted for this invocation. */
  appdirInjectionAttempted: boolean;
  /**
   * Display power state measured for a HEADED no-output stall. Undefined
   * when the shape did not apply and no probe ran.
   */
  displayState?: DisplaySleepState | undefined;
  /** Per-file results from the raw log, when the run wrote one. */
  fileResults?: RawTestResult[] | undefined;
  /**
   * The mochitest server ports the last attempt reported (its "falling
   * back to port" lines), for the shard line's `ports=` key.
   */
  serverPorts?: HarnessServerPorts | undefined;
}

/**
 * Runs one mach test invocation for `paths`, retrying recognized harness
 * crashes up to the configured budget. Every attempt goes through the
 * stale-xpcshell-symlink repair path the single-run flow already used.
 */
export async function runTestsWithRetries(
  ctx: TestRunContext,
  paths: string[],
  label = paths.join(' ')
): Promise<TestRunOutcome> {
  // Pure mochitest dispatches keep their env byte-identical, since the profile
  // variable is xpcshell-harness-specific. Generic `mach
  // test` runs may include xpcshell paths, so they get the isolation too.
  if (ctx.suite === 'mochitest') {
    return runTestsWithRetriesInner(ctx, paths, ctx.env, label);
  }
  // Fresh profile dir per harness invocation: shards isolate from each
  // other and from concurrent `fireforge test` processes. The crash /
  // symlink-repair retries inside one invocation reuse the same directory
  // on purpose (they are the same logical run and the harness
  // re-initialises the profile contents itself).
  return withXpcshellProfileDir(ctx.env, (env) => runTestsWithRetriesInner(ctx, paths, env, label));
}

async function runTestsWithRetriesInner(
  ctx: TestRunContext,
  paths: string[],
  env: Record<string, string> | undefined,
  label: string
): Promise<TestRunOutcome> {
  const extraArgs = [...ctx.baseExtraArgs];
  const appdirInjectionAttempted = await maybeInjectAppdirArg(
    ctx.engineDir,
    paths,
    ctx.objDir,
    extraArgs
  );

  const kind = machKindForSuite(ctx.suite);
  const maxAttempts = Math.max(1, ctx.harnessRetries + 1);
  let attempts = 0;
  let result: MachCommandResult;
  let verdict: HarnessRunVerdict;

  let rawLog: RawTestLog | undefined;
  let logLine: number;
  let portTracker: HarnessPortTracker;

  for (;;) {
    attempts += 1;
    let tracker = createStartMarkerTracker();
    portTracker = createHarnessPortTracker();
    const raw = rawLogDispatchArgs(ctx, extraArgs);
    logLine = activeRunLogLine();
    const dispatched = await runCoverageTrackedSuite({
      ctx,
      kind,
      paths,
      args: raw.args,
      env,
      trackers: [tracker, portTracker],
    });
    result = dispatched;
    // The parent that was reading this run is gone and the watchdog has
    // already killed the harness. Classifying the corpse would call it a
    // harness crash and retry it under nobody's supervision.
    if (parentExited()) {
      throw new TestFailureError(
        'The parent process exited while the harness was running; the harness tree was ' +
          'terminated and the run ended without a result.',
        `mach ${kind}`,
        undefined,
        getActiveRunLogPath()
      );
    }
    const retryTracker = createStartMarkerTracker();
    result = await retryAfterXpcshellSymlinkRepair({
      engineDir: ctx.engineDir,
      objDir: ctx.objDir,
      result,
      classification: ctx.classification,
      normalizedPaths: paths,
      extraArgs: raw.args,
      env,
      kind,
      fullOutput: ctx.fullOutput,
      onOutputChunk: (stream, chunk) => {
        retryTracker.onChunk(stream, chunk);
      },
      dispatch: () =>
        runCoverageTrackedSuite({
          ctx,
          kind,
          paths,
          args: raw.args,
          env,
          trackers: [retryTracker, portTracker],
        }),
    });
    if (result !== dispatched) tracker = retryTracker;
    rawLog = raw.path === undefined ? undefined : await readRawTestLog(raw.path);
    // A trimmed run never starts some announced tests, so its roster is no count.
    if (rawLog !== undefined && trimsAnnouncedTests(raw.args)) rawLog = { ...rawLog, roster: [] };
    const combined = `${result.stdout}\n${result.stderr}`;
    // An exit-0 run is still not a pass when it stopped partway or reported
    // unexpected results (see test-run-completeness.ts). The raw log decides
    // when the run wrote one; the start count otherwise reads the streamed
    // markers, never the 2 MB capture tail.
    verdict = vetoIncompletePass(
      classifyHarnessRun(result.exitCode, combined, paths, {
        raw: rawLog === undefined ? undefined : summarizeRawLog(rawLog),
        started: rawLog?.markers.started ?? tracker.markers().started,
      }),
      combined,
      paths,
      { markers: tracker.markers(), source: 'stream' },
      rawLog
    );
    verdict = coverageVerdict(verdict, coverageOutcomes.get(result));
    // A mochitest server that never came up is retried like a crash: no
    // test ran, and a parallel instance's port race is not a result.
    if (verdict.kind !== 'harness-crash' || attempts >= maxAttempts) break;
    const shape =
      verdict.signature?.verdictReason === 'server-startup'
        ? 'Harness server startup failed'
        : 'Harness crash detected';
    warn(
      `${shape} (${verdict.signature?.reason ?? 'unknown shape'}): ` +
        `${verdict.signature?.line ?? ''}\n` +
        `Retrying (attempt ${attempts + 1} of ${maxAttempts})...`
    );
  }

  // A verdict whose every unexpected result is time-driven pref noise is
  // still a FAIL. Only the note changes, so a `unexpected=2` line is not
  // read as two real assertion failures.
  if (verdict.kind === 'test-failures' && verdict.note === undefined) {
    const prefNote = changedPrefNoiseVerdictNote(`${result.stdout}\n${result.stderr}`);
    if (prefNote !== undefined) verdict = { ...verdict, note: prefNote };
  }

  const displayState = stallDisplayState(verdict, ctx);
  if (displayState !== undefined) {
    const note = headedDisplayAsleepVerdictNote(verdict.signature as HarnessCrashSignature, {
      headless: ctx.headless,
      platform: getPlatform(),
      displayState,
    });
    if (note !== undefined) verdict = { ...verdict, note };
  }

  if (rawLog !== undefined) {
    recordTestResults(rawLog.results, rawLog.unfinished, {
      run: ctx.repetition ?? 1,
      shard: label,
      logLine,
      shardFiles: paths,
      markers: rawLog.markers,
      attempts,
    });
  }

  return {
    result,
    verdict,
    attempts,
    appdirInjectionAttempted,
    displayState,
    ...(rawLog === undefined ? {} : { fileResults: rawLog.results }),
    ...serverPortsOf(portTracker),
  };
}

const coverageOutcomes = new WeakMap<MachCommandResult, CoverageReport>();

/** Every physical dispatch, including a repaired xpcshell retry, owns its adapter and teardown. */
async function runCoverageTrackedSuite(options: {
  ctx: TestRunContext;
  kind: MachTestSuiteKind;
  paths: string[];
  args: string[];
  env: Record<string, string> | undefined;
  trackers: readonly [StartMarkerTracker, HarnessPortTracker];
}): Promise<MachCommandResult> {
  const { ctx, kind, paths, args, env, trackers } = options;
  const coverage =
    ctx.coverageDir === undefined
      ? undefined
      : await prepareJsCoverage({
          output: ctx.coverageDir,
          engineDir: ctx.engineDir,
          objDir: ctx.objDir,
          suite: ctx.suite,
          args,
          ...(env === undefined ? {} : { env }),
        });
  if (coverage !== undefined) setVerdictRunAttribute('coverage', coverage.directory);
  const result = await runTrackedMachTestSuite(
    ctx,
    kind,
    paths,
    coverage?.args ?? args,
    coverage?.env ?? env,
    trackers
  );
  if (coverage !== undefined) {
    const report = await finishJsCoverage(coverage);
    coverageOutcomes.set(result, report);
    if (!report.complete)
      warn(
        `JavaScript coverage incomplete: ${report.errors.join('; ')}. Artifacts: ${coverage.directory}`
      );
  }
  return result;
}

/** Incomplete coverage cannot become a green run or a caught negative control. */
function coverageVerdict(
  verdict: HarnessRunVerdict,
  report: CoverageReport | undefined
): HarnessRunVerdict {
  return report !== undefined && !report.complete
    ? { ...verdict, kind: 'harness-crash', note: 'coverage-incomplete' }
    : verdict;
}

/** The `serverPorts` field of an outcome, present only when a port was seen. */
function serverPortsOf(tracker: HarnessPortTracker): { serverPorts?: HarnessServerPorts } {
  const ports = tracker.ports();
  return Object.keys(ports).length > 0 ? { serverPorts: ports } : {};
}

/** Sequence for raw-log file names, unique within the process. */
let rawLogSequence = 0;

/**
 * The dispatch arguments with a `--log-raw` destination added, when this run
 * collects per-file results. An operator's own forwarded `--log-raw <file>`
 * is read instead of adding a second one.
 */
function rawLogDispatchArgs(
  ctx: TestRunContext,
  extraArgs: readonly string[]
): { args: string[]; path: string | undefined } {
  if (ctx.rawLogDir === undefined) return { args: [...extraArgs], path: undefined };
  if (hasForwardedRawLog(extraArgs)) {
    return { args: [...extraArgs], path: forwardedRawLogPath(extraArgs) };
  }
  rawLogSequence += 1;
  const path = join(ctx.rawLogDir, `dispatch-${rawLogSequence}.raw.jsonl`);
  return { args: [...extraArgs, `--log-raw=${path}`], path };
}

/**
 * One mach dispatch with its kill path attached: helper-pid tracking and
 * post-close reaping, the process-group announcement, and the parent-exit
 * watchdog for exactly as long as mach runs.
 */
async function runTrackedMachTestSuite(
  ctx: TestRunContext,
  kind: MachTestSuiteKind,
  paths: string[],
  extraArgs: string[],
  env: Record<string, string> | undefined,
  trackers: readonly [StartMarkerTracker, HarnessPortTracker]
): Promise<MachCommandResult> {
  const teardown = createHarnessTeardown({
    objDir: ctx.objDir === undefined ? undefined : join(ctx.engineDir, ctx.objDir),
    pgidFile: ctx.pgidFile,
    projectRoot: dirname(ctx.engineDir),
  });
  const start = await sampleTestHost();
  const startWarned = reportTestHost(start, 'suite start');
  if (start.display === 'asleep') {
    warn('The display is asleep: timing-sensitive tests can go red without any change at fault.');
  }
  stampHost([start], startWarned, false);
  if (env && Object.keys(env).some((key) => key.endsWith('_PERF_SAMPLE_JSON'))) {
    env = { ...env, FIREFORGE_POWER_SOURCE: start.power };
  }
  const stopSleepWatch = watchForHostSleep();
  const stopLoadWatch = watchHostLoad();
  try {
    return await runMachTestSuite(kind, {
      engineDir: ctx.engineDir,
      testPaths: paths,
      args: extraArgs,
      env,
      fullOutput: ctx.fullOutput,
      ...(ctx.outputPrefix === undefined ? {} : { outputPrefix: ctx.outputPrefix }),
      teardown: {
        ...teardown.hooks,
        onOutputChunk: (stream, chunk) => {
          for (const tracker of trackers) tracker.onChunk(stream, chunk);
          teardown.hooks.onOutputChunk?.(stream, chunk);
        },
      },
    });
  } finally {
    teardown.dispose();
    const slept = stopSleepWatch();
    const peak = stopLoadWatch();
    const end = await sampleTestHost();
    ctx.lastDisplayState = end.display;
    stampHost([start, end], reportTestHost(end, 'suite end'), slept, peak);
    if (await stampPerfHost(env, start, end)) ctx.powerChanged = true;
  }
}

/** Folds one dispatch's samples into the attributes earlier dispatches stamped. */
function stampHost(
  samples: readonly TestHostState[],
  warned: boolean,
  slept: boolean,
  peak?: HostLoadPeak
): void {
  const atSeconds =
    peak === undefined ? 0 : Math.max(0, Math.round((peak.at - verdictRunStartedAt()) / 1000));
  // The edges already reported their own load; only a rise between them is news.
  if (peak !== undefined && peak.load > Math.max(...samples.map((sample) => sample.load)))
    reportLoadPeak(peak, atSeconds);
  const merged = mergeHostAttributes(
    getVerdictRunAttribute,
    samples,
    warned,
    slept,
    peak === undefined ? undefined : { load: peak.load, atSeconds }
  );
  for (const [key, value] of Object.entries(merged)) {
    setVerdictRunAttribute(key as keyof typeof merged, value);
  }
}

/**
 * The display state a headed no-output stall ran under. Every other outcome (a
 * passing run, a real test failure, a headless run, any other crash shape) has
 * no stall to explain.
 */
function stallDisplayState(
  verdict: HarnessRunVerdict,
  ctx: TestRunContext
): DisplaySleepState | undefined {
  if (ctx.headless || verdict.kind !== 'harness-crash') return undefined;
  if (!verdict.signature?.reason.includes('no-output timeout')) return undefined;
  return ctx.lastDisplayState ?? 'unknown';
}
