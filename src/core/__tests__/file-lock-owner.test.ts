// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

// `readFile` is interposed so the read-back tests can inject errno failures.
// Every other test goes straight through to the real implementation.
const fsPromises = vi.hoisted(() => ({
  readFile: vi.fn<typeof import('node:fs/promises').readFile>(),
  actualReadFile: undefined as typeof import('node:fs/promises').readFile | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsPromises.actualReadFile = actual.readFile;
  return { ...actual, readFile: fsPromises.readFile };
});
const mockReadFile = fsPromises.readFile;
const passThroughReadFile = (): void => {
  mockReadFile.mockReset();
  mockReadFile.mockImplementation((...args) => {
    if (fsPromises.actualReadFile === undefined) throw new Error('fs mock not initialised');
    return fsPromises.actualReadFile(...args);
  });
};
passThroughReadFile();

import { verbose } from '../../utils/logger.js';
import { withFileLock } from '../file-lock.js';
import {
  isLockOwnerAlive,
  readLockOwner,
  readProcessStartTick,
  writeLockOwner,
} from '../file-lock-owner.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
  passThroughReadFile();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

/**
 * Builds a fake procfs with one `<root>/<pid>/stat` whose field 22 is
 * `startTick`. `comm` contains spaces and a parenthesis on purpose so the
 * parser's "split after the last `)`" rule is exercised.
 */
async function makeFakeProc(
  pid: number,
  startTick: number,
  comm = 'node (worker) 2'
): Promise<string> {
  const root = await makeTempDir('fireforge-fake-proc-');
  const fields = Array.from({ length: 50 }, (_, index) => String(index));
  fields[19] = String(startTick);
  await mkdir(join(root, String(pid)));
  await writeFile(
    join(root, String(pid), 'stat'),
    `${String(pid)} (${comm}) ${fields.join(' ')}\n`
  );
  return root;
}

describe('readLockOwner', () => {
  it('parses a pre-0.46 record with no mechanical lines (backward compatibility)', async () => {
    const lockPath = await makeTempDir('fireforge-owner-old-');
    await writeFile(join(lockPath, 'pid'), '4242\nsome-token\ncommand=build\n', 'utf-8');

    await expect(readLockOwner(lockPath)).resolves.toEqual({
      present: true,
      pid: 4242,
      token: 'some-token',
      metadata: ['command=build'],
    });
  });

  it('lifts the acquisition time and start tick out of the metadata lines', async () => {
    const lockPath = await makeTempDir('fireforge-owner-new-');
    await writeFile(
      join(lockPath, 'pid'),
      '4242\nsome-token\ncommand=build\nacquired-at-ms=1700000000000\nstart-tick=123456\nstarted=now\n',
      'utf-8'
    );

    await expect(readLockOwner(lockPath)).resolves.toEqual({
      present: true,
      pid: 4242,
      token: 'some-token',
      acquiredAtMs: 1_700_000_000_000,
      startTick: 123_456,
      metadata: ['command=build', 'started=now'],
    });
  });

  it('ignores malformed mechanical lines and a PID-only record still parses', async () => {
    const lockPath = await makeTempDir('fireforge-owner-malformed-');
    await writeFile(join(lockPath, 'pid'), '4242\n\nacquired-at-ms=soon\nstart-tick=x\n', 'utf-8');

    await expect(readLockOwner(lockPath)).resolves.toEqual({
      present: true,
      pid: 4242,
      metadata: [],
    });
  });

  it('reports absent for a missing or non-numeric record', async () => {
    const lockPath = await makeTempDir('fireforge-owner-absent-');
    await expect(readLockOwner(lockPath)).resolves.toEqual({ present: false });
    await writeFile(join(lockPath, 'pid'), 'garbage\n', 'utf-8');
    await expect(readLockOwner(lockPath)).resolves.toEqual({ present: false });
  });
});

describe('writeLockOwner', () => {
  it('drops caller-supplied metadata lines that would forge the mechanical fields', async () => {
    const lockPath = await makeTempDir('fireforge-owner-forge-');
    await writeLockOwner(lockPath, 'token-1', [
      'acquired-at-ms=1',
      'start-tick=1',
      'command=build',
      '  ',
      'a\nb',
    ]);

    const owner = await readLockOwner(lockPath);
    expect(owner).toMatchObject({
      pid: process.pid,
      token: 'token-1',
      metadata: ['command=build', 'a b'],
    });
    expect(owner.present && owner.acquiredAtMs).toBeGreaterThan(1);
    if (process.platform === 'linux') {
      expect(owner.present && owner.startTick).toBe(readProcessStartTick(process.pid));
    } else {
      expect(owner.present && owner.startTick).toBeUndefined();
    }
  });

  it('removes the lock directory and throws when the record cannot be written', async () => {
    const parent = await makeTempDir('fireforge-owner-nodir-');
    // The lock directory does not exist, so the write fails with ENOENT.
    const lockPath = join(parent, 'missing.lock');
    await expect(writeLockOwner(lockPath, 'token-1', undefined)).rejects.toThrow(
      'Could not record ownership of lock'
    );
  });

  it('retries a transient read-back error instead of treating it as a missing record', async () => {
    const lockPath = await makeTempDir('fireforge-owner-ebusy-');
    // The first two read-backs fail like an on-access scanner holding the
    // file. The third succeeds. The write must be accepted, not reverted.
    const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    mockReadFile.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);

    await expect(writeLockOwner(lockPath, 'token-2', ['command=build'])).resolves.toBeUndefined();
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8')).toContain('token-2');
  });

  it('gives up after repeated read-back errors, naming the errno', async () => {
    const lockPath = await makeTempDir('fireforge-owner-eio-');
    const eio = Object.assign(new Error('i/o error'), { code: 'EIO' });
    mockReadFile.mockRejectedValue(eio);

    await expect(writeLockOwner(lockPath, 'token-3', undefined)).rejects.toThrow(
      /could not be read back: i\/o error/
    );
  });

  it('still fails when the record reads back as a different owner', async () => {
    const lockPath = await makeTempDir('fireforge-owner-mismatch-');
    mockReadFile.mockResolvedValueOnce('99999\nsomeone-else\n');

    await expect(writeLockOwner(lockPath, 'token-4', undefined)).rejects.toThrow(
      'did not read back as written'
    );
  });
});

