// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-fs integration test for `withBuildLock`.
 *
 * A `fireforge build --ui` launched while a full `fireforge build` is still
 * running against the same engine tree races the obj-dir and fails with a
 * cryptic `No rule to make target 'XUL'`. The lock intercepts the second
 * invocation before it reaches mach and refuses with a message naming the
 * holder PID.
 *
 * These tests pin the lock behaviour without touching the actual mach
 * process. The operation passed into `withBuildLock` is a trivial async
 * block that lets us observe lock acquisition order and timeouts.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withBuildLock } from '../mach.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-build-lock-'));
  cleanup.push(root);
  return root;
}

describe('withBuildLock', () => {
  it('serialises concurrent builds against the same project root', async () => {
    const root = await createProject();
    const order: string[] = [];

    // Start the first invocation and wait until its operation has
    // actually entered the critical section before we queue the
    // second. `Promise.all` on two fresh lock attempts does not
    // guarantee which one wins the race to `mkdir`, so without the
    // gate the order assertion below can flip under CPU contention.
    let firstEnteredResolve: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });

    const firstRun = withBuildLock(root, async () => {
      order.push('first-start');
      firstEnteredResolve?.();
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push('first-end');
    });

    await firstEntered;

    // Now the second invocation blocks until the first operation's
    // promise resolves and the sidecar directory is removed.
    const secondRun = withBuildLock(root, () => {
      order.push('second-start');
      order.push('second-end');
      return Promise.resolve();
    });

    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('releases the lock when the inner operation throws', async () => {
    const root = await createProject();
    await expect(
      withBuildLock(root, () => Promise.reject(new Error('build blew up')))
    ).rejects.toThrow('build blew up');

    // A follow-up build must not hang: the lock directory should be
    // gone from the `finally` branch inside `withFileLock`.
    const result = await withBuildLock(root, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('recovers a stale lock directory whose PID is no longer alive', async () => {
    // Simulate an interrupted earlier build by pre-creating the lock
    // directory with a PID that is guaranteed not to be a FireForge
    // process. The lock helper's PID-alive probe clears the stale
    // directory on the next attempt.
    const root = await createProject();
    const lockPath = join(root, '.fireforge-build.lock');
    await mkdir(lockPath);
    // Use the max-int PID sentinel that every platform rejects as
    // out-of-range. `process.kill(pid, 0)` raises ESRCH and stale
    // recovery removes the lock.
    await writeFile(join(lockPath, 'pid'), '2147483647', 'utf-8');

    const result = await withBuildLock(root, () => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
  });
});
