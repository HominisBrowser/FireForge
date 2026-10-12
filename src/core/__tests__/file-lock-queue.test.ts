// SPDX-License-Identifier: EUPL-1.2
/**
 * The lock queue decides the grant, not just the display.
 *
 * A queued `test --build` was told "You are next in a queue of 5" for
 * minutes while three later waiters took the lock in turn: every waiter
 * raced `mkdir`, and the one whose poll had backed off to 2 s lost each
 * free moment to later arrivals polling faster. These tests pin arrival
 * order and the ways a ticket must stop holding the queue once its owner
 * is gone.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { LockContentionError } from '../../errors/base.js';
import { withFileLock } from '../file-lock.js';
import {
  formatLockQueuePosition,
  lockWaitersDir,
  readLockQueue,
  registerWaiter,
  WAITER_STALE_MS,
} from '../file-lock-queue.js';

const cleanupPaths: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.restoreAllMocks();
});

async function makeLockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fireforge-lock-queue-'));
  cleanupPaths.push(dir);
  return join(dir, 'engine-session.lock');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Polls until the queue reaches `depth`, so arrivals are really queued. */
async function waitForDepth(lockPath: string, depth: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await readLockQueue(lockPath)).depth < depth) {
    if (Date.now() >= deadline) throw new Error(`queue never reached depth ${String(depth)}`);
    await sleep(10);
  }
}

