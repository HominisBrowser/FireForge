// SPDX-License-Identifier: EUPL-1.2
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
});
