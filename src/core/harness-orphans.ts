// SPDX-License-Identifier: EUPL-1.2
/**
 * Preflight census of orphaned test-harness helper processes.
 *
 * Stopping a long mochitest run mid-flight does not necessarily take its
 * helpers with it. A downstream incident left `xpcshell` (the harness
 * httpd, pegged at 100% CPU), `pywebsocket`, `ssltunnel` and `moz-http2`
 * alive for an hour. Every subsequent run crawled: a three-second suite
 * took six minutes of wall clock and audio-start waits timed out. Nothing
 * in FireForge's output connected the slowness to the survivors.
 * The hour was spent mis-attributing it to the change under test.
 *
 * Visibility alone would have collapsed that hour, which is why the census
 * runs by default and the kill does not. Two rules keep it honest:
 *
 *  - The census runs at preflight, before this run spawns anything, so
 *    every matching process must be a survivor of an earlier run. No age
 *    heuristic is needed, and none is used.
 *  - A match must be anchored to a Firefox OBJDIR. `xpcshell` and
 *    `server.js` are far too generic on their own. The same rule
 *    `mochitest-server-port.ts` applies to the httpd holder applies here,
 *    for the same reason. FireForge has no business reporting, let alone
 *    terminating, a process it cannot attribute to the harness.
 *
 * `--reap-orphans` (or `test.reapOrphans: "reap"` in `fireforge.json`) opts
 * into termination. Without it the census is report-only, exactly like the
 * `Orphaned harness workers` doctor check (which covers a different shape:
 * reparented Python multiprocessing workers, matched on PPID 1 and
 * accumulated CPU time).
 *
 * The anchoring and termination primitives are exported for the teardown
 * reaper in `harness-helper-pids.ts`, which applies the same objdir rule to
 * the helpers THIS run launched, after mach has exited.
 */

import { toError } from '../utils/errors.js';
import { info, verbose, warn } from '../utils/logger.js';
import { exec } from '../utils/process.js';
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
 * Structural on purpose. An earlier version matched the helper names
 * anywhere in the command line, which is right for the httpd (`xpcshell -g
 * … -f …/server.js`) and wrong for everything that merely mentions such a
 * path: an editor opened on `server.js`, a shell whose command text quotes
 * it, a `grep` over the objdir. Report-only, that printed a misleading
 * `kill`; under the reap posture it terminated the operator's shell.
 */
export function matchesHarnessHelper(command: string): boolean {
  const [exe, first] = command.trim().split(/\s+/);
  if (exe === undefined) return false;
  if (HELPER_BINARY.test(basename(exe))) return true;
  if (first === undefined || !HELPER_INTERPRETER.test(basename(exe))) return false;
  return HELPER_SCRIPT.test(first);
}

/** Objdir provenance: an explicit objdir path, a `obj-…` path segment, or `_tests/`. */
export function isObjdirAnchored(command: string, objDir: string | undefined): boolean {
  if (objDir !== undefined && objDir.length > 0 && command.includes(objDir)) return true;
  if (/[/\\]obj-[^/\\\s]*[/\\]/.test(command)) return true;
  return /[/\\]_tests[/\\]/.test(command);
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
  const rows: { pid: number; ppid: number; elapsed: string; command: string }[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3] ?? '',
      command: (match[4] ?? '').trim(),
    });
  }
  const excluded = ancestorsOf(rows, selfPid);
  const found: OrphanedHarnessProcess[] = [];
  for (const { pid, ppid, elapsed, command } of rows) {
    if (excluded.has(pid) || ppid === selfPid) continue;
    if (!matchesHarnessHelper(command)) continue;
    if (!isObjdirAnchored(command, objDir)) continue;
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
  const pids = orphans.map((p) => String(p.pid)).join(' ');
  return (
    `${orphans.length} harness helper process(es) from an EARLIER run are still alive ` +
    `(this preflight runs before the current run spawns anything, so none of these belong to ` +
    `it):\n${rows}\n` +
    `Survivors like these slow every later run without appearing anywhere in its output — a ` +
    `three-second suite taking minutes of wall clock is the usual symptom. Terminate them with ` +
    `"kill ${pids}", re-run with --reap-orphans, or set test.reapOrphans to "reap" in ` +
    `fireforge.json to have FireForge do it at every preflight.`
  );
}

