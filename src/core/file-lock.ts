// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LockContentionError } from '../errors/base.js';
import { getNodeErrorCode, isProcessAlive, toError } from '../utils/errors.js';
import { ensureDir } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;

/**
 * Minimum interval between stale-lock probes while a waiter polls. The probe
 * used to run exactly once per waiter: if the holder died *after* that single
 * probe, the waiter polled a permanently dead lock until `timeoutMs` — for
 * the build lock that meant up to 24 hours (see `withBuildLock` in mach.ts).
 * Re-probing on a small interval bounds that hang to seconds while keeping
 * the per-poll cost negligible (one stat + one small read every ~5 s).
 */
const STALE_REPROBE_INTERVAL_MS = 5_000;

/**
 * Snapshot of the current lock holder handed to {@link FileLockOptions.onWaitProgress}.
 * `metadata` carries the pid file's human-diagnostic lines (line 3 onward,
 * e.g. `command=build`, `started=…`) written via
 * {@link FileLockOptions.ownerMetadata}.
 */
export interface LockHolder {
  pid: number;
  alive: boolean;
  metadata: string[];
}

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /**
   * When set, the poll interval doubles after every contended poll (starting
   * from `pollMs`) up to this cap. When absent, polling stays at the fixed
   * `pollMs` interval — zero behavior change for existing callers.
   */
  pollMaxMs?: number;
  staleMs?: number;
  /**
   * Interval between stale-lock probes while waiting (defaults to
   * {@link STALE_REPROBE_INTERVAL_MS}). Exists mainly so tests can exercise
   * the mid-wait reaping path without multi-second sleeps.
   */
  staleReprobeMs?: number;
  /**
   * Interval between {@link onWaitProgress} callbacks while the lock is
   * contended. Progress reporting is off unless both this and
   * `onWaitProgress` are set.
   */
  waitProgressMs?: number;
  /**
   * Invoked roughly every `waitProgressMs` while waiting for a contended
   * lock. `holder` is `undefined` when the owner PID file is missing or
   * unreadable.
   */
  onWaitProgress?: (progress: {
    waitedMs: number;
    timeoutMs: number;
    holder: LockHolder | undefined;
  }) => void;
  onTimeoutMessage?: string;
  onStaleLockMessage?: (ageMs: number) => string | undefined;
  /** Extra owner-file lines for human diagnostics; ignored by lock mechanics. */
  ownerMetadata?: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Derives the sibling lock-directory path used to guard a file-based resource. */
export function createSiblingLockPath(filePath: string, suffix = '.fireforge.lock'): string {
  return `${filePath}${suffix}`;
}

/**
 * Filename of a lock directory's owner record, relative to the lock dir.
 *
 * Exported so external readers (`tree-store.ts`) share the constant instead of
 * re-spelling `'pid'`; the file *format* is documented on {@link readLockOwner}.
 */
export const LOCK_PID_FILE = 'pid';

/**
 * Owner record read back from a lock directory's PID file.
 *
 * `token` is the per-acquisition UUID written on line 2 of the PID file.
 * Locks written by FireForge releases before the token was introduced (and
 * locks whose owner-file write failed) have `token: undefined`; readers must
 * treat that as "unknown owner instance", not as a mismatch.
 */
type LockOwner =
  { present: false } | { present: true; pid: number; token?: string; metadata: string[] };

/**
 * Reads the owner PID (line 1), acquisition token (line 2), and diagnostic
 * metadata (lines 3+, see {@link FileLockOptions.ownerMetadata}) from a lock
 * directory's PID file. Returns `{ present: false }` when the PID file is
 * missing or the PID does not parse as a finite integer (caller falls back
 * to the age-only staleness heuristic).
 *
 * File format note: external readers (`doctor-furnace.ts`, older FireForge
 * releases) do `parseInt(content.trim(), 10)`, which parses the leading
 * digits of a multi-line file — so adding the token line stays compatible.
 */
async function readLockOwner(lockPath: string): Promise<LockOwner> {
  try {
    const pidContent = await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8');
    const [pidLine, tokenLine, ...metadataLines] = pidContent.split('\n');
    const pid = parseInt((pidLine ?? '').trim(), 10);
    if (Number.isFinite(pid)) {
      const metadata = metadataLines.map((line) => line.trim()).filter((line) => line.length > 0);
      const token = tokenLine?.trim();
      if (token !== undefined && token.length > 0) {
        return { present: true, pid, token, metadata };
      }
      return { present: true, pid, metadata };
    }
  } catch {
    // PID file missing or unreadable — treat as absent.
  }
  return { present: false };
}

/**
 * Reads the contended lock's owner and reports wait progress to the caller's
 * `onWaitProgress` callback. Failure to read the owner degrades to
 * `holder: undefined` — progress reporting must never break the wait loop.
 */