describe('readProcessStartTick', () => {
  it('reads the start tick from field 22 after the parenthesised comm', async () => {
    const procRoot = await makeFakeProc(777, 12_345);
    expect(readProcessStartTick(777, procRoot)).toBe(12_345);
  });

  it('returns undefined without a stat file or a numeric field', async () => {
    const noProc = await makeTempDir('fireforge-no-proc-');
    expect(readProcessStartTick(process.pid, noProc)).toBeUndefined();

    const procRoot = await makeFakeProc(777, 12_345);
    expect(readProcessStartTick(778, procRoot)).toBeUndefined();

    await writeFile(join(procRoot, '777', 'stat'), '777 (node) S 1 2\n', 'utf-8');
    expect(readProcessStartTick(777, procRoot)).toBeUndefined();
  });

  it.skipIf(process.platform !== 'linux')(
    'agrees with process.uptime() for this process on real procfs',
    () => {
      // USER_HZ is 100: the tick count divided by 100 is seconds since boot,
      // which must land within a few seconds of (uptime of the box - uptime
      // of this process). /proc/uptime is the boot-relative reference.
      const systemUptimeSeconds = Number.parseFloat(
        readFileSync('/proc/uptime', 'utf-8').split(' ')[0] ?? '0'
      );
      const expectedTick = (systemUptimeSeconds - process.uptime()) * 100;
      const actual = readProcessStartTick(process.pid);
      expect(actual).toBeDefined();
      expect(Math.abs((actual ?? 0) - expectedTick)).toBeLessThan(500);
    }
  );
});

describe('isLockOwnerAlive', () => {
  it('reports a dead PID as dead without consulting procfs', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('true');
    const deadPid: number = await new Promise((resolve) => {
      child.once('exit', () => {
        resolve(child.pid ?? -1);
      });
    });
    expect(deadPid).toBeGreaterThan(0);
    expect(isLockOwnerAlive({ pid: deadPid, startTick: 1 })).toBe(false);
  });

  it('keeps the PID-only answer when the record or the platform lacks a start tick', async () => {
    const noProc = await makeTempDir('fireforge-no-proc-');
    expect(isLockOwnerAlive({ pid: process.pid })).toBe(true);
    expect(isLockOwnerAlive({ pid: process.pid, startTick: 1 }, noProc)).toBe(true);
  });

  it('treats a live PID whose start tick differs from the record as reused', async () => {
    const procRoot = await makeFakeProc(process.pid, 500_000);

    // The record was written by a process started at tick 400000. The one
    // wearing the PID now started at 500000, so it cannot be the writer.
    expect(isLockOwnerAlive({ pid: process.pid, startTick: 400_000 }, procRoot)).toBe(false);
    expect(vi.mocked(verbose)).toHaveBeenCalledWith(expect.stringContaining('the PID was reused'));
    // Same start tick: the genuine holder.
    expect(isLockOwnerAlive({ pid: process.pid, startTick: 500_000 }, procRoot)).toBe(true);
  });

  it('is unaffected by the wall clock being stepped after acquisition', async () => {
    // The old wall-clock design compared acquired-at-ms with btime-derived
    // start times and reaped a live holder after a forward clock step. The
    // tick comparison never consults Date.now().
    const procRoot = await makeFakeProc(process.pid, 500_000);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      expect(isLockOwnerAlive({ pid: process.pid, startTick: 500_000 }, procRoot)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'lets withFileLock reap a lock whose live PID carries another start tick on real procfs',
    async () => {
      const tempDir = await makeTempDir('fireforge-pid-reuse-lock-');
      const lockPath = join(tempDir, 'state.json.fireforge.lock');
      await mkdir(lockPath);
      // Our own PID is alive. A record claiming a start tick of 1 can only
      // have been written by an earlier process that has since died and had
      // its PID recycled.
      await writeFile(join(lockPath, 'pid'), `${String(process.pid)}\nold-token\nstart-tick=1\n`);

      await expect(
        withFileLock(lockPath, () => Promise.resolve('recovered'), {
          timeoutMs: 2_000,
          pollMs: 5,
          staleMs: 60 * 60 * 1000,
        })
      ).resolves.toBe('recovered');
    }
  );
});
