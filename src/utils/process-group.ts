// SPDX-License-Identifier: EUPL-1.2
/**
 * Process-group kill and post-run sweep helpers for the exec layer
 * (0.37.0 item 9a). Split out of `process.ts` to keep that file within the
 * per-file line budget; deliberately spawn-based (not `exec`-based) so the
 * two modules do not import each other cyclically.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { getNodeErrorCode } from './errors.js';
import { verbose, warn } from './logger.js';

/**
 * Sends `signal` to the child's whole tree: the process GROUP on POSIX
 * (negative-PID kill — reaches mach → python → firefox → content-process
 * chains), or a `taskkill /T /F` tree kill plus a direct `child.kill`
 * fallback on Windows. No-ops once the direct child has exited (group
 * survivors after exit are the post-run sweep's job, not this function's).
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  usesProcessGroup: boolean
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const targetPid = child.pid;
  if (targetPid === undefined) return;
  try {
    if (usesProcessGroup) {
      // Negative PID routes to the process group, killing the Python
      // wrapper, the firefox it forked, and every content process
      // that inherited the group.
      process.kill(-targetPid, signal);
    } else {
      // No process group on Windows — taskkill /T walks the descendant
      // tree instead. Always forced (/F): there is no SIGTERM analogue,
      // so the grace window only exists on POSIX.
      spawn('taskkill', ['/pid', String(targetPid), '/T', '/F'], {
        stdio: 'ignore',
      }).on('error', () => {
        // taskkill unavailable — nothing more we can do beyond the
        // direct-child kill below.
      });
      child.kill(signal);
    }
  } catch {
    // Already gone. Nothing to do.
  }
}

/** One process still alive in a swept group. */
export interface ProcessGroupSurvivor {
  /** PID, or -1 when pgrep was unavailable and only a liveness probe ran. */
  pid: number;
  /** Command line (pgrep -lf output), best-effort. */
  command: string;
}

const SWEEP_GRACE_MS = 2000;
const MULTIPROCESSING_WORKER_PATTERN = /multiprocessing\.(?:spawn|forkserver)|resource_tracker/;

function sweepDelay(ms: number): Promise<void> {
  // Deliberately ref'd (no unref()): this promise is AWAITED between the
  // group SIGTERM and the post-grace re-list/SIGKILL escalation, from a
  // child 'close' handler after the signal forwarder is disposed — with an
  // unref'd timer nothing kept the event loop alive, so Node could exit
  // mid-grace and skip the escalation entirely. Healthy runs never reach
  // this function (sweepProcessGroup early-returns on zero survivors), so
  // the ref never holds a clean exit open.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Minimal spawn-based pgrep runner. exitCode -1 means pgrep itself was
 * unavailable or errored (distinct from exit 1 = "no matches").
 */
async function runPgrep(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('pgrep', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.on('error', () => {
      resolve({ exitCode: -1, stdout: '' });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout });
    });
  });
}

/** Lists processes still in `pgid` via `pgrep -g -lf`, with a kill(0) fallback. */
async function listGroupSurvivors(pgid: number): Promise<ProcessGroupSurvivor[]> {
  const result = await runPgrep(['-g', String(pgid), '-lf']);
  if (result.exitCode === 0) {
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = /^(\d+)\s+(.*)$/.exec(line);
        return match
          ? { pid: Number(match[1]), command: match[2] ?? '' }
          : { pid: -1, command: line };
      });
  }
  if (result.exitCode === 1) return []; // no matches
  // pgrep unavailable/broken: fall back to a group liveness probe.
  try {
    process.kill(-pgid, 0);
    return [{ pid: -1, command: 'unknown (pgrep unavailable; group still has live members)' }];
  } catch (error: unknown) {
    // Same errno semantics as `isProcessAlive` (which cannot be called here —
    // it probes a single positive pid): only ESRCH proves the group is gone.
    // EPERM means it exists under another uid, and an unrecognized failure is
    // not evidence of absence — report survivors in both cases.
    if (getNodeErrorCode(error) === 'ESRCH') return [];
    return [{ pid: -1, command: 'unknown (pgrep unavailable; group liveness probe denied)' }];
  }
}

function describeSurvivors(list: ProcessGroupSurvivor[]): string {
  return list
    .map((s) => {
      const tag = MULTIPROCESSING_WORKER_PATTERN.test(s.command)
        ? ' [multiprocessing worker — the known busy-spin orphan shape]'
        : '';
      return `PID ${String(s.pid)}: ${s.command}${tag}`;
    })
    .join('; ');
}

/**
 * Post-run reaper for a process group FireForge itself spawned (`pgid` is
 * the PID of a child started with `detached: true`): lists survivors,
 * SIGTERMs the group, waits a short grace, escalates to SIGKILL, and warns
 * about anything that still refuses to die. POSIX only (no-op on win32).
 * The only kill target is `-pgid` — never anything outside the group.
 * A healthy run costs exactly one `pgrep`.
 */
export async function sweepProcessGroup(
  pgid: number,
  graceMs: number = SWEEP_GRACE_MS
): Promise<{ survivors: ProcessGroupSurvivor[] }> {
  if (process.platform === 'win32') return { survivors: [] };
  const survivors = await listGroupSurvivors(pgid);
  if (survivors.length === 0) return { survivors };

  warn(
    `Harness process group ${String(pgid)} left ${String(survivors.length)} surviving ` +
      `process(es) after exit — reaping the group. ${describeSurvivors(survivors)}`
  );

  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // The group vanished between the listing and the signal — nothing left to
    // escalate against, so report the survivors collected so far.
    return { survivors };
  }
  await sweepDelay(graceMs);
  let remaining = await listGroupSurvivors(pgid);
  if (remaining.length > 0) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // The group died during the grace period, so the SIGKILL escalation has
      // nothing to signal.
      return { survivors };
    }
    await sweepDelay(Math.min(200, graceMs));
    remaining = await listGroupSurvivors(pgid);
    if (remaining.length > 0) {
      warn(
        `Process group ${String(pgid)} still has survivors after SIGKILL: ${describeSurvivors(remaining)}. ` +
          'Inspect manually (ps -axo pid,ppid,time,command) and kill by PID.'
      );
    } else {
      verbose(`Process group ${String(pgid)} reaped after SIGKILL escalation.`);
    }
  } else {
    verbose(`Process group ${String(pgid)} reaped cleanly with SIGTERM.`);
  }
  return { survivors };
}
