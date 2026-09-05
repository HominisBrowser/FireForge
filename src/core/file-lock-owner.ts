// SPDX-License-Identifier: EUPL-1.2
/**
 * Owner record of a `withFileLock` directory: the file that says WHICH
 * process holds the lock, so stale recovery can tell a dead holder from a
 * slow one and release can refuse to remove a lock it no longer owns.
 *
 * Split out of `file-lock.ts` so the record's format, its write-and-verify
 * contract, and the PID-reuse guard live in one place with their own tests.
 */
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { isProcessAlive, toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

/**
 * Filename of a lock directory's owner record, relative to the lock dir.
 *
 * Re-exported by `file-lock.ts` so external readers (`tree-store.ts`) share
 * the constant instead of re-spelling `'pid'`; the file *format* is
 * documented on {@link readLockOwner}.
 */
export const LOCK_PID_FILE = 'pid';

/**
 * Prefix of the mechanical owner-record line that carries the acquisition
 * wall time. It lives among the metadata lines (line 3 onward) so older
 * readers, which treat everything past line 2 as free-form diagnostics,
 * still parse the record; the current reader lifts it out of `metadata`.
 * Diagnostic only — see {@link START_TICK_PREFIX} for the liveness field.
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
const START_TICK_PREFIX = 'start-tick=';

/**
 * How many times the post-write read-back is retried when the READ itself
 * errors (not when the record is absent or differs). An on-access scanner
 * on Windows briefly holding the just-written file (`EBUSY`), or a FUSE
 * mount's momentary `EIO`, must not be indistinguishable from "the record
 * never landed" — that verdict releases a lock this process has correctly
 * acquired and aborts the run before it starts.
 */
const READ_BACK_ATTEMPTS = 5;

/** Pause between read-back attempts. */
const READ_BACK_RETRY_MS = 20;

/**
 * Owner record read back from a lock directory's PID file.
 *
 * `token` is the per-acquisition UUID written on line 2 of the PID file,
 * `acquiredAtMs` the wall-clock time the record was written (diagnostic),
 * and `startTick` the writer's boot-relative start tick (liveness). Records
 * from releases before a field was introduced parse with it `undefined`;
 * readers must treat that as "unknown", never as a mismatch.
 */
export type LockOwner =
  | { present: false }
  | {
      present: true;
      pid: number;
      token?: string;
      acquiredAtMs?: number;
      startTick?: number;
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
    metadata.push(line);
  }
  const token = tokenLine?.trim();
  const owner: PresentLockOwner = { present: true, pid, metadata };
  if (token !== undefined && token.length > 0) owner.token = token;
  if (acquiredAtMs !== undefined) owner.acquiredAtMs = acquiredAtMs;
  if (startTick !== undefined) owner.startTick = startTick;
  return owner;
}

/**
 * Reads the owner PID (line 1), acquisition token (line 2), the mechanical
 * `acquired-at-ms=` / `start-tick=` lines (when present), and diagnostic
 * metadata (the remaining lines 3+) from a lock directory's PID file.
 * Returns `{ present: false }` when the PID file is missing, unreadable, or
 * the PID does not parse as a finite integer (caller falls back to the
 * age-only staleness heuristic).
 *
 * File format note: external readers do `parseInt(content.trim(), 10)`,
 * which parses the leading digits of a multi-line file — so the token and
 * mechanical lines stay compatible.
 *
 * @param lockPath - Lock directory whose owner record to read
 * @returns The parsed owner record, or `{ present: false }`
 */
