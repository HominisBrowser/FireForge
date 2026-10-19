// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared holds on a directory lock: shared holders overlap, an exclusive
 * holder waits for them to drain (and blocks new shared holders while it
 * waits), and a dead shared holder is reaped.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { LockContentionError } from '../../errors/base.js';
import { forceReleaseHeldLocksForSignal, readLockStatus, withFileLock } from '../file-lock.js';
import {
  countLiveSharedHolders,
  registerSharedHold,
  sharedHoldersDir,
} from '../file-lock-shared.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function lockIn(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return join(dir, 'engine-session.lock');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function deadPid(): Promise<number> {
  const child = spawn('true');
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve(child.pid ?? -1);
    });
  });
}

describe('shared lock holds', () => {
  it('lets shared holders overlap and leaves the turnstile free while they run', async () => {
    const lockPath = await lockIn('ff-shared-overlap-');
    const gate = deferred();
    let inside = 0;
    let maxInside = 0;
    const run = (): Promise<void> =>
      withFileLock(
        lockPath,
        async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await gate.promise;
          inside -= 1;
        },
        { mode: 'shared', timeoutMs: 5000, ownerMetadata: ['command=test'] }
      );
    const first = run();
    const second = run();
    await vi.waitFor(() => {
      expect(maxInside).toBe(2);
    });
    expect(await exists(lockPath)).toBe(false);
    expect(await countLiveSharedHolders(lockPath)).toBe(2);
    await expect(readLockStatus(lockPath)).resolves.toMatchObject({
      held: false,
      sharedHolders: 2,
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(await readdir(sharedHoldersDir(lockPath))).toEqual([]);
  });

  it('makes an exclusive holder wait until shared holders finish', async () => {
    const lockPath = await lockIn('ff-shared-drain-');
    const gate = deferred();
    const order: string[] = [];
    const shared = withFileLock(
      lockPath,
      async () => {
        order.push('shared-start');
        await gate.promise;
        order.push('shared-end');
      },
      { mode: 'shared', timeoutMs: 5000 }
    );
    await vi.waitFor(async () => {
      expect(await countLiveSharedHolders(lockPath)).toBe(1);
    });
    const exclusive = withFileLock(
      lockPath,
      () => {
        order.push('exclusive');
        return Promise.resolve();
      },
      { timeoutMs: 5000 }
    );
    // The writer holds the turnstile while it drains, so status shows it.
    await vi.waitFor(async () => {
      expect(await exists(lockPath)).toBe(true);
    });
    gate.resolve();
    await Promise.all([shared, exclusive]);
    expect(order).toEqual(['shared-start', 'shared-end', 'exclusive']);
    expect(await exists(lockPath)).toBe(false);
  });

  it('refuses an exclusive holder whose budget runs out while shared holders stay', async () => {
    const lockPath = await lockIn('ff-shared-timeout-');
    const gate = deferred();
    const shared = withFileLock(lockPath, () => gate.promise, { mode: 'shared' });
    await vi.waitFor(async () => {
      expect(await countLiveSharedHolders(lockPath)).toBe(1);
    });
    await expect(
      withFileLock(lockPath, () => Promise.resolve('never'), { timeoutMs: 50, pollMs: 10 })
    ).rejects.toThrow(LockContentionError);
    // The refused writer released the turnstile on its way out.
    expect(await exists(lockPath)).toBe(false);
    gate.resolve();
    await shared;
  });

  it('reaps a shared holder whose process is gone, but not one still being written', async () => {
    const lockPath = await lockIn('ff-shared-dead-');
    const dir = sharedHoldersDir(lockPath);
    await mkdir(join(dir, 'dead'), { recursive: true });
    await writeFile(join(dir, 'dead', 'pid'), String(await deadPid()), 'utf-8');
    await mkdir(join(dir, 'pending'), { recursive: true });
    expect(await countLiveSharedHolders(lockPath, { reap: false })).toBe(0);
    expect(await readdir(dir)).toHaveLength(2);
    await expect(withFileLock(lockPath, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(await readdir(dir)).toEqual(['pending']);
  });

  it('releases shared holds on the signal path', async () => {
    const lockPath = await lockIn('ff-shared-signal-');
    await registerSharedHold(lockPath, undefined);
    expect(await countLiveSharedHolders(lockPath)).toBe(1);
    const removed = await forceReleaseHeldLocksForSignal();
    expect(removed).toHaveLength(1);
    expect(await countLiveSharedHolders(lockPath)).toBe(0);
    expect(await forceReleaseHeldLocksForSignal()).toEqual([]);
  });
});
