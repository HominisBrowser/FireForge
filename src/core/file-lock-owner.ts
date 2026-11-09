// SPDX-License-Identifier: EUPL-1.2
/**
 * Owner record of a `withFileLock` directory: the file that says which
 * process holds the lock, so stale recovery can tell a dead holder from a
 * slow one and release can refuse to remove a lock it no longer owns.
 *
 * Split out of `file-lock.ts` so the record's format, its write-and-verify
 * contract, and the PID-reuse guard live in one place with their own tests.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { getNodeErrorCode, isProcessAlive, toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import {
  processHasExitedAsync,
  processIdentityAsync,
  readProcStartTick,
} from '../utils/process-birth.js';
import { sleep } from '../utils/sleep.js';

/**
 * Filename of a lock directory's owner record, relative to the lock dir.
 *
 * Re-exported by `file-lock.ts` so external readers (`tree-store.ts`) share
 * the constant instead of re-spelling `'pid'`. The file format is
 * documented on {@link readLockOwner}.
 */
export const LOCK_PID_FILE = 'pid';

/**
 * Prefix of the mechanical owner-record line that carries the acquisition
 * wall time. It lives among the metadata lines (line 3 onward), and the reader
 * lifts it out of `metadata`. Diagnostic only. See {@link START_TICK_PREFIX}
 * for the liveness field.
 */
const ACQUIRED_AT_PREFIX = 'acquired-at-ms=';

/**
 * Prefix of the owner-record line carrying the holder's own process start
 * tick (`/proc/self/stat` field 22, in USER_HZ since boot). Written only
 * where procfs exposes it (Linux). Boot-relative ticks are what the
 * PID-reuse guard compares: unlike a wall-clock time they are immune to
 * the clock being stepped by NTP/chrony/`date -s` between acquisition and
 * probe, and a process's start tick never changes for its lifetime, so the
 * comparison is exact rather than a tolerance window.
 */
export const START_TICK_PREFIX = 'start-tick=';

/**
 * Prefix of the owner-record line carrying the holder's birth where no cheap
 * start tick exists (macOS): the `ps` start time from `process-birth.ts`. It
 * costs a `ps` to compare, so only the stale probe compares it
 * ({@link isLockOwnerProvablyGone}), never a poll.
 */
const BIRTH_PREFIX = 'birth=';

/**
 * Prefix of the owner-record line naming a process group the holder started
 * while holding the lock. FireForge dies alone when SIGKILLed: a detached mach
 * group runs on, so a holder is not gone until its groups are too.
 */
const CHILD_GROUP_PREFIX = 'child-group=';

/**
 * How many times the post-write read-back is retried when the read itself
 * errors (not when the record is absent or differs). An on-access scanner
 * on Windows briefly holding the just-written file (`EBUSY`), or a FUSE
 * mount's momentary `EIO`, must not be indistinguishable from "the record
 * never landed": that verdict releases a lock this process has correctly
 * acquired and aborts the run before it starts.
 */
const READ_BACK_ATTEMPTS = 5;

/** Pause between read-back attempts. */
const READ_BACK_RETRY_MS = 20;

/**
 * Raised when the lock directory this process just created turned out not to
 * be its own: a reaper moved it aside, or another holder's record is in it. The
 * acquisition did not happen and the caller goes back to waiting. Nothing is
 * removed, because the path may belong to someone else by now.
 */
export class LockOwnerDisplacedError extends Error {
  constructor(lockPath: string) {
    super(`Lock ${lockPath} changed hands before its owner record landed`);
    this.name = 'LockOwnerDisplacedError';
  }
}

/**
 * Owner record read back from a lock directory's PID file.
 *
 * `token` is the per-acquisition UUID written on line 2 of the PID file,
 * `acquiredAtMs` the wall-clock time the record was written (diagnostic),
 * `startTick` the writer's boot-relative start tick and `birth` its `ps` start
 * time (liveness), and `childGroups` the process groups it started. A field
 * absent from a record is "unknown", never a mismatch.
 *
 * `unreadable` marks a record that exists but could not be read (EMFILE, EIO,
 * EACCES). That says nothing about the holder, so it is never grounds to reap.
 */
export type LockOwner =
  | { present: false; unreadable?: true }
  | {
      present: true;
      pid: number;
      token?: string;
      acquiredAtMs?: number;
      startTick?: number;
      birth?: string;
      childGroups?: number[];
      metadata: string[];
    };

