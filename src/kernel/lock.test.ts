// SPDX-License-Identifier: EUPL-1.2
/**
 * Locks against a real directory. Contention inside one process exercises the
 * same files a second process would touch; crashes and other processes are
 * covered in `lock.integration.test.ts`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useTempDir } from '../testing/temp.js';
import { ExitCode } from './errors.js';
import { acquireLock, type HeldLock, readLockStatus, tryAcquireLock, withLock } from './lock.js';
import * as log from './log.js';
import { ownIdentity, processIdentity, run } from './process/index.js';
import { resetShutdown, runShutdown } from './signals.js';
import { sleep } from './time.js';

const dir = useTempDir();
const lockPath = (): string => join(dir(), 'locks', 'engine.lock');
const logged: string[] = [];
const children: ChildProcess[] = [];
const held: HeldLock[] = [];
let previousLog: log.LogConfig = {};

beforeEach(() => {
  logged.length = 0;
  previousLog = log.configureLog({ write: (text) => logged.push(text), verbose: true });
});

afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  resetShutdown();
  log.configureLog(previousLog);
});

async function take(options: Parameters<typeof acquireLock>[1] = {}): Promise<HeldLock> {
  const lock = await acquireLock(lockPath(), options);
  held.push(lock);
  return lock;
}

/** Writes the owner record a process with the given identity would have left. */
async function forgeGate(
  generation: number,
  owner: { pid: number; start?: string },
  token = 'forged-token'
): Promise<void> {
  await mkdir(lockPath(), { recursive: true });
  await writeFile(
    join(lockPath(), `gate.${generation}`),
    JSON.stringify({
      ...owner,
      token,
      mode: 'exclusive',
      requestedAt: '2026-01-01T00:00:00.000Z',
      info: {},
    })
  );
}

/** Polls (bounded) until `condition` holds; for waiting on another acquisition's progress. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error('the condition never held');
}

const waiting = async (count: number): Promise<boolean> =>
  (await readLockStatus(lockPath())).waiting >= count;

/**
 * A meeting point for `count` bodies: each waits until all have arrived, or
 * a few seconds pass, so overlap is proven without relying on timing.
 */
function meetingPoint(count: number): { arrive(): Promise<void>; peak(): number } {
  let inside = 0;
  let peak = 0;
  let everyone: () => void = () => undefined;
  const all = new Promise<void>((resolve) => {
    everyone = resolve;
  });
  return {
    async arrive() {
      inside += 1;
      peak = Math.max(peak, inside);
      if (inside >= count) everyone();
      await Promise.race([all, sleep(5_000, { unref: true })]);
      inside -= 1;
    },
    peak: () => peak,
  };
}

