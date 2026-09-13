// SPDX-License-Identifier: EUPL-1.2
/**
 * Teardown reaper for the helper processes one mach test dispatch launched.
 *
 * The mochitest harness starts its httpd (`xpcshell … server.js`), the
 * websocket server, ssltunnel and the websocket/process bridge as plain
 * children, and the browser through mozprocess, which puts it in a process
 * group of its own. It logs each launch as `runtests.py | <what> pid: <n>`.
 * When mach dies before its own cleanup runs (a forwarded SIGTERM, a
 * no-output timeout, a harness crash, a supervisor kill), the helpers do not
 * necessarily die with it: the 2026-09-13 incident left the httpd reparented
 * to launchd at 100% CPU for hours after a gate killed the run at its bound.
 *
 * The exec layer already sweeps the dispatch's process group after close.
 * That reaches every helper that stayed in the group, and nothing else: the
 * browser is in its own group, and a helper that re-grouped itself is not.
 * This module closes that gap in two passes:
 *
 *  - {@link createHelperPidTracker} collects the announced pids from the
 *    streamed output. {@link reapTrackedHarnessPids} runs after mach has
 *    exited; a tracked pid still alive at that point is by definition a
 *    survivor (its parent is gone), so no age heuristic is needed. Before
 *    signalling, each pid is re-read from `ps` and must still be anchored to
 *    the objdir and still look like the thing the harness launched: a pid
 *    recycled onto an unrelated process between the launch line and
 *    teardown is skipped.
 *  - Not every helper is announced. mozserve starts `moz-http2` with
 *    `start_new_session=True` and logs no pid, so it is in neither the
 *    group nor the tracker, and it was the other survivor of the incident.
 *    {@link snapshotObjdirHelpers} records which same-objdir helpers existed
 *    before the dispatch spawned; after mach exits, a helper-shaped process
 *    under THIS checkout's absolute objdir that is not in that baseline and
 *    is reparented (its parent, the harness, is gone) is one this dispatch
 *    launched, and is reaped too. The absolute-path anchor keeps a sibling
 *    checkout's live harness out of it; the baseline keeps a survivor of an
 *    earlier run out of it, so the preflight census's report-only posture
 *    still decides that one's fate.
 */

