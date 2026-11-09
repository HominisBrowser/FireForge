// SPDX-License-Identifier: EUPL-1.2
/**
 * Preflight census of orphaned test-harness helper processes.
 *
 * Stopping a long mochitest run mid-flight does not necessarily take its
 * helpers with it. A surviving `xpcshell` (the harness httpd, pegged at 100%
 * CPU), `pywebsocket`, `ssltunnel` or `moz-http2` slows every later run without
 * appearing in its output, and a second checkout's live harness competes the
 * same way, so this census names both at the start of a run.
 *
 * A path-shaped process is a diagnostic candidate, never proof of an
 * orphan. Another live run can use the same objdir, or a sibling checkout.
 * The census therefore reports processes and never signals them, whatever the
 * `reapOrphans` posture says. Termination belongs to the run that recorded the
 * process as its own, or under a reap posture to the next run once the recording
 * run is gone (`harness-helper-pids.ts`).
 *
 * The anchoring and termination primitives are exported for the teardown
 * reaper in `harness-helper-pids.ts`, which applies the same objdir rule to
 * the helpers THIS run launched, after mach has exited.
 */

import { isProcessAlive, toError } from '../utils/errors.js';
import { info, verbose, warn } from '../utils/logger.js';
import { listProcessText } from '../utils/process-list.js';
import { commandNamesRoot, parseProcessListing } from '../utils/process-listing.js';
import { parsePsDuration } from '../utils/ps-duration.js';
import { sleep } from '../utils/sleep.js';

/** One surviving harness helper process. */
export interface OrphanedHarnessProcess {
  pid: number;
  ppid: number;
  /** Raw `ps` ELAPSED column. */
  elapsed: string;
  /** Parsed elapsed seconds since the process started. */
  elapsedSeconds: number;
  command: string;
}

/**
 * Harness helper binaries, matched on the executable's basename. Every one
 * of these is started by the mochitest/xpcshell harness and is expected to
 * die with it. None of them is a thing a developer runs by hand.
 */
const HELPER_BINARY = /^(?:xpcshell|ssltunnel|http3server|moz-http2)(?:\.exe)?$/;

/** Interpreters the harness runs its helper scripts under. */
const HELPER_INTERPRETER = /^(?:python[\d.]*|Python|node)(?:\.exe)?$/;

/** Harness helper scripts, matched on the interpreter's script argument. */
const HELPER_SCRIPT =
  /(?:^|[/\\])(?:pywebsocket\w*\.py|websocket_server\.py|websocketprocessbridge\.py|moz-http2\.js|http2_server\.js|httpd\.js|server\.js|runtests\.py|runxpcshelltests\.py)$/;

function basename(token: string): string {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return cut === -1 ? token : token.slice(cut + 1);
}

/**
 * True when `command` IS a harness helper: its executable is a helper
 * binary, or an interpreter whose first argument is a helper script.
 *
 * Structural on purpose. Matching the helper names anywhere in the command
 * line is right for the httpd (`xpcshell -g … -f …/server.js`) and wrong for
 * everything that merely mentions such a path: an editor opened on
 * `server.js`, a shell whose command text quotes it, a `grep` over the
 * objdir, and report it as a leftover harness helper.
 */
export function matchesHarnessHelper(command: string): boolean {
  const [exe, first] = command.trim().split(/\s+/);
  if (exe === undefined) return false;
  if (HELPER_BINARY.test(basename(exe))) return true;
  if (first === undefined || !HELPER_INTERPRETER.test(basename(exe))) return false;
  return HELPER_SCRIPT.test(first);
}

/** Exact configured objdir provenance; a generic obj-* path proves no ownership. */
export function isObjdirAnchored(command: string, objDir: string | undefined): boolean {
  return commandNamesRoot(command, objDir);
}

/** Broad attribution is used for visibility only, including foreign checkout candidates. */
function hasObjdirShape(command: string): boolean {
  return /[/\\]obj-[^/\\\s]*[/\\]/.test(command) || /[/\\]_tests[/\\]/.test(command);
}

