// SPDX-License-Identifier: EUPL-1.2
/**
 * Accumulated-CPU-time probe for a single PID.
 *
 * Exists to answer the one question `kill(pid, 0)` cannot: a lock holder
 * that EXISTS may still be wedged. A downstream fork running five concurrent
 * sessions on one checkout diagnosed exactly this by hand — "a holder at
 * near-zero CPU is hung, not working" — after a queue stalled behind a
 * command that had consumed 0.3 s of CPU in eleven minutes.
 *
 * It is reported as EVIDENCE, never as a verdict. A legitimately slow holder
 * can also sit at low CPU while blocked on I/O or on a child process, so
 * nothing keys a refusal, a kill, or a lock steal off this number.
 */
import { exec } from '../utils/process.js';
import { parsePsDuration } from '../utils/ps-duration.js';

/**
 * Reads a process's accumulated CPU seconds.
 *
 * Best-effort: a missing `ps`, an exited process, or an unparseable field
 * yields `undefined`, which callers must render as "unknown" rather than as
 * zero — reporting a live build as having used no CPU would invert the very
 * diagnosis this exists for.
 *
 * @param pid - Process to inspect
 * @returns Accumulated CPU seconds, or `undefined` when unmeasurable
 */
export async function readProcessCpuSeconds(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'win32') {
      const result = await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`,
      ]);
      const seconds = Number.parseFloat(result.stdout.trim());
      return Number.isFinite(seconds) ? seconds : undefined;
    }
    const result = await exec('ps', ['-p', String(pid), '-o', 'time=']);
    const field = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (field === undefined) return undefined;
    const seconds = parsePsDuration(field);
    return Number.isNaN(seconds) ? undefined : seconds;
  } catch {
    return undefined;
  }
}