import { toError } from '../utils/errors.js';
import { dispatchCompleteLines } from '../utils/line-dispatch.js';
import { info, verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import {
  isObjdirAnchored,
  isPidAlive,
  matchesHarnessHelper,
  terminateHarnessProcesses,
} from './harness-orphans.js';

/**
 * What the harness said it launched, as it names it in the log line, or
 * `unannounced` for a survivor found by the post-close objdir scan.
 */
export type TrackedHarnessKind =
  | 'Server'
  | 'Websocket server'
  | 'SSL tunnel'
  | 'websocket/process bridge'
  | 'Application'
  | 'unannounced';

/** One helper the harness launched. */
export interface TrackedHarnessPid {
  pid: number;
  kind: TrackedHarnessKind;
  /** Command line, when the entry came from `ps` rather than a log line. */
  command?: string;
}

/** Which child stream a chunk came from. */
export type OutputStreamName = 'stdout' | 'stderr';

/**
 * The launch announcements in `testing/mochitest/runtests.py`. mozlog puts a
 * timestamp and level in front, so the match is unanchored.
 */
const HARNESS_PID_LINE =
  /runtests\.py \| (Server|Websocket server|SSL tunnel|websocket\/process bridge|Application) pid: (\d+)\b/;

/** Collects harness launch announcements from streamed output chunks. */
export interface HelperPidTracker {
  /** Feed one chunk. Chunk boundaries need not align with lines. */
  feed(stream: OutputStreamName, chunk: string): void;
  /** Every pid announced so far, in announcement order, without duplicates. */
  tracked(): TrackedHarnessPid[];
}

/**
 * Creates a tracker for one dispatch. The two streams are buffered apart so
 * a half-line on one cannot be glued to a half-line on the other.
 */
export function createHelperPidTracker(): HelperPidTracker {
  const seen = new Map<number, TrackedHarnessPid>();
  const partial: Record<OutputStreamName, string> = { stdout: '', stderr: '' };
  const onLine = (line: string): void => {
    const match = HARNESS_PID_LINE.exec(line);
    if (!match) return;
    const pid = Number(match[2]);
    if (!seen.has(pid)) {
      seen.set(pid, { pid, kind: match[1] as TrackedHarnessKind });
    }
  };
  return {
    feed(stream, chunk): void {
      partial[stream] = dispatchCompleteLines(partial[stream] + chunk, onLine);
    },
    tracked(): TrackedHarnessPid[] {
      return [...seen.values()];
    },
  };
}

/** Log prefix for every line this reaper writes. */
const TEARDOWN_LABEL = 'harness teardown';

/**
 * Decides whether a `ps` row still describes the process the harness
 * announced. Exported for fixture tests.
 *
 * The helpers must match the census's helper pattern and the objdir anchor.
 * The browser has no helper-shaped name, so the anchor alone attributes it:
 * its binary lives under the objdir (`<objdir>/dist/<App>.app/…`).
 */
export function isStillTrackedProcess(
  tracked: TrackedHarnessPid,
  command: string,
  objDir: string | undefined
): boolean {
  if (!isObjdirAnchored(command, objDir)) return false;
  return tracked.kind === 'Application' || matchesHarnessHelper(command);
}

/** One row of `ps -axo pid=,ppid=,command=`. */
interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Lists every process. Throws when `ps` is unusable, like the census. */
async function listAllProcesses(): Promise<ProcessRow[]> {
  const result = await exec('ps', ['-axo', 'pid=,ppid=,command='], { timeout: 10000 });
  if (result.exitCode !== 0) throw new Error(`ps exited ${result.exitCode}`);
  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: (match[3] ?? '').trim(),
      });
    }
  }
  return rows;
}

/**
 * A helper-shaped process under this checkout's objdir. The anchor here is
 * the absolute objdir path alone, on purpose: the census's generic `obj-…`
 * fallback would also match a sibling checkout's live harness.
 */
function isThisObjdirHelper(command: string, objDir: string): boolean {
  return command.includes(objDir) && matchesHarnessHelper(command);
}

/**
 * Records the same-objdir helpers alive before a dispatch spawns anything,
 * so the post-close pass can tell this dispatch's unannounced helpers from
 * an earlier run's survivors. Undefined when `ps` is unusable or no objdir
 * is known; the post-close pass then reaps no unannounced process at all.
 *
 * @param objDir - This project's absolute objdir
 * @returns The pids to leave alone at teardown, or undefined for "no baseline"
 */
export async function snapshotObjdirHelpers(
  objDir: string | undefined
): Promise<Set<number> | undefined> {
  if (process.platform === 'win32' || objDir === undefined) return undefined;
  try {
    const rows = await listAllProcesses();
    return new Set(rows.filter((r) => isThisObjdirHelper(r.command, objDir)).map((r) => r.pid));
  } catch (error: unknown) {
    verbose(`${TEARDOWN_LABEL}: could not snapshot helpers (${toError(error).message}).`);
    return undefined;
  }
}

/**
 * Helpers this dispatch launched without announcing them: helper-shaped,
 * under this checkout's objdir, not in the pre-dispatch baseline, and
 * reparented to pid 1 because the harness that started them is gone.
 * Returns nothing when `ps` is unusable rather than guessing. Without a
 * baseline (a snapshot that failed) it also returns nothing: an earlier
 * run's survivor must stay the census's call.
 */