async function reportWaitProgress(
  lockPath: string,
  waitedMs: number,
  timeoutMs: number,
  onWaitProgress: NonNullable<FileLockOptions['onWaitProgress']>
): Promise<void> {
  const owner = await readLockOwner(lockPath);
  const holder: LockHolder | undefined = owner.present
    ? { pid: owner.pid, alive: isProcessAlive(owner.pid), metadata: owner.metadata }
    : undefined;
  onWaitProgress({ waitedMs, timeoutMs, holder });
}

/**
 * Reaps a lock directory believed to be stale, safely against concurrent
 * reapers and a concurrent legitimate re-acquisition.
 *
 * The naive stat → read-PID → `rm` sequence had a TOCTOU hole: two waiters
 * could both observe the dead owner, one would remove the stale dir and
 * `mkdir` its own lock, and the other's already-decided `rm` then deleted
 * the *fresh* lock — two processes inside the critical section at once.
 *
 * Rename-aside closes it: `rename()` is atomic, so exactly one reaper wins
 * ownership of the directory (the loser gets ENOENT and simply re-polls),
 * and nothing ever deletes the live path directly. After winning the rename
 * we re-read the owner from the renamed dir — if it is now a *live* process
 * (the lock was released and re-acquired between our staleness read and the
 * rename), we rename it back instead of reaping.
 *
 * @returns true when the caller should immediately retry `mkdir` (the lock
 *   path is now free or was freed by someone else), false when the lock is
 *   legitimately held and the caller should keep waiting.
 */
async function reapStaleLock(
  lockPath: string,
  ageMs: number,
  onStaleLockMessage?: (ageMs: number) => string | undefined
): Promise<boolean> {
  const reapPath = `${lockPath}.reaping-${String(process.pid)}-${randomUUID()}`;
  try {
    await rename(lockPath, reapPath);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') {
      // Another reaper won, or the owner released — either way, retry mkdir.
      verbose(`Stale lock disappeared before reaping completed: ${lockPath}`);
      return true;
    }
    verbose(`Could not rename stale lock aside (${lockPath}): ${toError(error).message}`);
    return false;
  }

  // We exclusively own reapPath now. Re-verify: the owner may have changed
  // between the staleness probe and the rename (release + fresh acquire).
  const owner = await readLockOwner(reapPath);
  if (owner.present && isProcessAlive(owner.pid)) {
    try {
      await rename(reapPath, lockPath);
      verbose(
        `Aborted stale-lock reap of ${lockPath}: owner PID ${String(owner.pid)} is alive (lock was re-acquired mid-probe)`
      );
    } catch (restoreError: unknown) {
      // Rename-back can only fail if a third process mkdir'd the lock path
      // in this instant. The displaced live owner keeps running without its
      // lock — surface it loudly instead of hiding the lost exclusion.
      warn(
        `Could not restore live lock for PID ${String(owner.pid)} at ${lockPath} ` +
          `(${toError(restoreError).message}). Displaced lock kept at ${reapPath} for inspection.`
      );
    }
    return false;
  }

  const staleMessage = onStaleLockMessage?.(ageMs);
  if (staleMessage) {
    warn(staleMessage);
  } else {
    verbose(`Removing stale lock ${lockPath} (age: ${Math.round(ageMs / 1000)}s)`);
  }
  await rm(reapPath, { recursive: true, force: true });
  return true;
}

/**
 * Probes a contended lock for staleness and reaps it when the owner is gone.
 *
 * @returns true when the caller should immediately retry `mkdir`.
 */
async function removeIfStaleLock(
  lockPath: string,
  staleMs: number,
  onStaleLockMessage?: (ageMs: number) => string | undefined
): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;

    // Check PID FIRST, independent of age. Before this ordering change the
    // function age-gated everything: a lock younger than `staleMs` (default
    // 5 minutes) was never removed even when its PID file pointed at a
    // process that had already exited. That's the exact situation an
    // operator lands in after SIGINT'ing `furnace preview` — the signal
    // handler calls `process.exit`, `withFileLock`'s release never runs,
    // and the next command has to either wait 5 minutes for the staleness
    // gate or manually remove the lock directory. With the PID-first check,
    // an explicitly-dead owner unblocks immediately.
    const owner = await readLockOwner(lockPath);
    if (owner.present) {
      if (!isProcessAlive(owner.pid)) {
        return await reapStaleLock(lockPath, ageMs, onStaleLockMessage);
      }
      // PID is alive — respect it regardless of age. A slow `mach build`
      // legitimately holds the lock past the stale threshold and we don't
      // want to race-remove it.
      verbose(
        `Lock at ${lockPath} is ${Math.round(ageMs / 1000)}s old but PID ${String(owner.pid)} is still running — not removing`
      );
      return false;
    }

    // No readable PID file. Fall back to the age-only heuristic so locks
    // written by earlier FireForge releases (which may not have written a
    // PID file) still clear after the staleness window elapses.
    if (ageMs <= staleMs) {
      return false;
    }

    return await reapStaleLock(lockPath, ageMs, onStaleLockMessage);
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT') {
      verbose(`Stale lock disappeared before cleanup completed: ${lockPath}`);
      return true;
    }

    verbose(`Stale lock check failed for ${lockPath}: ${toError(error).message}`);
    throw toError(error);
  }
}