/** A pid that existed a moment ago and is certainly gone now. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid ?? 0;
}

describe('exclusive', () => {
  it('runs one body at a time and returns its value', async () => {
    let inside = 0;
    let peak = 0;
    const body = async (value: number): Promise<number> => {
      inside += 1;
      peak = Math.max(peak, inside);
      await sleep(20);
      inside -= 1;
      return value;
    };
    const results = await Promise.all(
      [1, 2, 3, 4].map((value) => withLock(lockPath(), {}, () => body(value)))
    );
    expect(results).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(1);
  });

  it('releases when the body throws', async () => {
    await expect(
      withLock(lockPath(), {}, () => Promise.reject(new Error('body failed')))
    ).rejects.toThrow('body failed');
    await expect(withLock(lockPath(), { waitMs: 0 }, () => Promise.resolve('free'))).resolves.toBe(
      'free'
    );
  });

  it('refuses at once with exit code 15, naming the holder and what it is doing', async () => {
    await take({ info: { command: 'build' } });
    await expect(acquireLock(lockPath(), { waitMs: 0, label: 'engine' })).rejects.toMatchObject({
      code: 'lock-timeout',
      exitCode: ExitCode.LOCK_TIMEOUT,
      message: `Could not take the engine lock held by PID ${process.pid} (command=build).`,
    });
    expect(await tryAcquireLock(lockPath())).toBeUndefined();
  });

  it('times out after the wait, having reported who it waited for', async () => {
    await take({ info: { command: 'test' } });
    const startedAt = Date.now();
    await expect(acquireLock(lockPath(), { waitMs: 300, label: 'engine' })).rejects.toMatchObject({
      code: 'lock-timeout',
      message: expect.stringMatching(
        /^Timed out after 0s waiting for the engine lock held by PID \d+ \(command=test\)\./
      ) as string,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
  });

  it('takes the lock as soon as the holder lets go', async () => {
    const first = await take();
    const second = acquireLock(lockPath(), { waitMs: 5_000 });
    await until(() => waiting(1));
    await first.release();
    const lock = await second;
    held.push(lock);
    expect((await readLockStatus(lockPath())).holders).toHaveLength(1);
  });

  it('releases only once, and a second holder is not disturbed by a repeated release', async () => {
    const first = await take();
    await first.release();
    const second = await take();
    await first.release();
    expect(await tryAcquireLock(lockPath())).toBeUndefined();
    await second.release();
    const third = await tryAcquireLock(lockPath());
    expect(third).toBeDefined();
    await third?.release();
  });

  it('leaves no proposals, tickets or stale generations behind', async () => {
    const first = await take();
    const queued = acquireLock(lockPath(), { waitMs: 5_000 });
    await until(() => waiting(1));
    await first.release();
    await (await queued).release();
    const names = await readdir(lockPath());
    expect(names.filter((name) => name.startsWith('proposal.'))).toEqual([]);
    expect(names.filter((name) => /^gate\.\d+$/.test(name))).toHaveLength(1);
    expect(await readdir(join(lockPath(), 'waiters'))).toEqual([]);
  });
});

describe('a holder that is gone', () => {
  it('is taken over at once when its process no longer exists', async () => {
    await forgeGate(1, { pid: await deadPid(), start: 'whenever' });
    const lock = await take({ waitMs: 0 });
    expect(lock.path).toBe(lockPath());
    expect(logged.join('')).toContain('holder PID');
  });

  it.skipIf(process.platform === 'win32')(
    'is taken over when its pid now belongs to another process',
    async () => {
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      children.push(other);
      const identity = await processIdentity(other.pid ?? 0);
      await forgeGate(1, { pid: identity?.pid ?? 0, start: `${identity?.start}-earlier` });
      await take({ waitMs: 0 });
    }
  );

  it('is respected while its process lives, however old the record', async () => {
    const own = await ownIdentity();
    await forgeGate(
      1,
      { pid: process.pid, ...(own ? { start: own.start } : {}) },
      'another-acquisition'
    );
    const old = new Date(Date.now() - 24 * 3600_000);
    await utimes(join(lockPath(), 'gate.1'), old, old);
    expect(await tryAcquireLock(lockPath())).toBeUndefined();
  });

  it('is never taken over on an unreadable or damaged record', async () => {
    await mkdir(lockPath(), { recursive: true });
    await writeFile(join(lockPath(), 'gate.1'), '{"pid": ');
    await expect(acquireLock(lockPath(), { waitMs: 0, label: 'build' })).rejects.toMatchObject({
      message: 'Could not take the build lock held by 1 unidentified process(es).',
    });
    expect((await readLockStatus(lockPath())).unidentified).toBe(1);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is never taken over when the record cannot be opened',
    async () => {
      await forgeGate(1, { pid: await deadPid() });
      await chmod(join(lockPath(), 'gate.1'), 0o000);
      expect(await tryAcquireLock(lockPath())).toBeUndefined();
      await chmod(join(lockPath(), 'gate.1'), 0o600);
      await take({ waitMs: 0 });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'still holds the lock while a process group it started under the lock runs',
    async () => {
      const group = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
        detached: true,
      });
      children.push(group);
      await forgeGate(1, { pid: await deadPid() }, 'crashed-holder');
      await writeFile(join(lockPath(), `group.crashed-holder.${group.pid}`), '');
      expect(await tryAcquireLock(lockPath())).toBeUndefined();
      expect((await readLockStatus(lockPath())).holders).toHaveLength(1);
      process.kill(-(group.pid ?? 0), 'SIGKILL');
      await once(group, 'exit');
      await take({ waitMs: 2_000 });
      expect((await readdir(lockPath())).filter((name) => name.startsWith('group.'))).toEqual([]);
    }
  );

  it('recovers when the lock directory is removed by hand while someone waits', async () => {
    const own = await ownIdentity();
    await forgeGate(1, { pid: process.pid, ...(own ? { start: own.start } : {}) }, 'stuck');
    const queued = acquireLock(lockPath(), { waitMs: 5_000 });
    await until(() => waiting(1));
    // The waiter keeps writing while the directory goes, as it would under a person's rm -rf.
    await rm(lockPath(), { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
    held.push(await queued);
  });
});

describe('process groups started under a lock', () => {
  it.skipIf(process.platform === 'win32')(
    'are recorded on the lock while they run and forgotten once they are gone',
    async () => {
      await take();
      const seen: string[][] = [];
      await run(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], {
        processGroup: true,
        onProcessGroup: () => {
          // Synchronously after the spawn, the marker is already on disk.
          void readdir(lockPath()).then((names) => seen.push(names));
        },
      });
      expect(seen[0]?.some((name) => name.startsWith('group.'))).toBe(true);
      expect((await readdir(lockPath())).filter((name) => name.startsWith('group.'))).toEqual([]);
    }
  );
});

describe('shared', () => {
  it('lets shared holders overlap', async () => {
    const meeting = meetingPoint(3);
    await Promise.all(
      [1, 2, 3].map(() => withLock(lockPath(), { mode: 'shared' }, () => meeting.arrive()))
    );
    expect(meeting.peak()).toBe(3);
  });

  it('keeps an exclusive taker out until every shared holder is done', async () => {
    const events: string[] = [];
    const reader = await take({ mode: 'shared', info: { command: 'test' } });
    await expect(acquireLock(lockPath(), { waitMs: 150, label: 'engine' })).rejects.toMatchObject({
      message: expect.stringContaining('(command=test)') as string,
    });
    const writer = withLock(lockPath(), { waitMs: 5_000 }, () => {
      events.push('writer in');
      return Promise.resolve();
    });
    await until(async () =>
      (await readLockStatus(lockPath())).holders.some((holder) => holder.mode === 'exclusive')
    );
    events.push('reader out');
    await reader.release();
    await writer;
    expect(events).toEqual(['reader out', 'writer in']);
  });

  it('keeps shared takers out while an exclusive holder is in', async () => {
    await take();
    expect(await tryAcquireLock(lockPath(), { mode: 'shared' })).toBeUndefined();
  });

  it('does not let new shared holders overtake a waiting exclusive taker', async () => {
    const events: string[] = [];
    const first = await take({ mode: 'shared' });
    const writer = withLock(lockPath(), { waitMs: 5_000 }, () => {
      events.push('writer');
      return Promise.resolve();
    });
    // The writer holds the gate while it waits for the reader.
    await until(async () =>
      (await readLockStatus(lockPath())).holders.some((holder) => holder.mode === 'exclusive')
    );
    const latecomer = withLock(lockPath(), { mode: 'shared', waitMs: 5_000 }, () => {
      events.push('late reader');
      return Promise.resolve();
    });
    await until(() => waiting(1));
    expect(events).toEqual([]);
    await first.release();
    await Promise.all([writer, latecomer]);
    expect(events).toEqual(['writer', 'late reader']);
  });

  it('drops the record of a shared holder whose process is gone', async () => {
    await mkdir(lockPath(), { recursive: true });
    await writeFile(
      join(lockPath(), 'holder.gone'),
      JSON.stringify({
        pid: await deadPid(),
        token: 'gone',
        mode: 'shared',
        requestedAt: '',
        info: {},
      })
    );
    await take({ waitMs: 0 });
    expect((await readdir(lockPath())).includes('holder.gone')).toBe(false);
  });
});

describe('a limit on shared holders', () => {
  it('admits up to the limit and makes the next one wait its turn', async () => {
    const meeting = meetingPoint(2);
    let inside = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        withLock(lockPath(), { mode: 'shared', limit: 2, waitMs: 10_000 }, async () => {
          inside += 1;
          peak = Math.max(peak, inside);
          await meeting.arrive();
          inside -= 1;
        })
      )
    );
    expect(meeting.peak()).toBeGreaterThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it('names every holder when the limit is reached', async () => {
    await take({ mode: 'shared', limit: 2, info: { command: 'build', workspace: 'a' } });
    await sleep(5);
    await take({ mode: 'shared', limit: 2, info: { command: 'build', workspace: 'b' } });
    await expect(
      acquireLock(lockPath(), { mode: 'shared', limit: 2, waitMs: 0, label: 'build' })
    ).rejects.toMatchObject({
      message:
        `Could not take the build lock held by PID ${process.pid} (command=build, workspace=a), ` +
        `PID ${process.pid} (command=build, workspace=b).`,
    });
  });
});

describe('waiting', () => {
  it('grants the lock in arrival order, whatever the poll timing', async () => {
    const order: number[] = [];
    const first = await take();
    const waiters: Promise<void>[] = [];
    for (const id of [1, 2, 3]) {
      waiters.push(
        withLock(lockPath(), { waitMs: 10_000 }, () => {
          order.push(id);
          return Promise.resolve();
        })
      );
      await until(() => waiting(id));
    }
    expect((await readLockStatus(lockPath())).waiting).toBe(3);
    await first.release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect((await readLockStatus(lockPath())).waiting).toBe(0);
  });

  it('skips the ticket of a waiter that died, and removes it', async () => {
    const first = await take();
    await mkdir(join(lockPath(), 'waiters'), { recursive: true });
    const ticket = join(lockPath(), 'waiters', `1-${await deadPid()}-crashed`);
    await writeFile(ticket, JSON.stringify({ pid: 1 }));
    const queued = acquireLock(lockPath(), { waitMs: 5_000 });
    // The waiter reads the queue first, and a dead waiter's ticket goes then.
    await until(async () =>
      (await readdir(join(lockPath(), 'waiters'))).every((name) => !name.endsWith('-crashed'))
    );
    await first.release();
    held.push(await queued);
    await expect(readFile(ticket)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips the ticket of a live waiter that stopped refreshing it', async () => {
    const first = await take();
    await mkdir(join(lockPath(), 'waiters'), { recursive: true });
    const ticket = join(lockPath(), 'waiters', `1-${process.pid}-stopped`);
    await writeFile(ticket, JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 60_000);
    await utimes(ticket, old, old);
    const queued = acquireLock(lockPath(), { waitMs: 5_000 });
    // Its own ticket goes in beside the stale one, which no longer counts.
    await until(async () => (await readdir(join(lockPath(), 'waiters'))).length === 2);
    await first.release();
    held.push(await queued);
    await rm(ticket);
  });

  it('says where the wait ended when others were queued ahead', async () => {
    await take({ info: { command: 'build' } });
    const ahead = acquireLock(lockPath(), { waitMs: 2_000 }).catch(() => undefined);
    await until(() => waiting(1));
    await expect(acquireLock(lockPath(), { waitMs: 200, label: 'engine' })).rejects.toMatchObject({
      message: expect.stringMatching(
        /1 ahead of you in a queue of 2 \(granted in arrival order\)\.$/
      ) as string,
    });
    await ahead;
  }, 10_000);
});

describe('readLockStatus', () => {
  it('reads a missing or free lock as free, and lists holders with their details', async () => {
    expect(await readLockStatus(lockPath())).toEqual({ holders: [], unidentified: 0, waiting: 0 });
    const exclusive = await take({ info: { command: 'export' } });
    expect((await readLockStatus(lockPath())).holders).toEqual([
      {
        pid: process.pid,
        mode: 'exclusive',
        requestedAt: expect.any(String) as string,
        info: { command: 'export' },
      },
    ]);
    await exclusive.release();
    await take({ mode: 'shared' });
    await take({ mode: 'shared' });
    const status = await readLockStatus(lockPath());
    expect(status.holders.map((holder) => holder.mode)).toEqual(['shared', 'shared']);
  });
});

describe('interrupts', () => {
  it('releases every lock this process holds, so the next command does not wait on a dead holder', async () => {
    await take();
    const shared = await acquireLock(join(dir(), 'locks', 'build.lock'), { mode: 'shared' });
    held.push(shared);
    await runShutdown('SIGTERM');
    expect((await readLockStatus(lockPath())).holders).toEqual([]);
    expect((await readLockStatus(shared.path)).holders).toEqual([]);
  });
});
