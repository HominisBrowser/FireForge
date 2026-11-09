// SPDX-License-Identifier: EUPL-1.2
/**
 * Exact process identity: the kernel's birth record for a PID.
 *
 * A PID alone never grants signalling authority, because the kernel reuses
 * it. Identity is the PID plus an opaque `start` string:
 *
 *  - Linux: `<boot id>:<starttime ticks>` from `/proc/<pid>/stat`. The ticks
 *    are boot-relative and immune to clock steps, and `lstart` is not, since
 *    procps derives it from a boot time that moves with the clock.
 *  - macOS: the `lstart` second from `ps`, which is the process record's
 *    `p_starttime`, fixed at fork. One second is enough: PIDs are allocated
 *    sequentially and wrap at 99,999, so reusing a PID inside the second it
 *    was born takes about 100,000 forks in one second.
 *
 * The periodic path is {@link snapshotProcesses}: one asynchronous listing
 * that carries every birth, parent and group from a single kernel read, so
 * ancestry and identity need no separate probes. The synchronous single-PID
 * forms cost one `ps` on macOS (about 15 ms of blocked event loop) and exist
 * for one-off checks, never for a timer. A long-running process uses the
 * `Async` forms.
 */
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from './errors.js';
import {
  countListingLines,
  parseProcessListing,
  PS_BINARY,
  PS_ENV,
  psArguments,
} from './process-listing.js';

/** A process's exact identity. */
export interface ProcessBirth {
  pid: number;
  start: string;
}

/** A live process as one observation saw it. */
export interface ProcessObservation extends ProcessBirth {
  parent: number;
  group: number;
}

/** Every live, non-zombie process, by pid, from one read of the process table. */
export type ProcessSnapshot = ReadonlyMap<number, ProcessObservation>;

const PS_COLUMNS = ['pid', 'ppid', 'pgid', 'lstart', 'stat'] as const;

/** Generous on purpose: a timeout here means "unknown", which callers escalate. */
const PS_TIMEOUT_MS = 5_000;

const PS_MAX_BUFFER = 16 * 1024 * 1024;

const PROC_ROOT = '/proc';

/**
 * Reads the fields of `/proc/<pid>/stat`.
 *
 * `comm` (field 2) is parenthesised and may contain spaces or parentheses, so
 * only what follows the last closing paren is split: field 3 (state) is index
 * 0, parent 1, group 2, and field 22 (starttime) index 19.
 *
 * @returns `state`, `parent`, `group` and `startTick`, or undefined for damaged text
 */
function parseProcStat(
  stat: string
): { state: string; parent: number; group: number; startTick: number } | undefined {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const [state, parent, group] = fields;
  const startTick = Number(fields[19]);
  if (
    state === undefined ||
    !Number.isSafeInteger(startTick) ||
    !Number.isSafeInteger(Number(parent)) ||
    !Number.isSafeInteger(Number(group))
  ) {
    return undefined;
  }
  return { state, parent: Number(parent), group: Number(group), startTick };
}

function fromProcStat(pid: number, stat: string, bootId: string): ProcessObservation | undefined {
  const parsed = parseProcStat(stat);
  if (parsed === undefined || parsed.state === 'Z' || parsed.state === 'X') return undefined;
  return {
    pid,
    start: `${bootId}:${parsed.startTick}`,
    parent: parsed.parent,
    group: parsed.group,
  };
}

function fromPsRow(row: {
  pid: number;
  ppid: number;
  pgid: number;
  lstart: string;
  stat: string;
}): ProcessObservation | undefined {
  if (row.stat.startsWith('Z')) return undefined;
  return { pid: row.pid, start: row.lstart, parent: row.ppid, group: row.pgid };
}

/**
 * Builds a snapshot from `ps` output. A line that does not parse makes the
 * whole snapshot unknown: a process that vanished from the census would read
 * as an exited one.
 */
function snapshotFromListing(text: string): ProcessSnapshot | undefined {
  const rows = parseProcessListing(text, PS_COLUMNS);
  if (rows.length === 0 || rows.length !== countListingLines(text)) return undefined;
  const snapshot = new Map<number, ProcessObservation>();
  for (const row of rows) {
    const observation = fromPsRow(row);
    if (observation !== undefined) snapshot.set(row.pid, observation);
  }
  return snapshot;
}

/**
 * The process table as procfs shows it, in one asynchronous pass.
 *
 * @param procRoot - procfs mount, overridable for fixtures
 * @returns The snapshot, or undefined when procfs is not readable
 */
export async function snapshotFromProcfs(
  procRoot: string = PROC_ROOT
): Promise<ProcessSnapshot | undefined> {
  try {
    const bootId = (await readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim();
    const pids = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name)).map(Number);
    const snapshot = new Map<number, ProcessObservation>();
    await Promise.all(
      pids.map(async (pid) => {
        let stat: string;
        try {
          stat = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
        } catch {
          // Exited between the listing and this read.
          return;
        }
        const observation = fromProcStat(pid, stat, bootId);
        if (observation !== undefined) snapshot.set(pid, observation);
      })
    );
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Runs the pinned `ps` asynchronously and hands back whether it failed and what it printed. */
function runPs(args: readonly string[]): Promise<{ failed: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      PS_BINARY,
      [...args],
      {
        cwd: '/',
        env: { ...PS_ENV },
        encoding: 'utf8',
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER,
      },
      (error, stdout) => {
        resolve({ failed: error !== null, stdout });
      }
    );
  });
}

/**
 * Reads the whole process table without blocking the event loop.
 *
 * @returns The snapshot, or undefined when it could not be taken. Undefined is
 *   "unknown", never "no processes".
 */
