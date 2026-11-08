// SPDX-License-Identifier: EUPL-1.2
/**
 * A lock against real crashing processes: a SIGKILLed holder, what it left
 * running, and several contenders reaping at once.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { execStream } from '../../utils/process.js';
import { processIdentity, sameProcess } from '../../utils/process-birth.js';
import { withEngineSessionLock } from '../engine-session-lock.js';
import { withFileLock } from '../file-lock.js';
import {
  isLockOwnerAlive,
  isLockOwnerProvablyGone,
  LOCK_PID_FILE,
  readLockOwner,
} from '../file-lock-owner.js';

const SOURCE = dirname(fileURLToPath(import.meta.url));
const FILE_LOCK = join(SOURCE, '../file-lock.ts');
const ENGINE_LOCK = join(SOURCE, '../engine-session-lock.ts');
const PROCESS = join(SOURCE, '../../utils/process.ts');
const TSX = import.meta.resolve('tsx/esm');

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ff-lock-crash-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function runScript(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['--import', TSX, path, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe.skipIf(process.platform === 'win32')('a SIGKILLed holder', () => {
  it('keeps the lock held while the process group it started runs on', async () => {
    const root = await directory();
    const lock = join(root, 'x.lock');
    const pidFile = join(root, 'group.pid');
    const script = join(root, 'holder.mts');
    await writeFile(
      script,
      `
      import { readFileSync, writeFileSync } from 'node:fs';
      const { withFileLock } = await import(${JSON.stringify(FILE_LOCK)});
      const { execStream } = await import(${JSON.stringify(PROCESS)});
      await withFileLock(${JSON.stringify(lock)}, async () => {
        void execStream('sleep', ['2.5'], {
          processGroup: true,
          onProcessGroup: (pgid) => {
            writeFileSync(${JSON.stringify(pidFile)}, String(pgid));
          },
        });
        const record = readFileSync(${JSON.stringify(join(lock, LOCK_PID_FILE))}, 'utf8');
        if (!record.includes('child-group=')) throw new Error('group not recorded');
        process.kill(process.pid, 'SIGKILL');
      });
      `
    );
    const holder = runScript(script, []);
    expect(holder.status).toBeNull();
    const pgid = Number(await readFile(pidFile, 'utf8'));
    const group = processIdentity(pgid);
    expect(group).toBeDefined();
    const owner = await readLockOwner(lock);
    expect(owner.present && owner.childGroups).toEqual([pgid]);
    expect(owner.present && isLockOwnerAlive(owner)).toBe(true);

    // The holder is gone and the group is not: the contender has to wait it out.
    await withFileLock(lock, () => Promise.resolve(), { timeoutMs: 20_000, staleReprobeMs: 100 });

    expect(group !== undefined && sameProcess(group)).toBe(false);
  }, 40_000);

  it('drops a finished group from the record, so a reused id cannot hold the lock', async () => {
    const root = await directory();
    const lock = join(root, 'x.lock');
    await withFileLock(lock, async () => {
      let recorded: number[] | undefined;
      await execStream('sh', ['-c', 'sleep 0.3'], {
        processGroup: true,
        onProcessGroup: () => {
          recorded = undefined;
        },
        postCloseSweep: async () => {
          const owner = await readLockOwner(lock);
          recorded = owner.present ? owner.childGroups : undefined;
        },
      });
      expect(recorded).toBeUndefined();
      const owner = await readLockOwner(lock);
      expect(owner.present && owner.pid).toBe(process.pid);
      expect(owner.present && owner.childGroups).toBeUndefined();
    });
  });
});

describe.skipIf(process.platform === 'win32')('a recorded owner', () => {
  it('is never reaped for an unreadable record, however old the lock', async () => {
    const root = await directory();
    const lock = join(root, 'x.lock');
    await mkdir(lock);
    const record = join(lock, LOCK_PID_FILE);
    await writeFile(record, `${process.pid}\ntoken\n`);
    await chmod(record, 0o000);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(lock, old, old);
    expect(await readLockOwner(lock)).toEqual({ present: false, unreadable: true });

    await expect(
      withFileLock(lock, () => Promise.resolve('entered'), {
        timeoutMs: 300,
        pollMs: 20,
        staleMs: 1_000,
        staleReprobeMs: 0,
      })
    ).rejects.toThrow(/Timed out/);

    await chmod(record, 0o600);
    expect(await readLockOwner(lock)).toMatchObject({ present: true, pid: process.pid });
  });

  it.runIf(process.platform === 'darwin')(
    'whose PID was reused is settled by its birth on the stale probe, not on a poll',
    async () => {
      const live = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      try {
        const pid = live.pid ?? 0;
        const birth = await vi.waitFor(() => {
          const identity = processIdentity(pid);
          if (identity === undefined) throw new Error('not running yet');
          return identity.start;
        });
        const reused = { present: true as const, pid, birth: '1', metadata: [] };
        const same = { present: true as const, pid, birth, metadata: [] };
        expect(isLockOwnerAlive(reused)).toBe(true);
        expect(await isLockOwnerProvablyGone(reused)).toBe(true);
        expect(await isLockOwnerProvablyGone(same)).toBe(false);

        const root = await directory();
        const lock = join(root, 'x.lock');
        await mkdir(lock);
        await writeFile(join(lock, LOCK_PID_FILE), `${pid}\ntoken\nbirth=1\n`);
        await expect(
          withFileLock(lock, () => Promise.resolve('entered'), { timeoutMs: 2_000, pollMs: 20 })
        ).resolves.toBe('entered');
      } finally {
        live.kill('SIGKILL');
      }
    }
  );
});

describe.skipIf(process.platform === 'win32')('contenders reaping crashed holders', () => {
  it('keeps exclusion, with no fatal and no displaced holder', async () => {
    const root = await directory();
    const lock = join(root, 'x.lock');
    const inside = join(root, 'inside');
    const script = join(root, 'worker.mts');
    await writeFile(
      script,
      `
      import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
      const { withFileLock } = await import(${JSON.stringify(FILE_LOCK)});
      const deadline = Number(process.argv[2]);
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (Date.now() < deadline) {
        try {
          await withFileLock(${JSON.stringify(lock)}, async () => {
            for (;;) {
              try {
                const fd = openSync(${JSON.stringify(inside)}, 'wx');
                writeSync(fd, String(process.pid));
                closeSync(fd);
                break;
              } catch {
                let other = 0;
                try { other = Number(readFileSync(${JSON.stringify(inside)}, 'utf8')); } catch { continue; }
                if (other && other !== process.pid && alive(other)) {
                  console.log('VIOLATION');
                  return;
                }
                try { unlinkSync(${JSON.stringify(inside)}); } catch { /* raced */ }
              }
            }
            console.log('ENTER');
            if (Math.random() < 0.3) process.kill(process.pid, 'SIGKILL');
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
            try { unlinkSync(${JSON.stringify(inside)}); } catch { /* raced */ }
          }, { timeoutMs: 60000, pollMs: 1, staleReprobeMs: 0 });
        } catch (error) {
          console.log('ERR ' + String(error?.message).split('\\n')[0]);
        }
      }
      `
    );
    const deadline = Date.now() + 8_000;
    const output: string[] = [];
    const runOne = (): Promise<void> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', TSX, script, String(deadline)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (data: Buffer) => output.push(String(data)));
        child.stderr.on('data', (data: Buffer) => output.push(String(data)));
        child.once('close', () => {
          resolve(Date.now() < deadline ? runOne() : undefined);
        });
      });

    await Promise.all(Array.from({ length: 5 }, runOne));

    const text = output.join('');
    expect(text).toContain('ENTER');
    expect(text).not.toContain('VIOLATION');
    expect(text).not.toContain('ERR ');
    expect(text).not.toContain('now owned by PID');
    expect(text).not.toContain('Could not record ownership');
  }, 90_000);
});

describe.skipIf(process.platform === 'win32')('the engine session lock', () => {
  // The worker's own global keeps the suite from serialising; no environment
  // variable a real CLI can inherit may have that effect.
  it('still excludes in a CLI whose environment looks like a test run', async () => {
    const root = await directory();
    const script = join(root, 'contender.mts');
    await writeFile(
      script,
      `
      const { withEngineSessionLock } = await import(${JSON.stringify(ENGINE_LOCK)});
      try {
        await withEngineSessionLock(${JSON.stringify(root)}, 'contender', async () => {
          console.log('ENTERED');
        });
      } catch (error) {
        console.log('REFUSED ' + error.message);
      }
      `
    );
    const previous = process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'];
    process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] = '1';
    try {
      await withEngineSessionLock(root, 'holder', async () => {
        const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', VITEST: 'true' };
        delete env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'];
        const child = spawn(process.execPath, ['--import', TSX, script], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (data: Buffer) => {
          stdout += String(data);
        });
        await new Promise((resolve) => child.once('close', resolve));
        expect(stdout).toContain('REFUSED');
        expect(stdout).not.toContain('ENTERED');
      });
    } finally {
      if (previous === undefined)
        delete process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'];
      else process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] = previous;
    }
  }, 30_000);
});
