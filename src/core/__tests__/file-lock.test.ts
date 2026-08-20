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

import { FireForgeError, LockContentionError } from '../../errors/base.js';
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

  it('rejects a timeout with LockContentionError so the CLI renders one line, not a stack', async () => {
    const tempDir = await makeTempDir('fireforge-typed-timeout-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);

    const rejection = await withFileLock(lockPath, () => Promise.resolve('unreachable'), {
      timeoutMs: 25,
      pollMs: 5,
      staleMs: 60_000,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(LockContentionError);
    expect(rejection).toBeInstanceOf(FireForgeError);
    expect((rejection as Error).message).toContain('Timed out waiting for file lock');
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

  it('reaps a lock whose owner dies while waiters are already polling', async () => {
    // The stale probe used to run exactly once per waiter: a holder that
    // died AFTER that single probe left the waiter polling a permanently
    // dead lock until timeoutMs (24 h for the build lock). The periodic
    // re-probe bounds that to staleReprobeMs.
    const { writeFile } = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    const tempDir = await makeTempDir('fireforge-midwait-death-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);

    // A genuinely live child owns the lock, so the waiter's first probe
    // respects it; we kill the child mid-wait.
    const holder = spawn('sleep', ['30']);
    expect(holder.pid).toBeDefined();
    await writeFile(join(lockPath, 'pid'), String(holder.pid), 'utf-8');

    const waiter = withFileLock(lockPath, () => Promise.resolve('acquired-after-death'), {
      timeoutMs: 5_000,
      pollMs: 5,
      staleMs: 60 * 60 * 1000,
      staleReprobeMs: 20,
    });

    // Let the waiter run its first (respecting) probe, then kill the holder.
    await new Promise((resolve) => setTimeout(resolve, 40));
    holder.kill('SIGKILL');
    await new Promise((resolve) => {
      holder.once('exit', resolve);
    });

    await expect(waiter).resolves.toBe('acquired-after-death');
    expect(await exists(lockPath)).toBe(false);
  });

  it('two waiters recovering the same stale lock still exclude each other', async () => {
    // TOCTOU regression: with rm-by-path recovery, two waiters could both
    // observe the dead owner, one re-acquires, and the other's rm deleted
    // the fresh lock — two processes in the critical section at once. The
    // rename-aside reap lets exactly one reaper win; the loser re-polls.
    const { writeFile } = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    const tempDir = await makeTempDir('fireforge-reap-race-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    const child = spawn('true');
    const deadPid: number = await new Promise((resolve) => {
      child.once('exit', () => {
        resolve(child.pid ?? -1);
      });
    });
    await writeFile(join(lockPath, 'pid'), String(deadPid), 'utf-8');

    let inside = 0;
    let maxInside = 0;
    const critical = async (): Promise<string> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inside -= 1;
      return 'done';
    };

    const opts = { timeoutMs: 5_000, pollMs: 5, staleMs: 60 * 60 * 1000, staleReprobeMs: 5 };
    const results = await Promise.all([
      withFileLock(lockPath, critical, opts),
      withFileLock(lockPath, critical, opts),
    ]);

    expect(results).toEqual(['done', 'done']);
    expect(maxInside).toBe(1);
    expect(await exists(lockPath)).toBe(false);
  });

  it('does not remove a lock that no longer belongs to this process on release', async () => {
    // If (pathologically) our lock is replaced by another owner while our
    // operation runs, the release path must not delete the new owner's
    // lock — the historical unconditional `finally { rm }` did exactly
    // that, compounding a double-acquisition.
    const { writeFile } = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    const tempDir = await makeTempDir('fireforge-foreign-release-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');

    // A live foreign process (a sleeping child) will "own" the imposter lock.
    const foreign = spawn('sleep', ['30']);
    expect(foreign.pid).toBeDefined();
    try {
      await withFileLock(lockPath, async () => {
        // Simulate a reaper replacing our lock mid-operation.
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath);
        await writeFile(join(lockPath, 'pid'), `${String(foreign.pid)}\nimposter-token\n`, 'utf-8');
      });
    } finally {
      foreign.kill('SIGKILL');
    }

    expect(await exists(lockPath)).toBe(true);
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Not removing lock'));
    await rm(lockPath, { recursive: true, force: true });
  });

  it('reports wait progress with the holder PID and owner-metadata lines', async () => {
    const { writeFile } = await import('node:fs/promises');
    const tempDir = await makeTempDir('fireforge-wait-progress-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);
    // Line 1 pid, line 2 token, lines 3+ diagnostic metadata.
    await writeFile(
      join(lockPath, 'pid'),
      `${String(process.pid)}\nsome-token\ncommand=build\nstarted=2026-07-18T09:12:03.000Z\n`,
      'utf-8'
    );

    const progress: {
      waitedMs: number;
      timeoutMs: number;
      holder: { pid: number; alive: boolean; metadata: string[] } | undefined;
    }[] = [];

    await expect(
      withFileLock(lockPath, () => Promise.resolve('unreachable'), {
        timeoutMs: 150,
        pollMs: 5,
        staleMs: 60 * 60 * 1000,
        waitProgressMs: 20,
        onWaitProgress: (p) => progress.push(p),
        onTimeoutMessage: 'lock still held',
      })
    ).rejects.toThrow('lock still held');

    expect(progress.length).toBeGreaterThan(0);
    const first = progress[0];
    expect(first?.timeoutMs).toBe(150);
    expect(first?.waitedMs).toBeGreaterThanOrEqual(20);
    expect(first?.holder).toEqual({
      pid: process.pid,
      alive: true,
      metadata: ['command=build', 'started=2026-07-18T09:12:03.000Z'],
    });
  });

  it('reports an undefined holder when the PID file is unreadable', async () => {
    const tempDir = await makeTempDir('fireforge-wait-progress-anon-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath); // No pid file at all.

    const holders: unknown[] = [];
    await expect(
      withFileLock(lockPath, () => Promise.resolve('unreachable'), {
        timeoutMs: 120,
        pollMs: 5,
        staleMs: 60 * 60 * 1000,
        waitProgressMs: 20,
        onWaitProgress: ({ holder }) => holders.push(holder),
        onTimeoutMessage: 'lock still held',
      })
    ).rejects.toThrow('lock still held');

    expect(holders.length).toBeGreaterThan(0);
    expect(holders.every((holder) => holder === undefined)).toBe(true);
  });

  it('backs off the poll interval exponentially up to pollMaxMs', async () => {
    const tempDir = await makeTempDir('fireforge-poll-backoff-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);

    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(
        withFileLock(lockPath, () => Promise.resolve('unreachable'), {
          timeoutMs: 200,
          pollMs: 5,
          pollMaxMs: 20,
          staleMs: 60 * 60 * 1000,
          onTimeoutMessage: 'lock still held',
        })
      ).rejects.toThrow('lock still held');

      // Only the lock's own sleep uses these small delays in this test.
      const delays = timeoutSpy.mock.calls
        .map((call) => call[1])
        .filter((ms): ms is number => ms === 5 || ms === 10 || ms === 20);
      expect(delays.slice(0, 3)).toEqual([5, 10, 20]);
      // Once capped, every subsequent poll stays at pollMaxMs.
      expect(delays.slice(2).every((ms) => ms === 20)).toBe(true);
      expect(delays.length).toBeGreaterThan(3);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('does not report progress when the new wait options are absent', async () => {
    const tempDir = await makeTempDir('fireforge-no-progress-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    await mkdir(lockPath);

    const onWaitProgress = vi.fn();
    await expect(
      withFileLock(lockPath, () => Promise.resolve('unreachable'), {
        timeoutMs: 60,
        pollMs: 5,
        staleMs: 60 * 60 * 1000,
        onWaitProgress, // No waitProgressMs — progress reporting stays off.
        onTimeoutMessage: 'lock still held',
      })
    ).rejects.toThrow('lock still held');
    expect(onWaitProgress).not.toHaveBeenCalled();
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
