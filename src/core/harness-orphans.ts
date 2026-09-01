// SPDX-License-Identifier: EUPL-1.2
/**
 * Preflight census of ORPHANED test-harness helper processes.
 *
 * Stopping a long mochitest run mid-flight does not necessarily take its
 * helpers with it. A downstream incident left `xpcshell` (the harness
 * httpd, pegged at 100% CPU), `pywebsocket`, `ssltunnel` and `moz-http2`
 * alive for an hour. Every subsequent run crawled — a three-second suite
 * took six minutes of wall clock and audio-start waits timed out — and
 * nothing in FireForge's output connected the slowness to the survivors.
 * The hour was spent mis-attributing it to the change under test.
 *
 * Visibility alone would have collapsed that hour, which is why the census
 * runs by default and the kill does not. Two rules keep it honest:
 *
 *  - The census runs at PREFLIGHT, before this run spawns anything, so
 *    every matching process is by construction a survivor of an earlier
 *    run. No age heuristic is needed, and none is used.
 *  - A match must be anchored to a Firefox OBJDIR. `xpcshell` and
 *    `server.js` are far too generic on their own; the same rule
 *    `mochitest-server-port.ts` applies to the httpd holder applies here,
 *    for the same reason — FireForge has no business reporting, let alone
 *    terminating, a process it cannot attribute to the harness.
 *
 * `--reap-orphans` opts into termination. Without it the census is
 * report-only, exactly like the `Orphaned harness workers` doctor check
 * (which covers a DIFFERENT shape: reparented Python multiprocessing
 * workers, matched on PPID 1 and accumulated CPU time).
 */

import { toError } from '../utils/errors.js';
import { info, verbose, warn } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { parsePsDuration } from '../utils/ps-duration.js';

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
 * Harness helper executables/scripts. Every one of these is started by the
 * mochitest/xpcshell harness and is expected to die with it; none of them
 * is a thing a developer runs by hand.
 */
const HARNESS_HELPER_PATTERN =
  /\b(?:xpcshell|pywebsocket\w*|websocket_server\.py|ssltunnel|moz-http2|http2_server|httpd\.js|server\.js|runtests\.py|runxpcshelltests\.py)\b/;

/** Objdir provenance: an explicit objdir path, a `obj-…` path segment, or `_tests/`. */
function isObjdirAnchored(command: string, objDir: string | undefined): boolean {
  if (objDir !== undefined && objDir.length > 0 && command.includes(objDir)) return true;
  if (/[/\\]obj-[^/\\\s]*[/\\]/.test(command)) return true;
  return /[/\\]_tests[/\\]/.test(command);
}

/**
 * Scans `ps -axo pid=,ppid=,etime=,command=` output for surviving harness
 * helpers. Pure — fixture-testable without spawning anything.
 *
 * @param psOutput - Raw `ps` output
 * @param objDir - Absolute objdir of this project, when known; widens the
 *   provenance test beyond the generic `obj-…` path segment
 * @param selfPid - This process's pid, excluded so FireForge cannot report
 *   itself
 */
export function findOrphanedHarnessProcesses(
  psOutput: string,
  objDir?: string,
  selfPid: number = process.pid
): OrphanedHarnessProcess[] {
  const found: OrphanedHarnessProcess[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const elapsed = match[3] ?? '';
    const command = (match[4] ?? '').trim();
    if (pid === selfPid || ppid === selfPid) continue;
    if (!HARNESS_HELPER_PATTERN.test(command)) continue;
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

/** Longest command excerpt carried into the report line. */
const COMMAND_EXCERPT_LIMIT = 160;

/**
 * Renders the census. Names every process with its elapsed time, because
 * "a leftover harness process exists" and "a leftover harness process has
 * been burning a core for 58 minutes" are different findings.
 */
export function formatOrphanReport(orphans: readonly OrphanedHarnessProcess[]): string {
  const rows = orphans
    .map(
      (p) =>
        `  PID ${String(p.pid)} (up ${p.elapsed}): ${p.command.slice(0, COMMAND_EXCERPT_LIMIT)}`
    )
    .join('\n');
  const pids = orphans.map((p) => String(p.pid)).join(' ');
  return (
    `${String(orphans.length)} harness helper process(es) from an EARLIER run are still alive ` +
    `(this preflight runs before the current run spawns anything, so none of these belong to ` +
    `it):\n${rows}\n` +
    `Survivors like these slow every later run without appearing anywhere in its output — a ` +
    `three-second suite taking minutes of wall clock is the usual symptom. Terminate them with ` +
    `"kill ${pids}", or re-run with --reap-orphans to have FireForge do it.`
  );
}

/** Thin exec wrapper for the process listing (tests mock `exec` instead). */
async function listSystemProcesses(): Promise<string> {
  const result = await exec('ps', ['-axo', 'pid=,ppid=,etime=,command='], { timeout: 10000 });
  if (result.exitCode !== 0) {
    throw new Error(`ps exited ${String(result.exitCode)}`);
  }
  return result.stdout;
}

/**
 * Preflight census of surviving harness helpers, run before a test
 * dispatch.
 *
 * Best-effort by construction: a host without a usable `ps` (Windows, a
 * locked-down container) logs at verbose and runs exactly as before. It
 * never refuses a run — unlike the server-port preflight, a survivor here
 * degrades performance rather than making the run dispatch against the
 * wrong server, so the correct response is to say so loudly, not to stop.
 *
 * @param objDir - Absolute objdir of this project, when known
 * @param options - `reap` terminates each recognized survivor (SIGTERM,
 *   then SIGKILL for anything that stays)
 * @returns The census, empty when nothing was found or nothing could be probed
 */
export async function reportOrphanedHarnessProcesses(
  objDir: string | undefined,
  options: { reap?: boolean } = {}
): Promise<OrphanedHarnessProcess[]> {
  if (process.platform === 'win32') return [];
  let psOutput: string;
  try {
    psOutput = await listSystemProcesses();
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
    await reapOrphanedHarnessProcesses(orphans);
  }
  return orphans;
}

/**
 * Terminates each census entry: SIGTERM first, then SIGKILL for anything
 * still alive. Failures are reported, never thrown — a process that exited
 * between the census and the signal is the common case, not an error.
 */
async function reapOrphanedHarnessProcesses(
  orphans: readonly OrphanedHarnessProcess[]
): Promise<void> {
  for (const orphan of orphans) {
    try {
      process.kill(orphan.pid, 'SIGTERM');
    } catch (error: unknown) {
      verbose(
        `--reap-orphans: SIGTERM to ${String(orphan.pid)} failed (${toError(error).message}).`
      );
      continue;
    }
    // Grace period before escalating: the httpd shape in the field
    // incident ignored SIGTERM while spinning, but an ordinary helper exits
    // promptly and must not be SIGKILLed for being slow by a millisecond.
    await new Promise((resolve) => setTimeout(resolve, REAP_GRACE_MS));
    let alive = true;
    try {
      process.kill(orphan.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(orphan.pid, 'SIGKILL');
      } catch (error: unknown) {
        verbose(
          `--reap-orphans: SIGKILL to ${String(orphan.pid)} failed (${toError(error).message}).`
        );
      }
    }
    info(`--reap-orphans: terminated PID ${String(orphan.pid)}.`);
  }
}