/** The parsed shape of a record whose PID line is a finite integer. */
type PresentLockOwner = Extract<LockOwner, { present: true }>;

/**
 * Parses the on-disk record text. Returns `undefined` when the PID line
 * does not parse as a finite integer.
 */
function parseLockOwnerRecord(pidContent: string): PresentLockOwner | undefined {
  const [pidLine, tokenLine, ...trailingLines] = pidContent.split('\n');
  const pid = parseInt((pidLine ?? '').trim(), 10);
  if (!Number.isFinite(pid)) return undefined;
  const metadata: string[] = [];
  let acquiredAtMs: number | undefined;
  let startTick: number | undefined;
  let birth: string | undefined;
  const childGroups: number[] = [];
  for (const rawLine of trailingLines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith(ACQUIRED_AT_PREFIX)) {
      const parsed = Number.parseInt(line.slice(ACQUIRED_AT_PREFIX.length), 10);
      if (Number.isFinite(parsed)) acquiredAtMs ??= parsed;
      continue;
    }
    if (line.startsWith(START_TICK_PREFIX)) {
      const parsed = Number.parseInt(line.slice(START_TICK_PREFIX.length), 10);
      if (Number.isFinite(parsed)) startTick ??= parsed;
      continue;
    }
    if (line.startsWith(BIRTH_PREFIX)) {
      birth ??= line.slice(BIRTH_PREFIX.length);
      continue;
    }
    if (line.startsWith(CHILD_GROUP_PREFIX)) {
      const parsed = Number.parseInt(line.slice(CHILD_GROUP_PREFIX.length), 10);
      if (Number.isSafeInteger(parsed) && parsed > 1) childGroups.push(parsed);
      continue;
    }
    metadata.push(line);
  }
  const token = tokenLine?.trim();
  const owner: PresentLockOwner = { present: true, pid, metadata };
  if (token !== undefined && token.length > 0) owner.token = token;
  if (acquiredAtMs !== undefined) owner.acquiredAtMs = acquiredAtMs;
  if (startTick !== undefined) owner.startTick = startTick;
  if (birth !== undefined) owner.birth = birth;
  if (childGroups.length > 0) owner.childGroups = childGroups;
  return owner;
}

/**
 * Reads the owner PID (line 1), acquisition token (line 2), the mechanical
 * lines (when present), and diagnostic metadata (the remaining lines 3+) from a
 * lock directory's PID file. Returns `{ present: false }` when the PID file is
 * missing or the PID does not parse as a finite integer (the caller falls back
 * to the age-only staleness heuristic), and adds `unreadable` when the file
 * could not be read at all.
 *
 * File format note: external readers do `parseInt(content.trim(), 10)`,
 * which parses the leading digits of a multi-line file, so the token and
 * mechanical lines stay compatible.
 *
 * @param lockPath - Lock directory whose owner record to read
 * @returns The parsed owner record, or `{ present: false }`
 */
export async function readLockOwner(lockPath: string): Promise<LockOwner> {
  try {
    const owner = parseLockOwnerRecord(await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8'));
    if (owner !== undefined) return owner;
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { present: false, unreadable: true };
  }
  return { present: false };
}

/**
 * Reads the just-written record back, retrying a read error a few times
 * before giving up. A missing or malformed record is returned as-is (the
 * caller treats it as a failed write). Only errno-level failures retry.
 */
async function readBackLockOwner(lockPath: string): Promise<PresentLockOwner | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt++) {
    try {
      return parseLockOwnerRecord(await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8'));
    } catch (error: unknown) {
      lastError = error;
      if (attempt < READ_BACK_ATTEMPTS - 1) await sleep(READ_BACK_RETRY_MS);
    }
  }
  throw new Error(`owner record could not be read back: ${toError(lastError).message}`);
}

let ownBirth: Promise<string | undefined> | undefined;

/**
 * This process's birth for an owner record, on the platform whose start time
 * has no cheap per-poll form. A process's birth never changes, so one lookup
 * serves every lock it takes.
 */
function readOwnBirth(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  ownBirth ??= processIdentityAsync(process.pid).then((identity) => identity?.start);
  return ownBirth;
}