/**
 * Releases a lock previously acquired by this process, verifying ownership
 * first. The unconditional `finally { rm }` this replaces would remove
 * *whichever* lock directory was present — if a stale-lock reaper had (in a
 * pathological race) replaced our lock, we deleted the new owner's lock and
 * compounded the double-acquisition. When the PID file no longer names us,
 * warn and leave the directory alone.
 *
 * `ownerFileWritten` is false when our own owner-file write failed at
 * acquisition (non-fatal there); ownership then cannot be verified and we
 * fall back to unconditional removal — identical to the historical behavior
 * and strictly better than leaking the lock.
 */
async function releaseLock(
  lockPath: string,
  ownerToken: string,
  ownerFileWritten: boolean
): Promise<void> {
  if (ownerFileWritten) {
    const owner = await readLockOwner(lockPath);
    if (
      owner.present &&
      (owner.pid !== process.pid || (owner.token !== undefined && owner.token !== ownerToken))
    ) {
      warn(
        `Not removing lock ${lockPath}: it is now owned by PID ${String(owner.pid)} — ` +
          'this process no longer holds it.'
      );
      return;
    }
  }
  await rm(lockPath, { recursive: true, force: true });
}

/** Runs an async operation while holding a directory lock, with stale-lock recovery. */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const staleReprobeMs = options.staleReprobeMs ?? STALE_REPROBE_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastStaleProbeAt: number | undefined;
  let currentPollMs = pollMs;
  let lastProgressAt = startedAt;

  await ensureDir(dirname(lockPath));

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error: unknown) {
      if (getNodeErrorCode(error) !== 'EEXIST') {
        throw error;
      }

      if (lastStaleProbeAt === undefined || Date.now() - lastStaleProbeAt >= staleReprobeMs) {
        lastStaleProbeAt = Date.now();
        if (await removeIfStaleLock(lockPath, staleMs, options.onStaleLockMessage)) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        const owner = await readLockOwner(lockPath);
        const holderHint =
          owner.present && isProcessAlive(owner.pid)
            ? ` It is held by running process ${String(owner.pid)}${owner.metadata.length > 0 ? ` (${owner.metadata.join(', ')})` : ''} — wait for it to finish, or stop it and retry.`
            : ' If no other FireForge process is running, remove the lock directory and retry.';
        // Typed as LockContentionError (a FireForgeError) so the CLI
        // boundary prints the refusal as one clean line instead of an
        // "Unexpected error" stack (FORGE H5). Callers supplying
        // onTimeoutMessage still get the holder identification appended —
        // the reason-first copy stays theirs, the "who holds it" is ours.
        const identifiedHolder =
          options.onTimeoutMessage !== undefined && owner.present && isProcessAlive(owner.pid)
            ? ` The lock is held by PID ${String(owner.pid)}${owner.metadata.length > 0 ? ` (${owner.metadata.join(', ')})` : ''}.`
            : '';
        throw new LockContentionError(
          options.onTimeoutMessage !== undefined
            ? `${options.onTimeoutMessage}${identifiedHolder}`
            : `Timed out waiting for file lock ${lockPath}.${holderHint}`,
          error
        );
      }

      if (
        options.onWaitProgress !== undefined &&
        options.waitProgressMs !== undefined &&
        Date.now() - lastProgressAt >= options.waitProgressMs
      ) {
        lastProgressAt = Date.now();
        await reportWaitProgress(
          lockPath,
          Date.now() - startedAt,
          timeoutMs,
          options.onWaitProgress
        );
      }

      await sleep(currentPollMs);
      if (options.pollMaxMs !== undefined) {
        currentPollMs = Math.min(currentPollMs * 2, options.pollMaxMs);
      }
    }
  }

  // Stamp ownership (PID + per-acquisition token) into the lock directory so
  // stale-lock recovery can check liveness and release can verify the lock
  // is still ours before removing it.
  const ownerToken = randomUUID();
  let ownerFileWritten = false;
  try {
    const metadata =
      options.ownerMetadata
        ?.map((line) => line.replace(/\r?\n/g, ' ').trim())
        .filter((line) => line.length > 0) ?? [];
    await writeFile(
      join(lockPath, LOCK_PID_FILE),
      `${String(process.pid)}\n${ownerToken}\n${metadata.length > 0 ? `${metadata.join('\n')}\n` : ''}`,
      'utf-8'
    );
    ownerFileWritten = true;
  } catch {
    // Non-fatal: stale recovery falls back to age-only heuristic and release
    // falls back to unconditional removal.
  }

  try {
    return await operation();
  } finally {
    await releaseLock(lockPath, ownerToken, ownerFileWritten);
  }
}
