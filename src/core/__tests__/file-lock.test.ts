// SPDX-License-Identifier: EUPL-1.2
import { createLoggerMock } from '../../test-utils/module-mocks.js';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

import { rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { FireForgeError, GeneralError, LockContentionError } from '../../errors/base.js';
import { warn } from '../../utils/logger.js';
import {
  createSiblingLockPath,
  forceReleaseHeldLocksForSignal,
  withFileLock,
} from '../file-lock.js';

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
    // Pure suffix concatenation — no join/resolve, so the separators of the
    // input survive verbatim on every platform.
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
    // After SIGINT of `furnace preview`, `withFileLock`'s `finally { rm }`
    // is skipped because the signal handler calls `process.exit`. Age-gating
    // makes the next command wait the full staleness window (5 minutes)
    // before removing the orphan lock, even though the PID file already
    // points at a dead process. The PID-first check unblocks immediately.
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
    // TOCTOU: with rm-by-path recovery, two waiters can both observe the
    // dead owner, one re-acquires, and the other's rm deletes the fresh lock
    // — two processes in the critical section at once. The rename-aside reap
    // lets exactly one reaper win; the loser re-polls.
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

describe('a wait whose queue position keeps improving', () => {
  /**
   * Plants a live waiter file ahead of `selfStartedAt`. The registry keys on
   * the filename (`<startedAtMs>-<pid>-<uuid>`) and drops entries whose PID
   * is not alive, so the file must name this process to count.
   */
  async function plantWaiterAhead(lockPath: string, startedAtMs: number): Promise<string> {
    const dir = `${lockPath}.waiters`;
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${String(startedAtMs)}-${String(process.pid)}-${String(startedAtMs)}`);
    await writeFile(file, `${String(process.pid)}\n`, 'utf-8');
    return file;
  }

  /**
   * Runs a wait against a queue that retires one waiter per probe. The
   * drain deliberately takes LONGER than `timeoutMs`, so the outcome is
   * decided by whether an advance renews the budget.
   */
  async function runAdvancingQueue(extend: boolean): Promise<string> {
    const tempDir = await makeTempDir('fireforge-advancing-lock-');
    const lockPath = join(tempDir, 'engine-session.lock');
    await mkdir(lockPath);
    const ahead = [
      await plantWaiterAhead(lockPath, Date.now() - 60_000),
      await plantWaiterAhead(lockPath, Date.now() - 50_000),
      await plantWaiterAhead(lockPath, Date.now() - 40_000),
    ];

    // Two constraints fix these numbers, and they pull against each other.
    // The budget must span at least TWO probes, because the first only seeds
    // the best-seen position (it is not an advance) and the earliest genuine
    // extension is observable at the second; and the drain — three probes
    // apart — must outlast `timeoutMs`, or the sibling test below would
    // acquire instead of expiring. Probes land at ~200 ms and ~400 ms inside
    // a 500 ms budget against a ~600 ms drain, which leaves ~100 ms of slack
    // per probe rather than the ~20 ms that made a Windows runner's readdir
    // decide the result.
    return withFileLock(lockPath, () => Promise.resolve('acquired'), {
      timeoutMs: 500,
      pollMs: 20,
      staleMs: 60_000,
      waitProgressMs: 200,
      onWaitProgress: (): void => {
        const retiring = ahead.shift();
        // Synchronous removal, because the callback returns void and cannot
        // await the promise form: an un-awaited retirement can land AFTER
        // the probe that was supposed to observe it, and an un-awaited
        // release leaves `mkdir` seeing EEXIST past the intended free. Both
        // races are wide enough to decide the outcome on a slow runner.
        if (retiring !== undefined) rmSync(retiring, { force: true });
        // Free the lock only once the queue has drained, so acquiring
        // proves the wait outlived its original budget.
        if (ahead.length === 0) rmSync(lockPath, { recursive: true, force: true });
      },
      onTimeoutMessage: 'the engine lock is held',
      ...(extend ? { extendWhileAdvancing: { maxWaitMs: 10_000 } } : {}),
    });
  }

  it('survives a drain longer than its budget while the queue keeps moving', async () => {
    await expect(runAdvancingQueue(true)).resolves.toBe('acquired');
  });

  it('expires on the same queue without the extension — the behaviour is the extension', async () => {
    await expect(runAdvancingQueue(false)).rejects.toThrow(LockContentionError);
  });

  it('still starves on a queue that never moves', async () => {
    const tempDir = await makeTempDir('fireforge-stalled-lock-');
    const lockPath = join(tempDir, 'engine-session.lock');
    await mkdir(lockPath);
    await plantWaiterAhead(lockPath, Date.now() - 60_000);

    await expect(
      withFileLock(lockPath, () => Promise.resolve('never'), {
        timeoutMs: 150,
        pollMs: 10,
        staleMs: 60_000,
        waitProgressMs: 30,
        onWaitProgress: (): void => undefined,
        extendWhileAdvancing: { maxWaitMs: 10_000 },
        onTimeoutMessage: 'the engine lock is held',
      })
    ).rejects.toThrow(LockContentionError);
  });

  it('does not hand out a free budget on the FIRST probe of a stalled queue', async () => {
    // Regression: `bestAhead` started `undefined`, so the opening probe
    // always counted as an advance and granted a fresh full budget. A
    // `--wait-lock 300` run therefore waited ~600s against a queue that
    // never moved once. The wait must expire on roughly the budget asked
    // for, not on double it.
    const tempDir = await makeTempDir('fireforge-firstprobe-lock-');
    const lockPath = join(tempDir, 'engine-session.lock');
    await mkdir(lockPath);
    await plantWaiterAhead(lockPath, Date.now() - 60_000);

    const extensions: { ahead: number; budgetMs: number }[] = [];
    await expect(
      withFileLock(lockPath, () => Promise.resolve('never'), {
        timeoutMs: 200,
        pollMs: 10,
        staleMs: 60_000,
        waitProgressMs: 40,
        onWaitProgress: (): void => undefined,
        onWaitExtended: (extension): void => {
          extensions.push(extension);
        },
        extendWhileAdvancing: { maxWaitMs: 10_000 },
        onTimeoutMessage: 'the engine lock is held',
      })
    ).rejects.toThrow(LockContentionError);
    // Asserted on the callback rather than on elapsed time: the observation
    // is deterministic, where a wall-clock bound tight enough to separate
    // 200ms from 240ms would be flaky under load.
    expect(extensions).toEqual([]);
  });

  it('reports an extension when the queue actually advances', async () => {
    const tempDir = await makeTempDir('fireforge-extnotice-lock-');
    const lockPath = join(tempDir, 'engine-session.lock');
    await mkdir(lockPath);
    const ahead = [
      await plantWaiterAhead(lockPath, Date.now() - 60_000),
      await plantWaiterAhead(lockPath, Date.now() - 50_000),
    ];
    const extensions: { ahead: number; budgetMs: number }[] = [];

    // Same shape as `runAdvancingQueue` above, for the same reasons: the
    // retirement is synchronous so the probe that follows it cannot land
    // first, and the budget spans two probes with ~100 ms of slack each.
    // The un-awaited `rm` this used to do lost that race on a Windows
    // runner — the second probe still saw both waiters, the wait expired
    // "2 from the head of a queue of 3", and no extension was ever granted.
    await withFileLock(lockPath, () => Promise.resolve('acquired'), {
      timeoutMs: 500,
      pollMs: 20,
      staleMs: 60_000,
      waitProgressMs: 200,
      onWaitProgress: (): void => {
        const retiring = ahead.shift();
        if (retiring !== undefined) rmSync(retiring, { force: true });
        if (ahead.length === 0) rmSync(lockPath, { recursive: true, force: true });
      },
      onWaitExtended: (extension): void => {
        extensions.push(extension);
      },
      extendWhileAdvancing: { maxWaitMs: 10_000 },
      onTimeoutMessage: 'the engine lock is held',
    });

    expect(extensions.length).toBeGreaterThan(0);
    // The reported budget is the new TOTAL from the start of the wait, so it
    // can be compared directly against what the operator asked for.
    expect(extensions[0]?.budgetMs).toBeGreaterThan(500);
  });

  it('names the queue position the expired wait reached', async () => {
    const tempDir = await makeTempDir('fireforge-position-lock-');
    const lockPath = join(tempDir, 'engine-session.lock');
    await mkdir(lockPath);
    await plantWaiterAhead(lockPath, Date.now() - 60_000);
    await plantWaiterAhead(lockPath, Date.now() - 50_000);

    await expect(
      withFileLock(lockPath, () => Promise.resolve('never'), {
        timeoutMs: 120,
        pollMs: 10,
        staleMs: 60_000,
        waitProgressMs: 20,
        onWaitProgress: (): void => undefined,
        onTimeoutMessage: 'the engine lock is held',
      })
    ).rejects.toThrow(/still 2 from the head of a queue of 3/);
  });
});

describe('forceReleaseHeldLocksForSignal', () => {
  it('releases a lock this process still holds, as the signal path must', async () => {
    const tempDir = await makeTempDir('fireforge-signal-lock-');
    const lockPath = join(tempDir, 'engine-session.lock');

    // `withFileLock`'s finally never runs across process.exit; the sweep is
    // what keeps `status --lock` from reporting a dead holder.
    let released: string[] = [];
    await withFileLock(lockPath, async () => {
      released = await forceReleaseHeldLocksForSignal();
    });

    expect(released).toEqual([lockPath]);
    expect(await exists(lockPath)).toBe(false);
  });

  it('is a no-op when this process holds nothing', async () => {
    await expect(forceReleaseHeldLocksForSignal()).resolves.toEqual([]);
  });
});

describe('owner record write at acquisition', () => {
  // The owner record used to be best-effort: a failed write left a lock
  // directory with no readable PID, which the age heuristic reaps after five
  // minutes regardless of the holder being alive. The build lock legitimately
  // holds for hours, so a second `fireforge build` walked straight into the
  // critical section. The write is now fatal and the lock is released.
  it('releases the lock and refuses the operation when the owner record cannot be written', async () => {
    const tempDir = await makeTempDir('fireforge-owner-write-fail-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    const operation = vi.fn(() => Promise.resolve('never'));

    vi.mocked(writeFile).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    const failure = await withFileLock(lockPath, operation).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GeneralError);
    expect(failure).toBeInstanceOf(FireForgeError);
    expect((failure as Error).message).toContain('Could not record ownership of lock');
    expect((failure as Error).message).toContain('permission denied');
    expect(operation).not.toHaveBeenCalled();
    // No lock directory survives: the next contender must not wait five
    // minutes on an orphan that nobody owns.
    expect(await exists(lockPath)).toBe(false);
    // And it is not tracked as held either, so the signal sweep stays clean.
    await expect(forceReleaseHeldLocksForSignal()).resolves.toEqual([]);
  });

  it('treats an owner record that does not read back as written as a failed write', async () => {
    const tempDir = await makeTempDir('fireforge-owner-readback-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    const operation = vi.fn(() => Promise.resolve('never'));

    // The write "succeeds" but lands corrupt (e.g. a full disk truncating
    // the record): re-verification must catch it, not trust the syscall.
    const { writeFile: actualWriteFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile).mockImplementationOnce((path) =>
      actualWriteFile(path, 'not-a-pid\n', 'utf-8')
    );

    await expect(withFileLock(lockPath, operation)).rejects.toThrow(
      'owner record did not read back as written'
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await exists(lockPath)).toBe(false);
  });

  it('records the acquisition time so PID reuse can be detected later', async () => {
    const tempDir = await makeTempDir('fireforge-owner-acquired-at-');
    const lockPath = join(tempDir, 'state.json.fireforge.lock');
    const before = Date.now();
    const { readFile } = await import('node:fs/promises');

    const record = await withFileLock(
      lockPath,
      async () => readFile(join(lockPath, 'pid'), 'utf-8'),
      { ownerMetadata: ['command=build'] }
    );

    const [pidLine, tokenLine, acquiredLine, ...trailing] = record.trimEnd().split('\n');
    expect(pidLine).toBe(String(process.pid));
    expect(tokenLine).toMatch(/^[0-9a-f-]{36}$/);
    expect(acquiredLine).toMatch(/^acquired-at-ms=\d+$/);
    expect(Number(acquiredLine?.slice('acquired-at-ms='.length))).toBeGreaterThanOrEqual(before);
    // `start-tick=` is written only where procfs exposes it (Linux), so the
    // assertion on the caller's metadata must not depend on the platform.
    expect(trailing.filter((line) => !line.startsWith('start-tick='))).toEqual(['command=build']);
  });
});