/** Writes the record once, refusing a directory that already has one. */
async function writeRecordExclusive(lockPath: string, record: string): Promise<void> {
  const path = join(lockPath, LOCK_PID_FILE);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeFile(path, record, { encoding: 'utf-8', flag: 'wx' });
      return;
    } catch (error: unknown) {
      const code = getNodeErrorCode(error);
      if (code === 'EEXIST') throw new LockOwnerDisplacedError(lockPath);
      if (code !== 'ENOENT') throw error;
      // A reaper has the directory aside to look at it, and puts a young lock
      // back in a moment. Past that, it is someone else's.
      if (attempt >= READ_BACK_ATTEMPTS) throw new LockOwnerDisplacedError(lockPath);
      await sleep(READ_BACK_RETRY_MS);
    }
  }
}

/**
 * Stamps this process's ownership (PID, per-acquisition token, acquisition
 * time, own start identity, diagnostic metadata) into a lock directory it has
 * just created, and reads the record back to prove it landed.
 *
 * A failed write is fatal rather than best-effort. Stale recovery could fall
 * back to the age heuristic, but that heuristic reaps any owner-less lock
 * after five minutes, and the build lock legitimately holds for hours. A
 * holder whose record failed to write would be reaped mid-build and a
 * second process would enter the critical section. On
 * failure the just-created lock directory is removed and a
 * {@link GeneralError} names the cause.
 *
 * @param lockPath - Lock directory this process has just `mkdir`'d
 * @param token - Per-acquisition UUID, later checked by release
 * @param ownerMetadata - Extra human-diagnostic lines (see `FileLockOptions.ownerMetadata`)
 * @throws {LockOwnerDisplacedError} When the directory stopped being this process's own
 * @throws {GeneralError} When the record cannot be written or does not read back as written
 */
export async function writeLockOwner(
  lockPath: string,
  token: string,
  ownerMetadata: readonly string[] | undefined
): Promise<void> {
  const metadata =
    ownerMetadata
      ?.map((line) => line.replace(/\r?\n/g, ' ').trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith(ACQUIRED_AT_PREFIX) &&
          !line.startsWith(START_TICK_PREFIX) &&
          !line.startsWith(BIRTH_PREFIX) &&
          !line.startsWith(CHILD_GROUP_PREFIX)
      ) ?? [];
  const ownStartTick = readProcessStartTick(process.pid);
  const birth = await readOwnBirth();
  const mechanicalLines = [
    `${ACQUIRED_AT_PREFIX}${Date.now()}`,
    ...(ownStartTick === undefined ? [] : [`${START_TICK_PREFIX}${ownStartTick}`]),
    ...(birth === undefined ? [] : [`${BIRTH_PREFIX}${birth}`]),
  ];
  const record = `${process.pid}\n${token}\n${[...mechanicalLines, ...metadata].map((line) => `${line}\n`).join('')}`;
  let failure: unknown;
  try {
    await writeRecordExclusive(lockPath, record);
    const readBack = await readBackLockOwner(lockPath);
    if (readBack !== undefined && readBack.pid === process.pid && readBack.token === token) {
      return;
    }
    if (readBack !== undefined) throw new LockOwnerDisplacedError(lockPath);
    failure = new Error('owner record did not read back as written');
  } catch (error: unknown) {
    if (error instanceof LockOwnerDisplacedError) throw error;
    failure = error;
  }
  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch (cleanupError: unknown) {
    verbose(`Could not remove unowned lock ${lockPath}: ${toError(cleanupError).message}`);
  }
  throw new GeneralError(
    `Could not record ownership of lock ${lockPath}: ${toError(failure).message}. ` +
      'The lock was released without running the operation — a lock with no readable owner ' +
      'would be reaped as stale after five minutes and a second process could enter the ' +
      'critical section. Check permissions and free space on the lock directory, then retry.',
    failure
  );
}

/**
 * Boot-relative start tick of a process, where the platform exposes it
 * cheaply.
 *
 * Linux only: field 22 of `/proc/<pid>/stat`, in USER_HZ since boot. Elsewhere
 * a start time takes a `ps`, which is not worth paying on every poll of a
 * contended lock, so this returns `undefined` and the poll stays PID-only.
 *
 * Not converted to wall-clock time via `/proc/stat` `btime`, on purpose:
 * on current kernels `btime` is derived from the realtime clock and moves
 * with every clock step, so a wall-clock comparison against a recorded
 * acquisition time misjudges a live holder as a reused PID after NTP steps
 * the clock forward, and reaps a lock that is in use.
 *
 * @param pid - Process to look up
 * @param procRoot - procfs mount, overridable for tests
 * @returns Start tick, or `undefined` when unobtainable
 */
