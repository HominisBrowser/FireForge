// SPDX-License-Identifier: EUPL-1.2
import { loadavg } from 'node:os';

import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { notice } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { isObject } from '../utils/validation.js';

/** Measured display sleep state, or `'unknown'` when nothing was measured. */
export type DisplaySleepState = 'asleep' | 'awake' | 'unknown';

export interface TestHostState {
  load: number;
  topProcess?: { cpu: number; command: string };
  power: 'ac' | 'battery' | 'unknown';
  display: DisplaySleepState;
}

/** How long one display reading serves: `system_profiler` costs about half a second. */
const DISPLAY_READING_MAX_AGE_MS = 30_000;
const HOST_PROBE_TIMEOUT_MS = 5_000;

let displayReading: { at: number; state: Promise<DisplaySleepState> } | undefined;

/**
 * Parses `system_profiler SPDisplaysDataType`. Each attached display prints an
 * `Online:` row, and a sleeping one also prints `Display Asleep: Yes`. Displays
 * sleep together, so one asleep row is the finding. No display rows at all (a
 * headless Mac) is `'unknown'`, never a guess.
 *
 * @param stdout - Raw `system_profiler SPDisplaysDataType` output
 */
export function parseDisplaySleepState(stdout: string): DisplaySleepState {
  if (/^\s*Display Asleep:\s*Yes\s*$/m.test(stdout)) return 'asleep';
  return /^\s*Online:\s*Yes\s*$/m.test(stdout) ? 'awake' : 'unknown';
}

async function readDisplayState(): Promise<DisplaySleepState> {
  try {
    const result = await exec('system_profiler', ['SPDisplaysDataType'], {
      timeout: HOST_PROBE_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? parseDisplaySleepState(result.stdout) : 'unknown';
  } catch {
    return 'unknown';
  }
}

function probeDisplayState(): Promise<DisplaySleepState> {
  if (process.platform !== 'darwin') return Promise.resolve('unknown');
  const now = Date.now();
  if (displayReading === undefined || now - displayReading.at >= DISPLAY_READING_MAX_AGE_MS) {
    displayReading = { at: now, state: readDisplayState() };
  }
  return displayReading.state;
}

async function probeTopProcess(): Promise<TestHostState['topProcess']> {
  try {
    const result = await exec('ps', ['-axo', 'pcpu=,comm='], { timeout: HOST_PROBE_TIMEOUT_MS });
    return result.stdout
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*([\d.]+)\s+(.+)$/.exec(line);
        return match ? [{ cpu: Number(match[1]), command: match[2] ?? '' }] : [];
      })
      .sort((a, b) => b.cpu - a.cpu)[0];
  } catch {
    return undefined; // Host diagnostics remain best effort.
  }
}

async function probePowerSource(): Promise<TestHostState['power']> {
  if (process.platform !== 'darwin') return 'unknown';
  try {
    const result = await exec('pmset', ['-g', 'ps'], { timeout: HOST_PROBE_TIMEOUT_MS });
    if (/'AC Power'/.test(result.stdout)) return 'ac';
    return /'Battery Power'/.test(result.stdout) ? 'battery' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Samples load, the top process, the macOS power SOURCE (including charging on
 * AC) and whether the display sleeps. Timing tests read differently on all four,
 * and the verdict line carries them.
 */
export async function sampleTestHost(): Promise<TestHostState> {
  const [topProcess, power, display] = await Promise.all([
    probeTopProcess(),
    probePowerSource(),
    probeDisplayState(),
  ]);
  return {
    load: loadavg()[0] ?? 0,
    power,
    display,
    ...(topProcess === undefined ? {} : { topProcess }),
  };
}

/** A tick gap this long, against a {@link SLEEP_WATCH_TICK_MS} tick, means the machine slept. */
const SLEEP_GAP_MS = 30_000;
const SLEEP_WATCH_TICK_MS = 5_000;

/**
 * Watches for a system sleep while a dispatch runs. A sleeping machine suspends
 * this process, so a timer tick arrives far later than it was due; a watched
 * wall-clock gap needs nothing from the platform's monotonic clock, whose
 * behaviour across sleep differs by OS and libuv version.
 *
 * @returns Stops watching, and says whether the machine slept
 */
export function watchForHostSleep(): () => boolean {
  let slept = false;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last >= SLEEP_GAP_MS) slept = true;
    last = now;
  }, SLEEP_WATCH_TICK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (Date.now() - last >= SLEEP_GAP_MS) slept = true;
    return slept;
  };
}

/** A one-minute load average at or above this warns, as a process at 90% CPU does. */
const HOST_LOAD_WARNING = 4;
/** How often a watched suite or step samples the one-minute load average. */
export const LOAD_WATCH_TICK_MS = 30_000;

/** The highest one-minute load average a watch saw, and when, in epoch milliseconds. */
export interface HostLoadPeak {
  load: number;
  at: number;
}

/** `os.loadavg()[0]`, or undefined on Windows, where Node reports zeros. */
export function oneMinuteLoad(): number | undefined {
  return process.platform === 'win32' ? undefined : loadavg()[0];
}

/**
 * Samples the one-minute load average while a suite or step runs: at once,
 * every {@link LOAD_WATCH_TICK_MS} and when stopped, so a rise between the
 * edges is seen. The timer never keeps the process alive.
 *
 * @returns Stops watching, and gives the highest sample, or undefined where
 *   there is no load average
 */