/** Plants a ticket the way a waiter writes one. */
async function plantTicket(
  lockPath: string,
  startedAt: number,
  pid: number,
  suffix = 'planted'
): Promise<string> {
  const dir = lockWaitersDir(lockPath);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${String(startedAt)}-${String(pid)}-${suffix}`);
  await writeFile(file, `${String(pid)}\n`, 'utf-8');
  return file;
}

/** A PID that was real moments ago and is now gone. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('could not spawn');
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

/** A live process that is not this one, standing in for another waiter. */
function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  children.push(child);
  return child;
}

describe('lock grants follow arrival order', () => {
  it('grants the earliest waiter first even when later waiters poll faster', async () => {
    const lockPath = await makeLockPath();
    const release = deferred();
    const inside = deferred();
    const order: string[] = [];

    const holder = withFileLock(lockPath, async () => {
      inside.resolve();
      await release.promise;
      order.push('holder');
    });
    await inside.promise;

    // The first waiter backs off to a long poll, the shape that lost every
    // race before: its next look at the lock comes long after the release.
    const waiter = (name: string, pollMs: number, pollMaxMs: number | undefined): Promise<void> =>
      withFileLock(
        lockPath,
        async () => {
          order.push(name);
          await sleep(20);
        },
        {
          timeoutMs: 20_000,
          pollMs,
          ...(pollMaxMs !== undefined ? { pollMaxMs } : {}),
        }
      );

    const first = waiter('first', 50, 600);
    await waitForDepth(lockPath, 1);
    await sleep(5);
    const second = waiter('second', 5, undefined);
    await waitForDepth(lockPath, 2);
    await sleep(5);
    const third = waiter('third', 5, undefined);
    await waitForDepth(lockPath, 3);
    // Let the first waiter's backoff grow well past the fast pollers'.
    await sleep(700);

    release.resolve();
    await Promise.all([holder, first, second, third]);
    expect(order).toEqual(['holder', 'first', 'second', 'third']);
  });

  it('queues a newcomer behind existing waiters even when the lock is momentarily free', async () => {
    const lockPath = await makeLockPath();
    const blocker = liveChild();
    // A live waiter that arrived earlier and has not taken its turn yet.
    await plantTicket(lockPath, Date.now() - 1_000, blocker.pid ?? 0);

    const operation = vi.fn(() => Promise.resolve('jumped the queue'));
    await expect(withFileLock(lockPath, operation, { timeoutMs: 300, pollMs: 10 })).rejects.toThrow(
      LockContentionError
    );
    expect(operation).not.toHaveBeenCalled();
    // It never even created the lock: only the head of the queue contends.
    expect(await exists(lockPath)).toBe(false);
  });

  it('states the position it held when it times out behind a live waiter', async () => {
    const lockPath = await makeLockPath();
    const blocker = liveChild();
    await plantTicket(lockPath, Date.now() - 1_000, blocker.pid ?? 0);

    await expect(
      withFileLock(lockPath, () => Promise.resolve(), {
        timeoutMs: 200,
        pollMs: 10,
        onTimeoutMessage: 'the engine lock is held',
      })
    ).rejects.toThrow(/still 1 from the head of a queue of 2/);
    // Its own ticket is gone, so it no longer counts against anyone.
    await expect(readLockQueue(lockPath)).resolves.toEqual({ depth: 1, ahead: 0 });
  });

  it('a waiter that times out leaves the queue, and the next one gets the lock', async () => {
    const lockPath = await makeLockPath();
    const release = deferred();
    const inside = deferred();
    const holder = withFileLock(lockPath, async () => {
      inside.resolve();
      await release.promise;
    });
    await inside.promise;

    const impatient = withFileLock(lockPath, () => Promise.resolve('never'), {
      timeoutMs: 150,
      pollMs: 10,
    });
    await waitForDepth(lockPath, 1);
    await sleep(5);
    const patient = withFileLock(lockPath, () => Promise.resolve('patient'), {
      timeoutMs: 10_000,
      pollMs: 10,
    });
    await expect(impatient).rejects.toThrow(LockContentionError);

    release.resolve();
    await holder;
    await expect(patient).resolves.toBe('patient');
    await expect(readLockQueue(lockPath)).resolves.toEqual({ depth: 0, ahead: 0 });
  });
});

describe('tickets whose owner is gone do not block the queue', () => {
  it('skips and removes the ticket of a waiter that crashed before its turn', async () => {
    const lockPath = await makeLockPath();
    const ticket = await plantTicket(lockPath, Date.now() - 10_000, await deadPid());

    await expect(
      withFileLock(lockPath, () => Promise.resolve('acquired'), { timeoutMs: 2_000 })
    ).resolves.toBe('acquired');
    expect(await exists(ticket)).toBe(false);
  });

  it('moves on when the waiter ahead is killed mid-wait', async () => {
    const lockPath = await makeLockPath();
    const blocker = liveChild();
    await plantTicket(lockPath, Date.now() - 1_000, blocker.pid ?? 0);

    const waiter = withFileLock(lockPath, () => Promise.resolve('acquired'), {
      timeoutMs: 10_000,
      pollMs: 10,
    });
    await sleep(150);
    blocker.kill('SIGKILL');
    await expect(waiter).resolves.toBe('acquired');
  });

  it('skips a ticket its live owner stopped refreshing, without removing it', async () => {
    // A stopped (^Z) waiter, or a PID reused by an unrelated process on a
    // platform with no start tick: the PID is alive, the ticket is not.
    const lockPath = await makeLockPath();
    const ticket = await plantTicket(lockPath, Date.now() - 120_000, process.pid);
    const old = new Date(Date.now() - WAITER_STALE_MS - 5_000);
    await utimes(ticket, old, old);

    await expect(readLockQueue(lockPath)).resolves.toEqual({ depth: 0, ahead: 0 });
    await expect(
      withFileLock(lockPath, () => Promise.resolve('acquired'), { timeoutMs: 2_000 })
    ).resolves.toBe('acquired');
    // Its owner may resume: the ticket stays for it to refresh.
    expect(await exists(ticket)).toBe(true);
  });
});

describe('readLockQueue', () => {
  it('breaks a tie on arrival time by ticket name, the same way for every reader', async () => {
    const lockPath = await makeLockPath();
    const at = Date.now();
    await plantTicket(lockPath, at, process.pid, 'a');
    await plantTicket(lockPath, at, process.pid, 'b');
    const selfA = `${String(at)}-${String(process.pid)}-a`;
    const selfB = `${String(at)}-${String(process.pid)}-b`;

    await expect(readLockQueue(lockPath, { startedAt: at, ticket: selfA })).resolves.toEqual({
      depth: 2,
      ahead: 0,
    });
    await expect(readLockQueue(lockPath, { startedAt: at, ticket: selfB })).resolves.toEqual({
      depth: 2,
      ahead: 1,
    });
  });

  it('still counts this waiter when its own ticket has gone missing', async () => {
    const lockPath = await makeLockPath();
    const at = Date.now();
    await plantTicket(lockPath, at - 1_000, process.pid, 'other');
    const missing = `${String(at)}-${String(process.pid)}-gone`;

    await expect(readLockQueue(lockPath, { startedAt: at, ticket: missing })).resolves.toEqual({
      depth: 2,
      ahead: 1,
    });
  });

  it('falls back to comparing wait starts for a waiter without a ticket', async () => {
    const lockPath = await makeLockPath();
    const at = Date.now();
    await plantTicket(lockPath, at - 1_000, process.pid, 'earlier');
    await plantTicket(lockPath, at + 1_000, process.pid, 'later');

    await expect(readLockQueue(lockPath, { startedAt: at })).resolves.toEqual({
      depth: 2,
      ahead: 1,
    });
  });

  it('ignores entries that are not tickets', async () => {
    const lockPath = await makeLockPath();
    await mkdir(lockWaitersDir(lockPath), { recursive: true });
    await writeFile(join(lockWaitersDir(lockPath), 'README'), 'not a ticket', 'utf-8');

    await expect(readLockQueue(lockPath)).resolves.toEqual({ depth: 0, ahead: 0 });
  });
});

describe('registerWaiter', () => {
  it('writes a ticket naming this process and removes it on deregistration', async () => {
    const lockPath = await makeLockPath();
    const registration = await registerWaiter(lockPath, Date.now());

    expect(registration.ticket).toMatch(new RegExp(`^\\d+-${String(process.pid)}-`));
    expect(await readdir(lockWaitersDir(lockPath))).toEqual([registration.ticket]);
    await registration.deregister();
    expect(await readdir(lockWaitersDir(lockPath))).toEqual([]);
  });

  it('refreshes its ticket on the heartbeat and recreates one that was removed', async () => {
    const lockPath = await makeLockPath();
    const registration = await registerWaiter(lockPath, Date.now());
    const file = join(lockWaitersDir(lockPath), registration.ticket ?? '');
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);

    // Not due yet: the ticket is left alone.
    await registration.heartbeat();
    expect((await stat(file)).mtimeMs).toBeLessThan(Date.now() - 30_000);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 6_000);
    await registration.heartbeat();
    vi.mocked(Date.now).mockRestore();
    expect((await stat(file)).mtimeMs).toBeGreaterThan(realNow - 5_000);

    await rm(file);
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 12_000);
    await registration.heartbeat();
    expect(await exists(file)).toBe(true);
  });

  it('degrades to no ticket, and the lock still works, when the registry cannot be written', async () => {
    const lockPath = await makeLockPath();
    // A plain file where the waiters directory should be.
    await writeFile(lockWaitersDir(lockPath), 'blocked', 'utf-8');

    const registration = await registerWaiter(lockPath, Date.now());
    expect(registration.ticket).toBeUndefined();
    await expect(registration.heartbeat()).resolves.toBeUndefined();
    await expect(registration.deregister()).resolves.toBeUndefined();

    const release = deferred();
    const inside = deferred();
    const holder = withFileLock(lockPath, async () => {
      inside.resolve();
      await release.promise;
    });
    await inside.promise;
    const waiter = withFileLock(lockPath, () => Promise.resolve('acquired'), {
      timeoutMs: 5_000,
      pollMs: 10,
    });
    await sleep(50);
    release.resolve();
    await holder;
    await expect(waiter).resolves.toBe('acquired');
  });
});

describe('formatLockQueuePosition', () => {
  it('names the position and the ordering rule', () => {
    expect(formatLockQueuePosition({ depth: 3, ahead: 0 })).toBe(
      ' You are next in a queue of 3 (granted in arrival order).'
    );
    expect(formatLockQueuePosition({ depth: 5, ahead: 2 })).toBe(
      ' 2 ahead of you (queue of 5, granted in arrival order).'
    );
  });

  it('says nothing when no queue was observed', () => {
    expect(formatLockQueuePosition(undefined)).toBe('');
    expect(formatLockQueuePosition({ depth: 0, ahead: 0 })).toBe('');
  });
});