export function readProcessStartTick(pid: number, procRoot = '/proc'): number | undefined {
  return readProcStartTick(pid, procRoot);
}

/** Whether a process group still has members. A group that denies the probe exists. */
function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error: unknown) {
    return getNodeErrorCode(error) !== 'ESRCH';
  }
}

/**
 * Whether the process named by a lock's owner record is the same process
 * that acquired the lock, or a process group it started is still running.
 *
 * `isProcessAlive` answers "does this PID exist". After a holder crashes,
 * the kernel may hand its PID to a long-lived daemon, and a PID-only check
 * then honours the dead lock until the waiter's timeout. Where the record
 * carries the writer's start tick and the candidate's own tick is cheaply
 * obtainable (see {@link readProcessStartTick}), the two must be equal: a
 * different tick is a different process. Records without a start tick, and
 * platforms without one, keep the PID-only answer here; the stale probe
 * settles those with {@link isLockOwnerProvablyGone}.
 *
 * A holder SIGKILLed mid-build leaves its detached group running against the
 * objdir the lock protects, so the lock stays held until the group is empty.
 * A group id reused after that errs toward waiting, never toward theft.
 *
 * @param owner - Owner record fields that identify the holder
 * @param procRoot - procfs mount, overridable for tests
 * @returns True when the holder or one of its groups is still running (or cannot be proven gone)
 */
export function isLockOwnerAlive(
  owner: { pid: number; startTick?: number | undefined; childGroups?: number[] | undefined },
  procRoot?: string
): boolean {
  if (isHolderProcessAlive(owner, procRoot)) return true;
  return (owner.childGroups ?? []).some(isProcessGroupAlive);
}

function isHolderProcessAlive(
  owner: { pid: number; startTick?: number | undefined },
  procRoot: string | undefined
): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (owner.startTick === undefined) return true;
  const currentStartTick = readProcessStartTick(owner.pid, procRoot);
  if (currentStartTick === undefined) return true;
  if (currentStartTick !== owner.startTick) {
    verbose(
      `Lock owner PID ${owner.pid} started at tick ${currentStartTick}, but the ` +
        `record was written by a process started at tick ${owner.startTick} — the PID was ` +
        'reused; treating the holder as dead'
    );
    return false;
  }
  return true;
}

/**
 * {@link isLockOwnerAlive}'s negation, plus the recorded birth where comparing
 * it takes a `ps`. For the stale probe, which runs every few seconds rather than
 * on every poll. Waits on the probe without blocking the event loop.
 *
 * @param owner - The owner record
 * @returns True only when neither the holder nor any of its groups can be running
 */
export async function isLockOwnerProvablyGone(
  owner: Extract<LockOwner, { present: true }>
): Promise<boolean> {
  if (!isLockOwnerAlive(owner)) return true;
  if (owner.birth === undefined) return false;
  if ((owner.childGroups ?? []).some(isProcessGroupAlive)) return false;
  return processHasExitedAsync({ pid: owner.pid, start: owner.birth });
}

/**
 * Names a process group in a lock's owner record. Synchronous on purpose: it
 * runs right after the spawn, before the group can outlive this process. Failure
 * only loses the extra protection, so it is logged and otherwise ignored.
 *
 * @param lockPath - A lock directory this process holds
 * @param pgid - The group it just started
 */
export function recordChildGroup(lockPath: string, pgid: number): void {
  try {
    appendFileSync(join(lockPath, LOCK_PID_FILE), `${CHILD_GROUP_PREFIX}${pgid}\n`);
  } catch (error: unknown) {
    verbose(`Could not record child group ${pgid} on ${lockPath}: ${toError(error).message}`);
  }
}

/**
 * Drops a finished process group from a lock's owner record, so that a later
 * reuse of its id cannot hold the lock. The replacement is atomic, since a
 * contender may read the record at any moment. Failure errs toward waiting.
 *
 * @param lockPath - A lock directory this process holds
 * @param pgid - The group whose teardown established it is gone
 */
export function forgetChildGroup(lockPath: string, pgid: number): void {
  const path = join(lockPath, LOCK_PID_FILE);
  const scratch = `${path}.${process.pid}.tmp`;
  try {
    const kept = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== `${CHILD_GROUP_PREFIX}${pgid}`);
    writeFileSync(scratch, kept.join('\n'));
    renameSync(scratch, path);
  } catch (error: unknown) {
    verbose(`Could not drop child group ${pgid} from ${lockPath}: ${toError(error).message}`);
  }
}