async function findUnannouncedSurvivors(
  objDir: string,
  baseline: ReadonlySet<number> | undefined,
  exclude: ReadonlySet<number>
): Promise<TrackedHarnessPid[]> {
  if (baseline === undefined) return [];
  let rows: ProcessRow[];
  try {
    rows = await listAllProcesses();
  } catch (error: unknown) {
    verbose(
      `${TEARDOWN_LABEL}: could not scan for unannounced helpers (${toError(error).message}).`
    );
    return [];
  }
  return rows
    .filter(
      (r) =>
        r.ppid === 1 &&
        r.pid !== process.pid &&
        !baseline.has(r.pid) &&
        !exclude.has(r.pid) &&
        isThisObjdirHelper(r.command, objDir)
    )
    .map((r) => ({ pid: r.pid, kind: 'unannounced' as const, command: r.command }));
}

/** Reads `pid command` rows for the given pids. Missing pids simply produce no row. */
async function listCommands(pids: readonly number[]): Promise<Map<number, string>> {
  const result = await exec('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], {
    timeout: 10000,
  });
  const rows = new Map<number, string>();
  // `ps -p` exits 1 when any listed pid is gone, while still printing the
  // rest, so the exit code is not a failure signal here.
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) rows.set(Number(match[1]), (match[2] ?? '').trim());
  }
  return rows;
}

/**
 * Re-reads the announced pids that are still alive and keeps the ones still
 * attributable to this dispatch. Empty when `ps` is unusable.
 */
async function survivingTrackedPids(
  tracked: readonly TrackedHarnessPid[],
  objDir: string | undefined
): Promise<TrackedHarnessPid[]> {
  const alive = tracked.filter((entry) => isPidAlive(entry.pid));
  if (alive.length === 0) return [];
  let commands: Map<number, string>;
  try {
    commands = await listCommands(alive.map((entry) => entry.pid));
  } catch (error: unknown) {
    verbose(
      `${TEARDOWN_LABEL}: could not read ps for tracked helpers (${toError(error).message}); skipping.`
    );
    return [];
  }
  const targets: TrackedHarnessPid[] = [];
  for (const entry of alive) {
    const command = commands.get(entry.pid);
    if (command === undefined) continue; // exited between the probe and ps
    if (!isStillTrackedProcess(entry, command, objDir)) {
      verbose(
        `${TEARDOWN_LABEL}: PID ${entry.pid} (announced as ${entry.kind}) is now "${command.slice(0, 120)}", ` +
          'not attributable to this run; left alone.'
      );
      continue;
    }
    targets.push(entry);
  }
  return targets;
}

function describeTarget(target: TrackedHarnessPid): string {
  const excerpt = target.command === undefined ? '' : ` "${target.command.slice(0, 80)}"`;
  return `${target.kind} ${target.pid}${excerpt}`;
}

/**
 * Terminates every process this dispatch launched that is still alive after
 * mach exited: the announced pids still attributable to the dispatch, and
 * the unannounced same-objdir survivors that appeared since the baseline.
 *
 * Best-effort like the census: a host without `ps` logs at verbose and
 * reaps nothing rather than signalling on the strength of a pid alone.
 *
 * @param tracked - The pids the harness announced during the dispatch
 * @param objDir - This project's absolute objdir, for the anchor rule
 * @param baseline - Same-objdir helpers alive before the dispatch spawned
 *   ({@link snapshotObjdirHelpers}); never touched here. Undefined disables
 *   the unannounced pass entirely
 * @returns How many survivors are confirmed gone afterwards
 */
export async function reapTrackedHarnessPids(
  tracked: readonly TrackedHarnessPid[],
  objDir: string | undefined,
  baseline?: ReadonlySet<number>
): Promise<number> {
  if (process.platform === 'win32') return 0;
  const targets = await survivingTrackedPids(tracked, objDir);
  if (objDir !== undefined) {
    const known = new Set(tracked.map((t) => t.pid));
    targets.push(...(await findUnannouncedSurvivors(objDir, baseline, known)));
  }
  if (targets.length === 0) return 0;

  info(
    `${TEARDOWN_LABEL}: ${targets.length} harness process(es) outlived mach ` +
      `(${targets.map(describeTarget).join(', ')}); terminating.`
  );
  return terminateHarnessProcesses(targets, TEARDOWN_LABEL);
}
