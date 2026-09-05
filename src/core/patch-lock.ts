// SPDX-License-Identifier: EUPL-1.2
/**
 * Filesystem-based lock for serializing patch directory mutations.
 */

import { join } from 'node:path';

import { CommandError, FireForgeError } from '../errors/base.js';
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
   * keeps the default.
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
  const progress = `${Math.round(waitedMs / 1000)}s of up to ${Math.round(timeoutMs / 1000)}s`;
  if (holder === undefined) {
    return `Waiting for the FireForge patch directory lock — ${progress}.`;
  }
  const details = holder.metadata.length > 0 ? ` (${holder.metadata.join(', ')})` : '';
  return `Waiting for the FireForge patch directory lock held by PID ${holder.pid}${details} — ${progress}.`;
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
 * Fail-open on an unreadable owner record, on purpose: `withFileLock`
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
      `(held by PID ${status.holder?.pid}, we are ${process.pid})`
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

  // Tag whatever the body throws so the catch below can tell it apart from a
  // lock-acquire/release failure. Narrowing by origin rather than by error
  // shape is what "the rewrap is for lock I/O" actually means: an errno test
  // would still reclassify an EACCES raised while the body writes a .patch
  // file, and a class test cannot see a bare `new Error` from a body at all.
  let bodyFailure: unknown;
  let bodyThrew = false;
  const trackedOperation = async (): Promise<T> => {
    try {
      return await operation();
    } catch (error: unknown) {
      bodyThrew = true;
      bodyFailure = error;
      throw error;
    }
  };

  return withFileLock(lockDir, trackedOperation, {
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
    // Reason first, remedy second. The remedy is waiting, not deleting: bulk
    // exports/re-exports legitimately hold this lock for minutes, and
    // FireForge reaps genuinely stale locks on its own, and advice to
    // `rm -rf` while a holder is alive destroys a live lock. The leading
    // sentence is a message contract. Extend, do not reword. withFileLock
    // appends the holder identification.
    onTimeoutMessage:
      `Timed out waiting for another FireForge command mutating ${patchesDir}.\n` +
      `Pass --wait-lock [seconds] to wait longer (bare --wait-lock waits up to 60 seconds). ` +
      `FireForge removes genuinely stale locks automatically; only if no other fireforge ` +
      `process is running and the timeout persists, remove the lock manually:\n  rm -rf "${lockDir}"`,
    onStaleLockMessage: (ageMs) =>
      `Removing stale patch lock (age: ${Math.round(ageMs / 1000)}s). ` +
      'A previous fireforge process may have crashed.',
  }).catch((error: unknown) => {
    // The body's own failures are never ours to reclassify. Rewrapping them
    // reports an EACCES writing patches.json, a postcondition failure from
    // renumberPatchesInManifest, or a plain TypeError from a FireForge bug
    // as a "Patch Error" carrying three fixed remedies about Firefox-version
    // compatibility and `fireforge reset`, none of which apply. Worse,
    // src/cli.ts prints a stack only for non-FireForgeError throwables, so
    // the rewrap moves real bugs into the branch that discards their stack.
    if (bodyThrew && error === bodyFailure) {
      throw error;
    }

    if (error instanceof FireForgeError) {
      throw error;
    }

    // CommandError is the one class in src/errors/ that does not extend
    // FireForgeError: it is the sentinel carrying an already-rendered exit
    // code to the entrypoint. The `instanceof FireForgeError` guard above
    // misses it, so without this the exit code was replaced by PATCH_ERROR.
    if (error instanceof CommandError) {
      throw error;
    }

    // What remains is a genuine failure to acquire or release the lock.
    const cause = toError(error);
    throw new PatchError(cause.message, undefined, cause);
  });
}
