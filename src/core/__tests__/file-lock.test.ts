// SPDX-License-Identifier: EUPL-1.2
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(actual.rm),
  };
});

import { access, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
  warn: vi.fn(),
}));

import { warn } from '../../utils/logger.js';
import { createSiblingLockPath, withFileLock } from '../file-lock.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    void error;
    return false;
  }
}

describe('file-lock', () => {
  it('derives a sibling lock path', () => {
    expect(createSiblingLockPath('/tmp/fireforge/state.json')).toBe(
      '/tmp/fireforge/state.json.fireforge.lock'
    );
    expect(createSiblingLockPath('/tmp/fireforge/state.json', '.custom.lock')).toBe(
      '/tmp/fireforge/state.json.custom.lock'
    );
  });

  it('acquires and releases the lock directory around the operation', async () => {
    const tempDir = await makeTempDir('fireforge-lock-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    let sawLock = false;

    const result = await withFileLock(lockPath, async () => {
      sawLock = await exists(lockPath);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(sawLock).toBe(true);
    expect(await exists(lockPath)).toBe(false);
  });

  it('removes stale locks before retrying and emits the stale-lock warning', async () => {
    const tempDir = await makeTempDir('fireforge-stale-lock-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 1_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await withFileLock(lockPath, () => Promise.resolve('recovered'), {
      staleMs: 10,
      onStaleLockMessage: () => 'stale lock removed',
    });

    expect(result).toBe('recovered');
    expect(vi.mocked(warn)).toHaveBeenCalledWith('stale lock removed');
  });

  it('times out when a fresh lock never clears', async () => {
    const tempDir = await makeTempDir('fireforge-timeout-lock-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);

    await expect(
      withFileLock(lockPath, () => Promise.resolve('unreachable'), {
        timeoutMs: 25,
        pollMs: 5,
        staleMs: 60_000,
        onTimeoutMessage: 'lock still held',
      })
    ).rejects.toThrow('lock still held');
  });

  it('serialises concurrent lock attempts on the same path', async () => {
    const tempDir = await makeTempDir('fireforge-contention-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    const order: string[] = [];

    const first = withFileLock(
      lockPath,
      async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push('first-end');
        return 'a';
      },
      { timeoutMs: 500, pollMs: 10 }
    );

    // Small delay so the first call wins the mkdir race.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = withFileLock(
      lockPath,
      () => {
        order.push('second-start');
        return Promise.resolve('b');
      },
      { timeoutMs: 500, pollMs: 10, staleMs: 60_000 }
    );

    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA).toBe('a');
    expect(resultB).toBe('b');
    // The second operation must not start until the first has finished.
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('surfaces stale-lock cleanup failures that are not disappearance races', async () => {
    const tempDir = await makeTempDir('fireforge-stale-lock-error-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 1_000);
    await utimes(lockPath, staleTime, staleTime);

    vi.mocked(rm).mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );

    await expect(
      withFileLock(lockPath, () => Promise.resolve('unreachable'), {
        staleMs: 10,
      })
    ).rejects.toThrow('permission denied');
  });
});
