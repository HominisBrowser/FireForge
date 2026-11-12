// SPDX-License-Identifier: EUPL-1.2
/**
 * Exact process identity: the kernel's birth record for a pid.
 *
 * A pid alone never grants authority to signal or to call a lock holder
 * alive, because the kernel reuses it. Identity is the pid plus an opaque
 * `start` string:
 *
 *  - Linux: `<boot id>:<starttime ticks>` from `/proc/<pid>/stat`. The ticks
 *    are boot-relative and immune to clock steps.
 *  - macOS: the `lstart` second from `ps`, fixed at fork. One second is
 *    enough: pids are allocated sequentially, so reusing one inside the
 *    second it was born takes a full wrap of the pid space in that second.
 *
 * The periodic path is {@link snapshotProcesses}: one asynchronous listing
 * carrying every birth, parent and group. A single-pid probe costs one `ps`
 * on macOS, so callers that poll use {@link isIdentityAlive} between probes.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errnoCode } from '../errors.js';
import { sleep } from '../time.js';
import {
  countListingLines,
  parseProcessListing,
  type ProcessColumn,
  type ProcessRow,
  PS_BINARY,
  PS_ENV,
  psArguments,
} from './listing.js';

/** A process's exact identity. */
export interface ProcessIdentity {
  pid: number;
  start: string;
}

/** A live process as one observation saw it. */
export interface ProcessObservation extends ProcessIdentity {
  parent: number;
  group: number;
}

/** Every live, non-zombie process, by pid, from one read of the process table. */
export type ProcessSnapshot = ReadonlyMap<number, ProcessObservation>;

const SNAPSHOT_COLUMNS = ['pid', 'ppid', 'pgid', 'lstart', 'stat'] as const;

/** Generous on purpose: a timeout here means "unknown", which callers treat as alive. */
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 16 * 1024 * 1024;
const PROC_ROOT = '/proc';

/**
 * Reads `/proc/<pid>/stat`. `comm` (field 2) is parenthesised and may contain
 * spaces or parentheses, so only what follows the last closing paren is
 * split: state is index 0, parent 1, group 2, and starttime (field 22) 19.
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

function fromPsRow(
  row: ProcessRow<(typeof SNAPSHOT_COLUMNS)[number]>
): ProcessObservation | undefined {
  if (row.stat.startsWith('Z')) return undefined;
  return { pid: row.pid, start: row.lstart, parent: row.ppid, group: row.pgid };
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
          return; // Exited between the listing and this read.
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
 * @returns The snapshot, or undefined when it could not be taken. Undefined
 *   is "unknown", never "no processes": one unparsable line makes the whole
 *   snapshot unknown, since a process missing from it would read as exited.
 */
export async function snapshotProcesses(): Promise<ProcessSnapshot | undefined> {
  if (process.platform === 'linux') return snapshotFromProcfs();
  if (process.platform !== 'darwin') return undefined;
  const { failed, stdout } = await runPs(psArguments(SNAPSHOT_COLUMNS));
  if (failed) return undefined;
  const rows = parseProcessListing(stdout, SNAPSHOT_COLUMNS);
  if (rows.length === 0 || rows.length !== countListingLines(stdout)) return undefined;
  const snapshot = new Map<number, ProcessObservation>();
  for (const row of rows) {
    const observation = fromPsRow(row);
    if (observation !== undefined) snapshot.set(row.pid, observation);
  }
  return snapshot;
}

/** What {@link listProcesses} lists. */
export interface ListProcessesOptions {
  /** Limit the listing to these pids. A pid that is gone produces no row. */
  pids?: readonly number[];
  /** Append each process's environment to a command column, as far as the platform shows it. */
  environment?: boolean;
}

/**
 * Lists processes with the requested `ps` columns, for diagnostics and
 * preflights. A failed listing yields no rows, which grants nothing to a
 * caller deciding authority.
 *
 * @param columns - Columns in output order; a rest-of-line column must be last
 * @param options - See {@link ListProcessesOptions}
 */
export async function listProcesses<C extends ProcessColumn>(
  columns: readonly C[],
  options: ListProcessesOptions = {}
): Promise<ProcessRow<C>[]> {
  if (options.pids?.length === 0) return [];
  // `ps -p` exits 1 when any listed pid is gone while still printing the rest,
  // so the exit status says nothing here.
  const { stdout } = await runPs(psArguments(columns, options.pids, options.environment === true));
  return parseProcessListing(stdout, columns);
}

let bootId: string | undefined;

function procfsIdentity(pid: number): ProcessObservation | undefined {
  bootId ??= readFileSync(join(PROC_ROOT, 'sys/kernel/random/boot_id'), 'utf8').trim();
  return fromProcStat(pid, readFileSync(join(PROC_ROOT, String(pid), 'stat'), 'utf8'), bootId);
}

