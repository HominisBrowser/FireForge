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

  it('removes a young lock whose PID file points at a dead process', async () => {
    // Eval regression: after SIGINT of `furnace preview`, `withFileLock`'s
    // `finally { rm }` is skipped because the signal handler calls
    // `process.exit`. The next command used to wait the full staleness
    // window (5 minutes) before removing the orphan lock — even though the
    // lock's PID file already pointed at a dead process. The PID-first
    // check unblocks immediately when the owner is explicitly gone.
    const { writeFile } = await import('node:fs/promises');
    const tempDir = await makeTempDir('fireforge-dead-pid-lock-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    // Spawn-and-wait for a short-lived child so we capture a PID we know
    // was real but is now gone. Using a literal PID like 99999 is fragile
    // because the kernel may have recycled it; this pattern gives a
    // deterministically-dead PID for the current test run.
    const { spawn } = await import('node:child_process');
    const child = spawn('true');
    const deadPid: number = await new Promise((resolve) => {
      child.once('exit', () => {
        if (child.pid !== undefined) {
          resolve(child.pid);
        } else {
          resolve(-1);
        }
      });
    });
    expect(deadPid).toBeGreaterThan(0);
    await writeFile(join(lockPath, 'pid'), String(deadPid), 'utf-8');
    // Young lock (mtime = now) — age-only heuristic would NOT remove it.
    // PID-first check removes immediately.
    const result = await withFileLock(lockPath, () => Promise.resolve('recovered'), {
      // Generous staleMs so the age gate cannot be the one doing the work.
      staleMs: 60 * 60 * 1000,
      onStaleLockMessage: () => 'stale lock removed',
    });
    expect(result).toBe('recovered');
    expect(vi.mocked(warn)).toHaveBeenCalledWith('stale lock removed');
  });

  it('respects a young lock whose PID file points at a live process', async () => {
    // Defensive complement: the PID-first check must NOT race-remove a
    // lock whose owner is still alive. The current test process's PID
    // is trivially live — simulate a slow operation by pointing the lock
    // at it. Attempting to acquire should time out rather than tear down
    // a legitimate holder.
    const { writeFile } = await import('node:fs/promises');
    const tempDir = await makeTempDir('fireforge-live-pid-lock-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'pid'), String(process.pid), 'utf-8');
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, staleTime, staleTime);

    await expect(
      withFileLock(lockPath, () => Promise.resolve('unreachable'), {
        timeoutMs: 25,
        pollMs: 5,
        staleMs: 1000, // Age is well past staleMs, but PID-first still wins.
        onTimeoutMessage: 'lock still held',
      })
    ).rejects.toThrow('lock still held');
  });

  it('treats EPERM from PID liveness checks as alive or unknown', async () => {
    const { writeFile } = await import('node:fs/promises');
    const tempDir = await makeTempDir('fireforge-eperm-pid-lock-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'pid'), '12345', 'utf-8');
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, staleTime, staleTime);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    try {
      await expect(
        withFileLock(lockPath, () => Promise.resolve('unreachable'), {
          timeoutMs: 25,
          pollMs: 5,
          staleMs: 1000,
          onTimeoutMessage: 'lock still held',
        })
      ).rejects.toThrow('lock still held');
    } finally {
      killSpy.mockRestore();
    }

    expect(await exists(lockPath)).toBe(true);
  });
});