export function watchHostLoad(): () => HostLoadPeak | undefined {
  let peak: HostLoadPeak | undefined;
  const sample = (): void => {
    const load = oneMinuteLoad();
    if (load !== undefined && (peak === undefined || load > peak.load))
      peak = { load, at: Date.now() };
  };
  sample();
  const timer = setInterval(sample, LOAD_WATCH_TICK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    sample();
    return peak;
  };
}

/**
 * The verdict attributes one dispatch's host samples add to those of the
 * dispatches before it. A sharded or repeated run reports its worst host, not
 * its last one: the highest load, the highest load seen while a suite ran and
 * when, either warning, a sleeping display, and the battery. `previous` reads
 * the attributes already stamped.
 *
 * @param previous - Reads an attribute stamped by an earlier dispatch
 * @param samples - This dispatch's samples, start first
 * @param warned - `reportTestHost` warned for one of them
 * @param slept - The machine slept during this dispatch
 * @param peak - This dispatch's load peak, `atSeconds` after the run started
 */
export function mergeHostAttributes(
  previous: (key: HostVerdictAttribute) => string | undefined,
  samples: readonly TestHostState[],
  warned: boolean,
  slept: boolean,
  peak?: { load: number; atSeconds: number }
): Partial<Record<HostVerdictAttribute, string>> {
  const load = Math.max(
    ...samples.map((sample) => sample.load),
    Number(previous('host-load') ?? 0)
  );
  const earlierPeak = previous('host-load-peak');
  const newPeak =
    peak !== undefined && (earlierPeak === undefined || peak.load > Number(earlierPeak));
  const displays = [...samples.map((sample) => sample.display), previous('display')];
  const powers = [...samples.map((sample) => sample.power), previous('power-source')];
  const display = displays.includes('asleep')
    ? 'asleep'
    : displays.includes('awake')
      ? 'awake'
      : 'unknown';
  const power = powers.includes('battery') ? 'battery' : powers.includes('ac') ? 'ac' : 'unknown';
  const peaked = (peak?.load ?? 0) >= HOST_LOAD_WARNING;
  return {
    'host-load': load.toFixed(2),
    ...(newPeak
      ? { 'host-load-peak': peak.load.toFixed(2), 'host-load-peak-at': String(peak.atSeconds) }
      : {}),
    display,
    'power-source': power,
    ...(warned || peaked || previous('host-cpu-warning') !== undefined
      ? { 'host-cpu-warning': 'true' }
      : {}),
    ...(slept || previous('host-slept') !== undefined ? { 'host-slept': 'true' } : {}),
    ...(powers.includes('ac') && powers.includes('battery') ? { 'power-changed': 'true' } : {}),
  };
}

/** The verdict attributes {@link mergeHostAttributes} owns. */
export type HostVerdictAttribute =
  | 'host-load'
  | 'host-load-peak'
  | 'host-load-peak-at'
  | 'host-cpu-warning'
  | 'host-slept'
  | 'display'
  | 'power-source'
  | 'power-changed';

/** Reports host contention alongside a suite's result, without inventing a test failure. */
export function reportTestHost(state: TestHostState, phase: string): boolean {
  const pegged = (state.topProcess?.cpu ?? 0) >= 90;
  if (state.load < HOST_LOAD_WARNING && !pegged) return false;
  notice(
    `Host load at ${phase}: ${state.load.toFixed(2)}; top process ${state.topProcess?.command ?? '(unknown)'} ${state.topProcess?.cpu ?? 0}% CPU. Timing failures may reflect host contention.`
  );
  return true;
}

/**
 * Reports a load peak that warns, which a suite's edges can miss.
 *
 * @param peak - The suite's load peak
 * @param atSeconds - When it was seen, in seconds after the run started
 */
export function reportLoadPeak(peak: HostLoadPeak, atSeconds: number): void {
  if (peak.load < HOST_LOAD_WARNING) return;
  notice(
    `Host load peaked at ${peak.load.toFixed(2)}, ${String(atSeconds)} s into the run. Timing failures may reflect host contention.`
  );
}

/** Stamps each perf artifact before the verdict, preserving the producer's schema and data. */
export async function stampPerfHost(
  env: Record<string, string> | undefined,
  start: Omit<TestHostState, 'display'>,
  end: Omit<TestHostState, 'display'>
): Promise<boolean> {
  if (!env) return false;
  const artifacts = [
    ...new Set(
      Object.entries(env)
        .filter(([key]) => key.endsWith('_PERF_SAMPLE_JSON'))
        .map(([, path]) => path)
    ),
  ];
  if (artifacts.length === 0) return false;
  const changed = start.power !== 'unknown' && end.power !== 'unknown' && start.power !== end.power;
  if (changed)
    notice(
      `Perf power source changed during the run (${start.power} → ${end.power}); this sample is inconclusive.`
    );
  for (const artifact of artifacts) {
    try {
      if (!(await pathExists(artifact))) continue;
      const sample = await readJson<unknown>(artifact);
      if (!isObject(sample)) throw new Error('sample JSON is not an object');
      await writeJson(artifact, {
        ...sample,
        fireforgeHost: { start, end, powerSourceChanged: changed },
      });
    } catch (error: unknown) {
      notice(
        `Could not annotate perf artifact ${artifact}: ${toError(error).message}. The harness outcome is preserved; inspect or regenerate this artifact before using it as perf evidence.`
      );
    }
  }

  return changed;
}