/**
 * The exact identity of a live process.
 *
 * @param pid - Process to look up
 * @returns The identity, or undefined when the pid is gone, is a zombie, or
 *   the probe failed. {@link processHasExited} separates those.
 */
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let observed: ProcessObservation | undefined;
  if (process.platform === 'linux') {
    try {
      observed = procfsIdentity(pid);
    } catch {
      return undefined;
    }
  } else if (process.platform === 'darwin') {
    const { stdout } = await runPs(psArguments(SNAPSHOT_COLUMNS, [pid]));
    const row = parseProcessListing(stdout, SNAPSHOT_COLUMNS)[0];
    observed = row?.pid === pid ? fromPsRow(row) : undefined;
  }
  return observed === undefined ? undefined : { pid: observed.pid, start: observed.start };
}

let own: Promise<ProcessIdentity | undefined> | undefined;

/**
 * This process's identity. A birth never changes, so one lookup serves the
 * whole run. Undefined on a platform with no start record.
 */
export function ownIdentity(): Promise<ProcessIdentity | undefined> {
  own ??= processIdentity(process.pid);
  return own;
}

/**
 * Whether a pid exists, by `kill(pid, 0)`. Only `ESRCH` means no. `EPERM`
 * means a live process owned by another user, and any other answer is read as
 * alive: every caller uses "dead" to justify taking or deleting something.
 *
 * @param pid - Process to probe
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errnoCode(error) !== 'ESRCH';
  }
}

/**
 * Whether a process group still has members. A group that denies the probe exists.
 *
 * @param pgid - Group to probe
 */
export function isProcessGroupAlive(pgid: number): boolean {
  return pgid > 1 && isProcessAlive(-pgid);
}

/**
 * A cheap liveness answer for polling: the pid exists and, where comparing
 * costs no spawn (Linux), still has the recorded start. May say "alive" for a
 * reused pid elsewhere; {@link processHasExited} settles that.
 *
 * @param identity - The recorded identity; `start` may be unknown
 */
export function isIdentityAlive(identity: { pid: number; start?: string | undefined }): boolean {
  if (!isProcessAlive(identity.pid)) return false;
  if (identity.start === undefined || process.platform !== 'linux') return true;
  try {
    // An unreadable or zombie entry proves nothing, so it stays "alive".
    const current = procfsIdentity(identity.pid);
    return current === undefined || current.start === identity.start;
  } catch {
    return isProcessAlive(identity.pid);
  }
}

/**
 * Distinguishes a dead or replaced process from a probe that could not tell.
 *
 * @param identity - The recorded identity; without a `start` only the pid is judged
 * @returns True only when the process is provably gone
 */
export async function processHasExited(identity: {
  pid: number;
  start?: string | undefined;
}): Promise<boolean> {
  if (!isProcessAlive(identity.pid)) return true;
  if (identity.start === undefined) return false;
  const current = await processIdentity(identity.pid);
  if (current !== undefined) return current.start !== identity.start;
  // The probe saw nothing: either the process just exited, or the probe failed.
  return !isProcessAlive(identity.pid);
}

/**
 * Whether a snapshot shows `identity` alive.
 *
 * @param snapshot - One read of the process table
 * @param identity - The recorded identity
 */
export function isAliveIn(snapshot: ProcessSnapshot, identity: ProcessIdentity): boolean {
  return snapshot.get(identity.pid)?.start === identity.start;
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
  identity: ProcessIdentity,
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

/** What {@link terminateByIdentity} did. */
export interface IdentityTermination {
  /** Processes a fresh snapshot showed with their recorded birth, which received SIGTERM. */
  signalled: ProcessIdentity[];
  /** Signalled processes still alive with their birth afterwards; all of them when the table could not be read. */
  survivors: ProcessIdentity[];
}

const TERMINATION_POLL_MS = 100;
const KILL_SETTLE_DELAY_MS = 300;

/**
 * Terminates processes by exact identity: SIGTERM to each one a fresh
 * snapshot still shows with its recorded birth, a grace, then SIGKILL to any
 * that remains. A reused pid is never signalled.
 *
 * @param targets - The processes, as observed when they were judged owned
 * @param graceMs - Time between SIGTERM and SIGKILL
 */
export async function terminateByIdentity(
  targets: readonly ProcessIdentity[],
  graceMs: number
): Promise<IdentityTermination> {
  if (targets.length === 0) return { signalled: [], survivors: [] };
  const first = await snapshotProcesses();
  if (first === undefined) return { signalled: [], survivors: [...targets] };
  const signalled = targets.filter((target) => signalIfAlive(first, target, 'SIGTERM'));
  const aliveIn = (snapshot: ProcessSnapshot | undefined): ProcessIdentity[] =>
    snapshot === undefined ? [...signalled] : signalled.filter((t) => isAliveIn(snapshot, t));
  let current: ProcessSnapshot | undefined = first;
  for (const deadline = Date.now() + graceMs; Date.now() < deadline;) {
    await sleep(TERMINATION_POLL_MS);
    current = await snapshotProcesses();
    if (aliveIn(current).length === 0) return { signalled, survivors: [] };
  }
  if (current !== undefined) {
    for (const target of aliveIn(current)) signalIfAlive(current, target, 'SIGKILL');
    await sleep(KILL_SETTLE_DELAY_MS);
    current = await snapshotProcesses();
  }
  return { signalled, survivors: aliveIn(current) };
}