export async function snapshotProcesses(): Promise<ProcessSnapshot | undefined> {
  if (process.platform === 'linux') return snapshotFromProcfs();
  if (process.platform !== 'darwin') return undefined;
  const { failed, stdout } = await runPs(psArguments(PS_COLUMNS));
  return failed ? undefined : snapshotFromListing(stdout);
}

/**
 * Reads the command lines of the given processes. Failure and an exited pid
 * both produce no entry, which grants nothing to a caller deciding authority.
 *
 * @param pids - Processes to look up
 * @returns Command line by pid
 */
export async function readProcessCommands(pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  // `ps -p` exits 1 when any listed pid is gone while still printing the rest,
  // so the exit status says nothing here.
  const { stdout } = await runPs(psArguments(['pid', 'command'], pids));
  const rows = parseProcessListing(stdout, ['pid', 'command'] as const);
  return new Map(rows.map((row) => [row.pid, row.command]));
}

/**
 * Observes one process.
 *
 * @param pid - Process to look up
 * @returns The observation, or undefined when the PID is gone, is a zombie, or
 *   the probe failed. {@link processHasExitedAsync} separates those.
 */
function observeProcess(pid: number): ProcessObservation | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      return fromProcStat(
        pid,
        readFileSync(join(PROC_ROOT, String(pid), 'stat'), 'utf8'),
        readFileSync(join(PROC_ROOT, 'sys/kernel/random/boot_id'), 'utf8').trim()
      );
    }
    if (process.platform !== 'darwin') return undefined;
    const text = execFileSync(PS_BINARY, [...psArguments(PS_COLUMNS, [pid])], {
      cwd: '/',
      env: { ...PS_ENV },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 4096,
    });
    const row = parseProcessListing(text, PS_COLUMNS)[0];
    return row?.pid === pid ? fromPsRow(row) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * {@link observeProcess} without blocking the event loop.
 *
 * @param pid - Process to look up
 * @returns The observation, or undefined when the PID is gone, is a zombie, or
 *   the probe failed
 */
async function observeProcessAsync(pid: number): Promise<ProcessObservation | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try {
      return fromProcStat(
        pid,
        await readFile(join(PROC_ROOT, String(pid), 'stat'), 'utf8'),
        (await readFile(join(PROC_ROOT, 'sys/kernel/random/boot_id'), 'utf8')).trim()
      );
    } catch {
      return undefined;
    }
  }
  if (process.platform !== 'darwin') return undefined;
  const { stdout } = await runPs(psArguments(PS_COLUMNS, [pid]));
  const row = parseProcessListing(stdout, PS_COLUMNS)[0];
  return row?.pid === pid ? fromPsRow(row) : undefined;
}

/**
 * The exact identity of a live process, without blocking the event loop.
 *
 * @param pid - Process to look up
 */
export async function processIdentityAsync(pid: number): Promise<ProcessBirth | undefined> {
  const observed = await observeProcessAsync(pid);
  return observed ? { pid: observed.pid, start: observed.start } : undefined;
}

/**
 * The exact identity of a live process.
 *
 * @param pid - Process to look up
 */
export function processIdentity(pid: number): ProcessBirth | undefined {
  const observed = observeProcess(pid);
  return observed ? { pid: observed.pid, start: observed.start } : undefined;
}

/**
 * Whether `identity` is still alive. False covers "gone", "replaced" and "the
 * probe failed", so false is no proof of exit: use {@link processHasExitedAsync}
 * before treating a process as gone.
 *
 * @param identity - The recorded identity
 */
export function sameProcess(identity: ProcessBirth): boolean {
  return processIdentity(identity.pid)?.start === identity.start;
}

/**
 * Distinguishes a dead or replaced process from a probe that could not
 * establish its identity.
 *
 * @param identity - The recorded identity
 * @returns True only when the process is provably gone
 */
export async function processHasExitedAsync(identity: ProcessBirth): Promise<boolean> {
  const current = await processIdentityAsync(identity.pid);
  if (current !== undefined) return current.start !== identity.start;
  try {
    process.kill(identity.pid, 0);
    return false;
  } catch (error) {
    return getNodeErrorCode(error) === 'ESRCH';
  }
}

/**
 * Boot-relative start tick of a process from procfs, for a caller that polls
 * and cannot afford a `ps` per check. Linux only; elsewhere the read fails and
 * the answer is undefined.
 *
 * @param pid - Process to look up
 * @param procRoot - procfs mount, overridable for fixtures
 * @returns Start tick, or undefined when unobtainable
 */
export function readProcStartTick(pid: number, procRoot: string = PROC_ROOT): number | undefined {
  try {
    return parseProcStat(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'))?.startTick;
  } catch {
    return undefined;
  }
}

/**
 * Whether a snapshot shows `identity` alive.
 *
 * @param snapshot - One read of the process table
 * @param identity - The recorded identity
 */
export function isAliveIn(snapshot: ProcessSnapshot, identity: ProcessBirth): boolean {
  return snapshot.get(identity.pid)?.start === identity.start;
}

/**
 * The live members of a process group in a snapshot.
 *
 * @param snapshot - One read of the process table
 * @param group - Process group id
 */
export function groupMembers(snapshot: ProcessSnapshot, group: number): ProcessObservation[] {
  return [...snapshot.values()].filter((entry) => entry.group === group);
}

/**
 * Signals one process only if the snapshot still shows its exact identity.
 *
 * @param snapshot - A snapshot taken for this decision
 * @param identity - The positively owned process
 * @param signal - Signal to send
 * @returns True when the signal was delivered
 */
export function signalIfAlive(
  snapshot: ProcessSnapshot,
  identity: ProcessBirth,
  signal: NodeJS.Signals
): boolean {
  if (!isAliveIn(snapshot, identity)) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}
