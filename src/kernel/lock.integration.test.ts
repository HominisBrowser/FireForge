// SPDX-License-Identifier: EUPL-1.2
/**
 * Locks between real processes, including holders that are killed outright.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sourceUrl, type StartedProcess, startScript } from '../testing/script.js';
import { useTempDir } from '../testing/temp.js';
import { acquireLock, readLockStatus, tryAcquireLock } from './lock.js';
import { isProcessGroupAlive } from './process/index.js';

const dir = useTempDir();
const lockPath = (): string => join(dir(), 'engine.lock');
const started: StartedProcess[] = [];
const groups: number[] = [];

afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

async function script(name: string, source: string, args: string[] = []): Promise<StartedProcess> {
  const path = join(dir(), `${name}.mts`);
  await writeFile(
    path,
    `import { acquireLock, withLock } from ${JSON.stringify(sourceUrl('kernel/lock.ts'))};\n` +
      `import { run } from ${JSON.stringify(sourceUrl('kernel/process/index.ts'))};\n` +
      `const lockPath = ${JSON.stringify(lockPath())};\n${source}`
  );
  const child = startScript(path, args, { cwd: dir() });
  started.push(child);
  return child;
}

describe.skipIf(process.platform === 'win32')('locks between processes', () => {
  it('serialises read-modify-write cycles across processes', async () => {
    const counter = join(dir(), 'counter');
    await writeFile(counter, '0');
    const worker = `
      import { readFile, writeFile } from 'node:fs/promises';
      for (let i = 0; i < 15; i++) {
        await withLock(lockPath, { waitMs: 60_000 }, async () => {
          const value = Number(await readFile(${JSON.stringify(counter)}, 'utf8'));
          await new Promise((resolve) => setTimeout(resolve, 2));
          await writeFile(${JSON.stringify(counter)}, String(value + 1));
        });
      }
    `;
    const workers = await Promise.all([1, 2, 3, 4].map((id) => script(`worker-${id}`, worker)));
    const results = await Promise.all(workers.map((child) => child.result));
    expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
    expect(await readFile(counter, 'utf8')).toBe('60');
  }, 60_000);

  it('takes over from a holder that was killed, without waiting for anything to time out', async () => {
    const holder = await script(
      'holder',
      `await acquireLock(lockPath, { info: { command: 'build' } });
       console.log('holding');
       setInterval(() => {}, 1000);`
    );
    await holder.waitForOutput('holding');
    expect((await readLockStatus(lockPath())).holders).toMatchObject([
      { pid: holder.pid, info: { command: 'build' } },
    ]);
    expect(await tryAcquireLock(lockPath())).toBeUndefined();
    holder.kill('SIGKILL');
    await holder.result;
    const startedAt = Date.now();
    const lock = await acquireLock(lockPath(), { waitMs: 10_000 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await lock.release();
  }, 30_000);

  it("keeps a killed holder's lock while the process group it started still runs", async () => {
    const holder = await script(
      'builder',
      `await acquireLock(lockPath, { info: { command: 'build' } });
       void run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
         processGroup: true,
         onProcessGroup: (owner) => console.log('group ' + owner.pid + ' started'),
       });
       setInterval(() => {}, 1000);`
    );
    const output = await holder.waitForOutput(' started');
    const pgid = Number(/group (\d+) started/.exec(output)?.[1]);
    groups.push(pgid);
    holder.kill('SIGKILL');
    await holder.result;
    expect(isProcessGroupAlive(pgid)).toBe(true);
    // The build the dead holder started is still writing: nobody else may start one.
    await expect(acquireLock(lockPath(), { waitMs: 300, label: 'build' })).rejects.toMatchObject({
      code: 'lock-timeout',
    });
    process.kill(-pgid, 'SIGKILL');
    const lock = await acquireLock(lockPath(), { waitMs: 10_000 });
    await lock.release();
  }, 30_000);

  it('releases on SIGTERM when the entry point runs the interrupt pipeline', async () => {
    const holder = await script(
      'polite',
      `import { installSignalHandlers } from ${JSON.stringify(sourceUrl('kernel/signals.ts'))};
       installSignalHandlers({ exit: (code) => process.exit(code), forceExit: (code) => process.exit(code) });
       await acquireLock(lockPath);
       console.log('holding');
       setInterval(() => {}, 1000);`
    );
    await holder.waitForOutput('holding');
    holder.kill('SIGTERM');
    expect((await holder.result).exitCode).toBe(143);
    expect(await readLockStatus(lockPath())).toMatchObject({ holders: [], unidentified: 0 });
  }, 30_000);
});
