// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared holds on a FireForge directory lock.
 *
 * Two build-less `fireforge test` runs on one objdir, each with its own
 * profile and (under auto ports) its own ports, have no reason to wait for
 * each other; with only exclusive holds the gate's browser tiers would run
 * strictly serially on a many-core host. A shared hold lets such runs overlap while
 * anything that writes (a build, a re-export, a test run that builds)
 * still holds the lock alone.
 *
 * The scheme reuses the exclusive lock as a turnstile, so arrival order and
 * stale-holder reaping come from the machinery that already exists:
 *
 *  - A shared holder takes the exclusive lock in the ordinary way, records
 *    itself under `<lock>.shared/<uuid>/` (an owner record like the lock's
 *    own), and releases the exclusive lock at once.
 *  - An exclusive holder takes the exclusive lock, then waits until no live
 *    shared holder is left. While it waits it already holds the turnstile,
 *    so no new shared holder can slip in ahead of it: a writer queued
 *    behind readers is served once they finish, never starved by newcomers.
 *
 * A shared holder whose process died is reaped by the same PID-first
 * liveness check the exclusive lock uses.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode, toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { isLockOwnerAlive, readLockOwner, writeLockOwner } from './file-lock-owner.js';

/** How a caller holds a lock. */
export type LockMode = 'exclusive' | 'shared';

/** The directory holding a lock's shared-holder records. */
export function sharedHoldersDir(lockPath: string): string {
  return `${lockPath}.shared`;
}

/** Holder directories this process registered, for the signal sweep. */
const heldShares = new Set<string>();

/**
 * Counts the live shared holders of a lock, reaping any whose process is
 * gone. A missing directory means none.
 *
 * @param lockPath - The lock directory
 * @param options - `reap: false` only counts (status reads)
 */
export async function countLiveSharedHolders(
  lockPath: string,
  options: { reap?: boolean } = {}
): Promise<number> {
  const dir = sharedHoldersDir(lockPath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return 0;
    if (options.reap === false) return 0;
    throw toError(error);
  }
  let live = 0;
  for (const entry of entries) {
    const holder = join(dir, entry);
    const owner = await readLockOwner(holder);
    if (owner.present && isLockOwnerAlive(owner)) {
      live += 1;
      continue;
    }
    // A record still being written has no owner yet; only an owner that
    // names a dead process is reaped, so a racing registration survives.
    if (owner.present && options.reap !== false) {
      verbose(`Reaping shared hold ${holder}: PID ${owner.pid} is gone.`);
      await rm(holder, { recursive: true, force: true });
    }
  }
  return live;
}

/** A registered shared hold. */
export interface SharedHold {
  /** Removes the hold. Never throws. */
  release(): Promise<void>;
}

/**
 * Records a shared hold. Call while holding the lock's exclusive turnstile.
 *
 * @param lockPath - The lock directory
 * @param metadata - Owner metadata lines (`command=…`)
 */
export async function registerSharedHold(
  lockPath: string,
  metadata: readonly string[] | undefined
): Promise<SharedHold> {
  const holder = join(sharedHoldersDir(lockPath), randomUUID());
  await mkdir(holder, { recursive: true });
  await writeLockOwner(holder, randomUUID(), [...(metadata ?? []), 'mode=shared']);
  heldShares.add(holder);
  return {
    async release() {
      heldShares.delete(holder);
      try {
        await rm(holder, { recursive: true, force: true });
      } catch (error: unknown) {
        verbose(`Could not remove shared hold ${holder}: ${toError(error).message}`);
      }
    },
  };
}

/**
 * Removes every shared hold this process registered, for the signal path.
 * Never throws.
 *
 * @returns The holder paths removed
 */
export async function releaseSharedHoldsForSignal(): Promise<string[]> {
  const removed: string[] = [];
  for (const holder of [...heldShares]) {
    heldShares.delete(holder);
    try {
      await rm(holder, { recursive: true, force: true });
      removed.push(holder);
    } catch {
      // Shutdown path: nothing to do.
    }
  }
  return removed;
}
