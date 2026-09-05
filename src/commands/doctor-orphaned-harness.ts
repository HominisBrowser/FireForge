// SPDX-License-Identifier: EUPL-1.2
/**
 * Doctor check for PRE-EXISTING orphaned test-harness workers.
 *
 * A mach invocation that dies at harness startup can strand a Python
 * `multiprocessing` spawn worker plus its resource tracker; the worker
 * reparents to launchd (PPID 1) and busy-spins at 100% CPU indefinitely.
 * The dispatch-side fix is the process-group reaping in `utils/process.ts`;
 * this check covers orphans that predate it (or leaked from non-FireForge
 * invocations), detecting them by PPID 1 + large accumulated CPU TIME + a
 * `multiprocessing.spawn`/`resource_tracker` command line.
 *
 * Report-only by design: FireForge never kills pre-existing processes it did
 * not spawn — the check names each candidate and suggests the kill.
 *
 * Deliberately not wired into `test --canary`: a system-wide process scan on
 * the canary hot path buys no coverage the doctor check does not already
 * give.
 */

import type { DoctorCheck } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { exec } from '../utils/process.js';
import { parsePsDuration } from '../utils/ps-duration.js';
import type { DoctorCheckDefinition } from './doctor-check-core.js';
import { ok, warning } from './doctor-check-core.js';

/** One process matching the orphaned-harness-worker shape. */
export interface OrphanedHarnessWorker {
  pid: number;
  ppid: number;
  /** Raw TIME column as `ps` printed it. */
  cpuTime: string;
  /** Parsed accumulated CPU seconds. */
  cpuSeconds: number;
  command: string;
}

/**
 * Command-line shapes of Python multiprocessing helper processes: the
 * spawn/forkserver worker bootstrap (`from multiprocessing.spawn import
 * spawn_main; spawn_main(...)`) and the resource tracker.
 */
const HARNESS_WORKER_COMMAND_PATTERN =
  /multiprocessing\.(?:spawn|forkserver)\b|multiprocessing\.resource_tracker|from multiprocessing\.\w+ import/;

/** Minimum accumulated CPU time before a match is reported (10 minutes). */
const DEFAULT_MIN_CPU_SECONDS = 600;

/**
 * Scans `ps -axo pid=,ppid=,time=,command=` output for orphaned harness
 * workers: PPID 1 (reparented to init/launchd), a multiprocessing
 * worker/tracker command line, and at least `minCpuSeconds` of accumulated
 * CPU time. Pure — fixture-testable without spawning anything.
 */
export function findOrphanedHarnessWorkers(
  psOutput: string,
  minCpuSeconds: number = DEFAULT_MIN_CPU_SECONDS
): OrphanedHarnessWorker[] {
  const workers: OrphanedHarnessWorker[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuTime = match[3] ?? '';
    const command = (match[4] ?? '').trim();
    if (ppid !== 1) continue;
    if (!HARNESS_WORKER_COMMAND_PATTERN.test(command)) continue;
    const cpuSeconds = parsePsDuration(cpuTime);
    if (Number.isNaN(cpuSeconds) || cpuSeconds < minCpuSeconds) continue;
    workers.push({ pid, ppid, cpuTime, cpuSeconds, command });
  }
  return workers;
}

/** Thin exec wrapper for the process listing (tests mock `exec` instead). */
async function listSystemProcesses(): Promise<string> {
  const result = await exec('ps', ['-axo', 'pid=,ppid=,time=,command='], { timeout: 10000 });
  if (result.exitCode !== 0) {
    throw new Error(`ps exited ${result.exitCode}`);
  }
  return result.stdout;
}

const CHECK_NAME = 'Orphaned harness workers';

async function runOrphanedHarnessCheck(): Promise<DoctorCheck> {
  let psOutput: string;
  try {
    psOutput = await listSystemProcesses();
  } catch (error: unknown) {
    return warning(
      CHECK_NAME,
      `Could not scan system processes (${toError(error).message}); skipping the orphaned-worker check.`
    );
  }

  const orphans = findOrphanedHarnessWorkers(psOutput);
  if (orphans.length === 0) {
    return ok(CHECK_NAME);
  }

  const rows = orphans
    .map((w) => `PID ${w.pid} (CPU time ${w.cpuTime}): ${w.command.slice(0, 160)}`)
    .join('; ');
  const pids = orphans.map((w) => String(w.pid)).join(' ');
  return warning(
    CHECK_NAME,
    `Found ${orphans.length} orphaned Python multiprocessing worker(s) — PPID 1 with ` +
      `high accumulated CPU time, the shape a test harness that died at startup leaves behind ` +
      `(field incident: one such worker busy-spun for ~26 days). ${rows}`,
    `These look like workers orphaned by a crashed test harness. Verify each command line, ` +
      `then terminate with: kill ${pids} (or kill -9 if a process survives). ` +
      'FireForge never kills pre-existing processes automatically.'
  );
}

/**
 * Doctor check reporting orphaned harness workers. Windows has no `ps`;
 * the check is skipped there (best-effort platform gap, matching the
 * process-group reaper's POSIX-only sweep).
 */
export const ORPHANED_HARNESS_DOCTOR_CHECK: DoctorCheckDefinition = {
  name: CHECK_NAME,
  skipIf: () => process.platform === 'win32',
  run: runOrphanedHarnessCheck,
};