/** Pids of `selfPid` and every ancestor of it, as far as the listing reaches. */
function ancestorsOf(rows: readonly { pid: number; ppid: number }[], selfPid: number): Set<number> {
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const chain = new Set<number>();
  let cursor: number | undefined = selfPid;
  while (cursor !== undefined && cursor > 0 && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return chain;
}

/**
 * Scans `ps -axo pid=,ppid=,etime=,command=` output for surviving harness
 * helpers. Pure, so it is fixture-testable without spawning anything.
 *
 * FireForge's own process, its direct children and its ancestors are never
 * candidates: the terminal shell FireForge runs under can carry the helper
 * paths in its own command text, and must never be offered for a kill.
 *
 * @param psOutput - Raw `ps` output
 * @param objDir - Absolute objdir of this project, when known. Widens the
 *   provenance test beyond the generic `obj-…` path segment
 * @param selfPid - This process's pid
 */
export function findOrphanedHarnessProcesses(
  psOutput: string,
  objDir?: string,
  selfPid: number = process.pid
): OrphanedHarnessProcess[] {
  const rows = parseProcessListing(psOutput, ['pid', 'ppid', 'etime', 'command'] as const);
  const excluded = ancestorsOf(rows, selfPid);
  const found: OrphanedHarnessProcess[] = [];
  for (const { pid, ppid, etime: elapsed, command } of rows) {
    if (excluded.has(pid) || ppid === selfPid) continue;
    if (!matchesHarnessHelper(command)) continue;
    if (!isObjdirAnchored(command, objDir) && !hasObjdirShape(command)) continue;
    const elapsedSeconds = parsePsDuration(elapsed);
    found.push({
      pid,
      ppid,
      elapsed,
      elapsedSeconds: Number.isNaN(elapsedSeconds) ? 0 : elapsedSeconds,
      command,
    });
  }
  return found;
}

/** Grace period between SIGTERM and SIGKILL when reaping. */
const REAP_GRACE_MS = 500;

/** Wait after SIGKILL before the final liveness probe, so the parent can collect the exit. */
const KILL_SETTLE_MS = 200;

/** Longest command excerpt carried into the report line. */
const COMMAND_EXCERPT_LIMIT = 160;

/**
 * Renders the census. Names every process with its elapsed time, because
 * "a leftover harness process exists" and "a leftover harness process has
 * been burning a core for 58 minutes" are different findings.
 */
export function formatOrphanReport(orphans: readonly OrphanedHarnessProcess[]): string {
  const rows = orphans
    .map((p) => `  PID ${p.pid} (up ${p.elapsed}): ${p.command.slice(0, COMMAND_EXCERPT_LIMIT)}`)
    .join('\n');
  return (
    `${orphans.length} other harness helper process(es) are alive:\n${rows}\n` +
    'These may belong to active runs in this or another checkout. Path and age do not establish ' +
    'run ownership; no kill command is suggested and no unknown process will be reaped. ' +
    'Inspect the owning run before diagnosing a survivor.'
  );
}

/**
 * Preflight census of surviving harness helpers, run before a test
 * dispatch.
 *
 * Best-effort: a host without a usable `ps` (Windows, a locked-down
 * container) logs at verbose and runs exactly as before. It never refuses a
 * run. Unlike the server-port preflight, a survivor here degrades
 * performance rather than making the run dispatch against the wrong server,
 * so the correct response is to say so loudly rather than to stop.
 *
 * @param objDir - Absolute objdir of this project, when known
 * @param options - `reap` is the `reapOrphans` posture. The census reports and
 *   never signals, so it says why a reap left these alone.
 * @returns The survivors (empty when nothing was found or nothing could be probed)
 */
export async function reportOrphanedHarnessProcesses(
  objDir: string | undefined,
  options: { reap?: boolean } = {}
): Promise<OrphanedHarnessProcess[]> {
  if (process.platform === 'win32') return [];
  let psOutput: string;
  try {
    psOutput = await listProcessText(['pid', 'ppid', 'etime', 'command']);
  } catch (error: unknown) {
    verbose(`Orphan preflight: could not scan processes (${toError(error).message}); skipping.`);
    return [];
  }

  const orphans = findOrphanedHarnessProcesses(psOutput, objDir);
  if (orphans.length === 0) {
    verbose('Orphan preflight: no surviving harness helper processes.');
    return [];
  }

  warn(formatOrphanReport(orphans));
  if (options.reap === true) {
    warn(
      'test.reapOrphans / --reap-orphans terminates only helpers a FireForge run on this objdir ' +
        'recorded before it died. No such record names these, so they were left alone.'
    );
  }
  return orphans;
}

/**
 * Terminates each entry: SIGTERM to all of them, one grace period, then SIGKILL
 * for anything still alive. Failures are reported, never thrown. A process that
 * exited between the listing and the signal is the common case rather than an
 * error.
 *
 * @param targets - Candidate processes from this run's positive ownership records
 * @param label - Prefix for the log lines, naming which path is reaping
 *   (`teardown` after mach exits)
 * @param stillOwned - Revalidates the captured PID/start identity before every signal
 * @returns How many targets are confirmed gone afterwards
 */
export async function terminateHarnessProcesses(
  targets: readonly Pick<OrphanedHarnessProcess, 'pid'>[],
  label: string,
  stillOwned: (pid: number) => boolean
): Promise<number> {
  const signal = (pid: number, value: NodeJS.Signals): boolean => {
    try {
      process.kill(pid, value);
      return true;
    } catch (error: unknown) {
      verbose(`${label}: ${value} to ${pid} failed (${toError(error).message}).`);
      return false;
    }
  };
  const terminating = targets
    .map((target) => target.pid)
    .filter((pid) => stillOwned(pid) && signal(pid, 'SIGTERM'));
  if (terminating.length === 0) return 0;

  // One grace period for the batch: a spinning httpd ignores SIGTERM, but an
  // ordinary helper exits promptly and must not be SIGKILLed for being slow by
  // a millisecond.
  await sleep(REAP_GRACE_MS);
  const escalated = terminating.filter(isProcessAlive).filter((pid) => {
    if (stillOwned(pid)) return signal(pid, 'SIGKILL');
    warn(`${label}: PID ${pid} changed ownership before escalation; left alone.`);
    return false;
  });
  // A killed process answers kill(0) until its parent (launchd, for a
  // reparented survivor) has collected it, which takes a moment.
  if (escalated.length > 0) await sleep(KILL_SETTLE_MS);

  // Counted only when the probe agrees: the verdict line will carry this
  // number, and a SIGKILL that was sent is not the same as a process that is
  // gone. A PID that changed ownership and was left alone is not counted.
  let reaped = 0;
  for (const pid of terminating) {
    if (!isProcessAlive(pid)) {
      reaped += 1;
      info(`${label}: terminated PID ${pid}.`);
    } else if (stillOwned(pid)) {
      warn(`${label}: PID ${pid} is still alive after SIGKILL; inspect it by hand.`);
    }
  }
  return reaped;
}
