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

import { join } from 'node:path';

import { type DisplaySleepState, probeDisplaySleepState } from '../core/display-state.js';
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
import { reportTestHost, sampleTestHost, stampPerfHost } from '../core/test-host-state.js';
import {
  forwardedRawLogPath,
  hasForwardedRawLog,
  type RawTestLog,
  type RawTestResult,
  readRawTestLog,
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
import { setVerdictRunAttribute } from './test-verdict.js';

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
  /** A perf run changed power source; no green result can be trusted. */
  powerChanged?: boolean;
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
    const dispatched = await runTrackedMachTestSuite(ctx, kind, paths, raw.args, env, [
      tracker,
      portTracker,
    ]);
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
    });
    if (result !== dispatched) tracker = retryTracker;
    rawLog = raw.path === undefined ? undefined : await readRawTestLog(raw.path);
    const combined = `${result.stdout}\n${result.stderr}`;
    // An exit-0 run is still not a pass when it stopped partway or
    // reported unexpected results (see test-run-completeness.ts). The
    // start count reads the structured raw log when the run wrote one, and
    // the streamed markers otherwise, never the 2 MB capture tail.
    verdict = vetoIncompletePass(
      classifyHarnessRun(result.exitCode, combined, paths),
      combined,
      paths,
      rawLog !== undefined && rawLog.markers.started.length > 0
        ? { markers: rawLog.markers, source: 'raw' }
        : { markers: tracker.markers(), source: 'stream' }
    );
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

  const displayState = await probeDisplayStateForStall(verdict, ctx.headless);
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
  });
  const start = await sampleTestHost();
  const warned = reportTestHost(start, 'suite start');
  setVerdictRunAttribute('host-load', start.load.toFixed(2));
  if (warned) setVerdictRunAttribute('host-cpu-warning', 'true');
  if (env && Object.keys(env).some((key) => key.endsWith('_PERF_SAMPLE_JSON'))) {
    setVerdictRunAttribute('power-source', start.power);
    env = { ...env, FIREFORGE_POWER_SOURCE: start.power };
  }
  try {
    await teardown.prepare();
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
    const end = await sampleTestHost();
    if (reportTestHost(end, 'suite end')) setVerdictRunAttribute('host-cpu-warning', 'true');
    if (await stampPerfHost(env, start, end)) {
      ctx.powerChanged = true;
      setVerdictRunAttribute('power-changed', 'true');
    }
  }
}

/**
 * Probes the display's power state for a headed no-output stall, and only for
 * that shape. Every other outcome (a passing run, a real test failure, a
 * headless run, any other crash shape) skips the probe entirely, so the
 * common paths spawn nothing.
 *
 * @returns The measured state, or undefined when the shape does not apply
 */
async function probeDisplayStateForStall(
  verdict: HarnessRunVerdict,
  headless: boolean
): Promise<DisplaySleepState | undefined> {
  if (headless) return undefined;
  if (verdict.kind !== 'harness-crash') return undefined;
  if (!verdict.signature?.reason.includes('no-output timeout')) return undefined;
  return probeDisplaySleepState(getPlatform());
}