export async function readLockOwner(lockPath: string): Promise<LockOwner> {
  try {
    const owner = parseLockOwnerRecord(await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8'));
    if (owner !== undefined) return owner;
  } catch {
    // PID file missing or unreadable — treat as absent.
  }
  return { present: false };
}

/**
 * Reads the just-written record back, retrying a READ ERROR a few times
 * before giving up. A missing or malformed record is returned as-is (the
 * caller treats it as a failed write); only errno-level failures retry.
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

/**
 * Stamps this process's ownership (PID, per-acquisition token, acquisition
 * time, own start tick, diagnostic metadata) into a lock directory it has
 * just created, and reads the record back to prove it landed.
 *
 * The write is FATAL. It used to be best-effort, on the theory that stale
 * recovery would fall back to the age heuristic — but that heuristic reaps
 * any owner-less lock after five minutes, and the build lock legitimately
 * holds for hours. A holder whose record failed to write was therefore
 * reaped mid-build and a second process entered the critical section. On
 * failure the just-created lock directory is removed (nothing else can own
 * it yet) and a {@link GeneralError} names the cause.
 *
 * @param lockPath - Lock directory this process has just `mkdir`'d
 * @param token - Per-acquisition UUID, later checked by release
 * @param ownerMetadata - Extra human-diagnostic lines (see `FileLockOptions.ownerMetadata`)
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
          !line.startsWith(START_TICK_PREFIX)
      ) ?? [];
  const ownStartTick = readProcessStartTick(process.pid);
  const mechanicalLines = [
    `${ACQUIRED_AT_PREFIX}${Date.now()}`,
    ...(ownStartTick === undefined ? [] : [`${START_TICK_PREFIX}${ownStartTick}`]),
  ];
  const record = `${process.pid}\n${token}\n${[...mechanicalLines, ...metadata].map((line) => `${line}\n`).join('')}`;
  let failure: unknown;
  try {
    await writeFile(join(lockPath, LOCK_PID_FILE), record, 'utf-8');
    const readBack = await readBackLockOwner(lockPath);
    if (readBack !== undefined && readBack.pid === process.pid && readBack.token === token) {
      return;
    }
    failure = new Error('owner record did not read back as written');
  } catch (error: unknown) {
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
 * Linux only: field 22 of `/proc/<pid>/stat`, in USER_HZ since boot.
 * Elsewhere (macOS, Windows) obtaining a start time means spawning
 * `ps`/`wmic` per probe, which is not worth paying on every poll of a
 * contended lock — those platforms return `undefined` and liveness stays
 * PID-only.
 *
 * Deliberately NOT converted to wall-clock time via `/proc/stat` `btime`:
 * on current kernels `btime` is derived from the realtime clock and moves
 * with every clock step, so a wall-clock comparison against a recorded
 * acquisition time misjudges a live holder as a reused PID after NTP steps
 * the clock forward — and reaps a lock that is in use.
 *
 * @param pid - Process to look up
 * @param procRoot - procfs mount, overridable for tests
 * @returns Start tick, or `undefined` when unobtainable
 */
export function readProcessStartTick(pid: number, procRoot = '/proc'): number | undefined {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf-8');
    // `comm` (field 2) is parenthesised and may itself contain spaces or
    // parentheses, so split only what follows the LAST closing paren:
    // field 3 (state) is then index 0 and field 22 (starttime) index 19.
    const startTick = Number.parseInt(
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19] ?? '',
      10
    );
    return Number.isFinite(startTick) ? startTick : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process named by a lock's owner record is the SAME process
 * that acquired the lock, not merely a live process wearing its PID.
 *
 * `isProcessAlive` answers "does this PID exist"; after a holder crashes,
 * the kernel may hand its PID to a long-lived daemon, and a PID-only check
 * then honours the dead lock until the waiter's timeout. Where the record
 * carries the writer's start tick and the candidate's own tick is cheaply
 * obtainable (see {@link readProcessStartTick}), the two must be equal: a
 * different tick is a different process. Records without a start tick, and
 * platforms without one, keep the PID-only answer.
 *
 * @param owner - Owner record fields that identify the holder
 * @param procRoot - procfs mount, overridable for tests
 * @returns True when the original holder is still running (or cannot be proven gone)
 */
export function isLockOwnerAlive(
  owner: { pid: number; startTick?: number | undefined },
  procRoot?: string
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