/** Thin exec wrapper for the process listing (tests mock `exec` instead). */
async function listSystemProcesses(): Promise<string> {
  const result = await exec('ps', ['-axo', 'pid=,ppid=,etime=,command='], { timeout: 10000 });
  if (result.exitCode !== 0) {
    throw new Error(`ps exited ${result.exitCode}`);
  }
  return result.stdout;
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
 * @param options - `reap` terminates each recognized survivor (SIGTERM,
 *   then SIGKILL for anything that stays)
 * @returns The census (empty when nothing was found or nothing could be
 *   probed) and how many of them are confirmed gone after reaping (0 in
 *   report-only mode)
 */
export async function reportOrphanedHarnessProcesses(
  objDir: string | undefined,
  options: { reap?: boolean } = {}
): Promise<OrphanCensus> {
  if (process.platform === 'win32') return { orphans: [], reaped: 0 };
  let psOutput: string;
  try {
    psOutput = await listSystemProcesses();
  } catch (error: unknown) {
    verbose(`Orphan preflight: could not scan processes (${toError(error).message}); skipping.`);
    return { orphans: [], reaped: 0 };
  }

  const orphans = findOrphanedHarnessProcesses(psOutput, objDir);
  if (orphans.length === 0) {
    verbose('Orphan preflight: no surviving harness helper processes.');
    return { orphans: [], reaped: 0 };
  }

  warn(formatOrphanReport(orphans));
  const reaped =
    options.reap === true ? await terminateHarnessProcesses(orphans, '--reap-orphans') : 0;
  return { orphans, reaped };
}

/** Result of {@link reportOrphanedHarnessProcesses}. */
export interface OrphanCensus {
  orphans: OrphanedHarnessProcess[];
  /** Survivors confirmed gone after the reap. Always 0 in report-only mode. */
  reaped: number;
}

/** Liveness probe: `kill(pid, 0)` throws for a pid that is gone. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates each entry: SIGTERM first, then SIGKILL for anything still
 * alive after the grace period. Failures are reported, never thrown. A
 * process that exited between the listing and the signal is the common case
 * rather than an error.
 *
 * @param targets - Processes to terminate, already attributed to the harness
 *   by the caller (objdir anchor rule)
 * @param label - Prefix for the log lines, naming which path is reaping
 *   (`--reap-orphans` at preflight, `teardown` after mach exits)
 * @returns How many targets are confirmed gone afterwards
 */
export async function terminateHarnessProcesses(
  targets: readonly Pick<OrphanedHarnessProcess, 'pid'>[],
  label: string
): Promise<number> {
  let reaped = 0;
  for (const target of targets) {
    try {
      process.kill(target.pid, 'SIGTERM');
    } catch (error: unknown) {
      verbose(`${label}: SIGTERM to ${target.pid} failed (${toError(error).message}).`);
      continue;
    }
    // Grace period before escalating: the httpd shape in the field
    // incident ignored SIGTERM while spinning, but an ordinary helper exits
    // promptly and must not be SIGKILLed for being slow by a millisecond.
    await sleep(REAP_GRACE_MS);
    if (isPidAlive(target.pid)) {
      try {
        process.kill(target.pid, 'SIGKILL');
      } catch (error: unknown) {
        verbose(`${label}: SIGKILL to ${target.pid} failed (${toError(error).message}).`);
      }
      // A killed process answers kill(0) until its parent (launchd, for a
      // reparented survivor) has collected it, which takes a moment.
      await sleep(KILL_SETTLE_MS);
    }
    // Counted only when the probe agrees: the verdict line will carry this
    // number, and a SIGKILL that was sent is not the same as a process that
    // is gone.
    if (isPidAlive(target.pid)) {
      warn(`${label}: PID ${target.pid} is still alive after SIGKILL; inspect it by hand.`);
    } else {
      reaped += 1;
      info(`${label}: terminated PID ${target.pid}.`);
    }
  }
  return reaped;
}
