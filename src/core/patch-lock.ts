// SPDX-License-Identifier: EUPL-1.2
/**
 * Filesystem-based lock for serializing patch directory mutations.
 */

import { join } from 'node:path';

import { FireForgeError } from '../errors/base.js';
import { PatchError } from '../errors/patch.js';
import { assert } from '../utils/assert.js';
import { toError } from '../utils/errors.js';
import { info } from '../utils/logger.js';
import type { LockHolder } from './file-lock.js';
import { readLockStatus, withFileLock } from './file-lock.js';

const PATCH_DIRECTORY_LOCK = '.fireforge-patches.lock';

export interface PatchDirectoryLockOptions {
  /**
   * Wait up to this many seconds for the patch directory lock instead of the
   * default ~30 s budget. Enables exponential poll backoff (100 ms → 2 s)
   * and a holder-identified progress line roughly every 5 s. `undefined`
   * preserves the historical behavior exactly.
   */
  waitLockSeconds?: number | undefined;
  /** Command name recorded in the lock's owner metadata for holder diagnostics. */
  command?: string | undefined;
}

/**
 * Formats the periodic operator-facing waiting line printed while
 * `--wait-lock` polls a contended patch directory lock. Mirrors the engine
 * session lock's progress line so operators read one shape for both locks.
 */
function formatWaitProgressLine(
  waitedMs: number,
  timeoutMs: number,
  holder: LockHolder | undefined
): string {
  const progress = `${String(Math.round(waitedMs / 1000))}s of up to ${String(Math.round(timeoutMs / 1000))}s`;
  if (holder === undefined) {
    return `Waiting for the FireForge patch directory lock — ${progress}.`;
  }
  const details = holder.metadata.length > 0 ? ` (${holder.metadata.join(', ')})` : '';
  return `Waiting for the FireForge patch directory lock held by PID ${String(holder.pid)}${details} — ${progress}.`;
}

/**
 * Asserts that this process is inside {@link withPatchDirectoryLock} for the
 * given patches directory.
 *
 * The manifest mutators document "under the caller's lock" and are reached
 * from six different command bodies, none of which the mutator can see. This
 * turns that comment into a check at the point it matters: filename
 * allocation and manifest read-modify-writes are only atomic while the lock
 * is held, so an unlocked caller silently reintroduces the interleaving the
 * lock exists to prevent.
 *
 * Fail-open on an unreadable owner record, deliberately: `withFileLock`
 * treats writing that record as non-fatal, so a live holder can legitimately
 * have no readable PID and asserting on its presence would fire on a lock we
 * really do hold.
 *
 * @param patchesDir - The patches directory whose lock must be held
 * @param context - What is about to be done, for the failure message
 * @throws {@link InternalInvariantError} when the lock is not held by us.
 */
export async function assertPatchDirectoryLockHeld(
  patchesDir: string,
  context: string
): Promise<void> {
  const status = await readLockStatus(join(patchesDir, PATCH_DIRECTORY_LOCK));
  assert(status.held, () => `patch directory lock is held before ${context}`);
  assert(
    status.holder === undefined || status.holder.pid === process.pid,
    () =>
      `patch directory lock is owned by this process before ${context} ` +
      `(held by PID ${String(status.holder?.pid)}, we are ${String(process.pid)})`
  );
}

/**
 * Runs a patch directory mutation while holding an exclusive filesystem lock.
 * This serializes filename allocation and manifest writes across parallel exports.
 */
export async function withPatchDirectoryLock<T>(
  patchesDir: string,
  operation: () => Promise<T>,
  options: PatchDirectoryLockOptions = {}
): Promise<T> {
  const lockDir = join(patchesDir, PATCH_DIRECTORY_LOCK);
  const { waitLockSeconds, command } = options;
  return withFileLock(lockDir, operation, {
    ...(waitLockSeconds !== undefined
      ? {
          timeoutMs: waitLockSeconds * 1000,
          pollMs: 100,
          pollMaxMs: 2000,
          waitProgressMs: 5000,
          onWaitProgress: ({ waitedMs, timeoutMs, holder }): void => {
            info(formatWaitProgressLine(waitedMs, timeoutMs, holder));
          },
        }
      : {}),
    ...(command !== undefined
      ? { ownerMetadata: [`command=${command}`, `started=${new Date().toISOString()}`] }
      : {}),
    // Reason first, remedy second. The remedy is waiting, not
    // deleting: bulk exports/re-exports legitimately hold this lock for
    // minutes, FireForge reaps genuinely stale locks on its own, and the
    // old advice ("rm -rf" while a holder was alive) destroyed a live
    // lock. The leading sentence is a message contract; extend, don't
    // reword. withFileLock appends the holder identification.
    onTimeoutMessage:
      `Timed out waiting for another FireForge command mutating ${patchesDir}.\n` +
      `Pass --wait-lock [seconds] to wait longer (bare --wait-lock waits up to 60 seconds). ` +
      `FireForge removes genuinely stale locks automatically; only if no other fireforge ` +
      `process is running and the timeout persists, remove the lock manually:\n  rm -rf "${lockDir}"`,
    onStaleLockMessage: (ageMs) =>
      `Removing stale patch lock (age: ${Math.round(ageMs / 1000)}s). ` +
      'A previous fireforge process may have crashed.',
  }).catch((error: unknown) => {
    if (error instanceof FireForgeError) {
      throw error;
    }

    throw new PatchError(toError(error).message);
  });
}
