// SPDX-License-Identifier: EUPL-1.2
/**
 * The interrupt pipeline in a real process: a command that holds a lock, is
 * halfway through a transaction and has a child running receives a signal.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sourceUrl, type StartedProcess, startScript } from '../testing/script.js';
import { useTempDir } from '../testing/temp.js';
import { exists } from './fs.js';
import { readLockStatus } from './lock.js';
import { isProcessAlive } from './process/index.js';
import { sleep } from './time.js';

const dir = useTempDir();
const started: StartedProcess[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

/** Waits (bounded) for a process killed with SIGKILL to disappear. */
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && isProcessAlive(pid); attempt++) await sleep(25);
  return !isProcessAlive(pid);
}

const kernel = (name: string): string => JSON.stringify(sourceUrl(`kernel/${name}`));

async function command(body: string): Promise<StartedProcess> {
  const path = join(dir(), 'command.mts');
  await writeFile(
    path,
    `import { writeFileSync } from 'node:fs';
     import { transaction } from ${kernel('journal.ts')};
     import { withLock } from ${kernel('lock.ts')};
     import { run } from ${kernel('process/index.ts')};
     import { installSignalHandlers, onShutdown } from ${kernel('signals.ts')};
     const dir = ${JSON.stringify(dir())};
     const never = new Promise(() => {});
     setInterval(() => {}, 1000);
     installSignalHandlers({
       exit: (code) => { console.log('exit ' + code); process.exit(code); },
       forceExit: (code) => { writeFileSync(dir + '/forced', String(code)); process.exit(code); },
     });
     ${body}`
  );
  const child = startScript(path, [], { cwd: dir() });
  started.push(child);
  return child;
}

describe.skipIf(process.platform === 'win32')('an interrupted command', () => {
  it('stops its child, undoes its half-made change, releases its lock, then exits 143', async () => {
    await writeFile(join(dir(), 'manifest.json'), 'old');
    const child = await command(`
      onShutdown('announce', (signal) => console.log('FIREFORGE-VERDICT: FAIL reason=killed signal=' + signal));
      onShutdown('finish', () => console.log('finish'));
      await withLock(dir + '/engine.lock', { info: { command: 'deploy' } }, () =>
        transaction(dir + '/state/deploy.journal', 'the deployment', async (tx) => {
          await tx.write(dir + '/manifest.json', 'new');
          await tx.write(dir + '/added/component.mjs', 'export {}');
          const helper = run(process.execPath, ['-e', 'console.log(process.pid); setTimeout(() => {}, 60000)'], {
            processGroup: true,
            onLine: (line) => console.log('helper ' + line),
          });
          await helper;
          await never;
        })
      );
    `);
    const output = await child.waitForOutput('helper ');
    const helper = Number(/helper (\d+)/.exec(output)?.[1]);
    pids.push(helper);
    expect(await readFile(join(dir(), 'manifest.json'), 'utf8')).toBe('new');
    expect((await readLockStatus(join(dir(), 'engine.lock'))).holders).toHaveLength(1);

    child.kill('SIGTERM');
    const result = await child.result;

    expect(result.exitCode).toBe(143);
    expect(await readFile(join(dir(), 'manifest.json'), 'utf8')).toBe('old');
    expect(await exists(join(dir(), 'added'))).toBe(false);
    expect(await exists(join(dir(), 'state/deploy.journal'))).toBe(false);
    expect((await readLockStatus(join(dir(), 'engine.lock'))).holders).toEqual([]);
    expect(isProcessAlive(helper)).toBe(false);
    const lines = result.stdout.trim().split('\n');
    // The verdict comes first, before anything that can stall; the exit comes last.
    expect(lines.filter((line) => !line.startsWith('helper'))).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=killed signal=SIGTERM',
      'finish',
      'exit 143',
    ]);
  }, 30_000);

  it('exits at once on a second signal, killing a child that would not stop', async () => {
    const child = await command(`
      void run(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('got SIGTERM')); console.log(process.pid); setTimeout(() => {}, 60000)"], {
        forwardSignals: true,
        graceMs: 60_000,
        onLine: (line) => console.log('stubborn ' + line),
      });
      await never;
    `);
    const stubborn = Number(/stubborn (\d+)/.exec(await child.waitForOutput('stubborn '))?.[1]);
    pids.push(stubborn);
    child.kill('SIGINT');
    // The first signal is being handled: the child got SIGTERM and ignores it.
    await child.waitForOutput('stubborn got SIGTERM');
    expect(isProcessAlive(stubborn)).toBe(true);
    const secondAt = Date.now();
    child.kill('SIGINT');
    const result = await child.result;
    expect(result.exitCode).toBe(130);
    expect(Date.now() - secondAt).toBeLessThan(5_000);
    expect(await readFile(join(dir(), 'forced'), 'utf8')).toBe('130');
    expect(result.stdout).not.toContain('exit 130');
    expect(await gone(stubborn)).toBe(true);
  }, 30_000);
});
