// SPDX-License-Identifier: EUPL-1.2
/**
 * Running real programs. The fixtures are `node -e` and `sh -c` one-liners,
 * so every assertion is about a real exit status, real pipes and real signals.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTempDir } from '../../testing/temp.js';
import * as log from '../log.js';
import { resetShutdown, runShutdown } from '../signals.js';
import { isProcessAlive, processHasExited, processIdentity } from './identity.js';
import { findExecutable, onProcessGroup, run, runBytes } from './spawn.js';
import type { ProcessOwnership } from './tree.js';

const dir = useTempDir();
const node = process.execPath;
const leftovers: number[] = [];
const logged: string[] = [];
let previousLog: log.LogConfig = {};

beforeEach(() => {
  logged.length = 0;
  previousLog = log.configureLog({ write: (text) => logged.push(text) });
});

/** A script that prints a word and exits, leaving a child of its own holding its output pipes. */
function leavesHolder(pidFile: string, word: string): string {
  return `
    const holder = require('node:child_process').spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { stdio: 'inherit' }
    );
    holder.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));
    console.log(${JSON.stringify(word)});
  `;
}

async function readPid(path: string): Promise<number> {
  return vi.waitFor(
    async () => {
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('pid not written yet');
      return pid;
    },
    { timeout: 10_000, interval: 20 }
  );
}

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  resetShutdown();
  log.configureLog(previousLog);
});

describe('run: capture', () => {
  it('captures stdout, stderr and the exit code without throwing on failure', async () => {
    const result = await run(node, [
      '-e',
      'console.log("out"); console.error("err"); process.exit(3)',
    ]);
    expect(result).toEqual({
      exitCode: 3,
      stdout: 'out\n',
      stderr: 'err\n',
      truncated: false,
      timedOut: false,
      outlived: 0,
    });
  });

  it('runs in the given directory with the environment overrides applied', async () => {
    const result = await run(
      node,
      [
        '-e',
        'console.log(process.cwd() + "|" + process.env.FF_SET + "|" + ("FF_GONE" in process.env))',
      ],
      { cwd: dir(), env: { FF_SET: 'yes', FF_GONE: undefined, PATH: process.env['PATH'] } }
    );
    expect(result.stdout.trim()).toBe(`${dir()}|yes|false`);
  });

  it('removes an inherited variable when its override is undefined', async () => {
    process.env['FF_INHERITED'] = '1';
    try {
      const kept = await run(node, ['-e', 'console.log("FF_INHERITED" in process.env)']);
      const removed = await run(node, ['-e', 'console.log("FF_INHERITED" in process.env)'], {
        env: { FF_INHERITED: undefined },
      });
      expect([kept.stdout.trim(), removed.stdout.trim()]).toEqual(['true', 'false']);
    } finally {
      delete process.env['FF_INHERITED'];
    }
  });

  it('feeds stdin and survives a child that never reads it', async () => {
    const echoed = await run(node, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'héllo',
    });
    expect(echoed.stdout).toBe('héllo');
    const ignored = await run(node, ['-e', 'process.exit(4)'], { input: 'x'.repeat(1_000_000) });
    expect(ignored.exitCode).toBe(4);
  });

  it('reassembles a multibyte character split across chunks', async () => {
    const script = `
      const bytes = Buffer.from('a€b');
      process.stdout.write(bytes.subarray(0, 2));
      setTimeout(() => process.stdout.write(bytes.subarray(2)), 50);
    `;
    expect((await run(node, ['-e', script])).stdout).toBe('a€b');
  });

  // Windows has no signal deaths: a terminated process reports a plain exit code.
  it.skipIf(process.platform === 'win32')(
    'maps a signal death to 128 plus the signal number',
    async () => {
      expect((await run(node, ['-e', 'process.kill(process.pid, "SIGINT")'])).exitCode).toBe(130);
      expect((await run(node, ['-e', 'process.kill(process.pid, "SIGTERM")'])).exitCode).toBe(143);
    }
  );

  it('dispatches complete lines per stream and flushes the final partial one', async () => {
    const lines: string[] = [];
    await run(
      node,
      ['-e', 'process.stdout.write("a\\r\\nb\\rc\\nlast"); process.stderr.write("e1\\n")'],
      {
        onLine: (line, stream) => lines.push(`${stream}:${line}`),
      }
    );
    expect(lines.filter((line) => line.startsWith('stdout'))).toEqual([
      'stdout:a',
      'stdout:b',
      'stdout:c',
      'stdout:last',
    ]);
    expect(lines).toContain('stderr:e1');
  });

  it('mirrors output to the given streams while still capturing it', async () => {
    const mirror = new PassThrough();
    const seen: Buffer[] = [];
    mirror.on('data', (chunk: Buffer) => seen.push(chunk));
    const result = await run(node, ['-e', 'console.log("shown")'], { mirror: { stdout: mirror } });
    expect(result.stdout).toBe('shown\n');
    expect(Buffer.concat(seen).toString()).toBe('shown\n');
  });

  it('reports a missing program as a missing dependency', async () => {
    await expect(run('fireforge-no-such-program', [])).rejects.toMatchObject({
      code: 'command-not-found',
      exitCode: 7,
    });
  });

  // A Windows child does not hold its parent's pipes open the same way.
  it.skipIf(process.platform === 'win32')(
    'resolves a clean exit while a background process still holds the pipes',
    async () => {
      const pidFile = join(dir(), 'holder.pid');
      const startedAt = Date.now();
      const result = await run(node, ['-e', leavesHolder(pidFile, 'done')]);
      leftovers.push(await readPid(pidFile));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('done\n');
      // What the holder might still write is lost, so the capture says it is incomplete.
      expect(result.truncated).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    }
  );
});

describe('run: deadline', () => {
  it('rejects with command-timeout carrying the last output, after letting SIGTERM be handled', async () => {
    const marker = join(dir(), 'handled');
    const script = `
      process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); });
      console.error('working on step 3');
      setTimeout(() => {}, 60000);
    `;
    await expect(
      run(node, ['-e', script, 'arg'], { timeoutMs: 400, graceMs: 5_000 })
    ).rejects.toMatchObject({
      code: 'command-timeout',
      message: expect.stringMatching(
        /timed out after 0s: [\s\S]* arg\nLast output \(stderr\):\n {2}working on step 3/
      ) as string,
    });
    // Windows terminates the child outright: no handler runs.
    if (process.platform !== 'win32') expect(await readFile(marker, 'utf8')).toBe('x');
  });

  // Windows has no signal a child can ignore, and no 128-plus-signal exit code.
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL after the grace when SIGTERM is ignored',
    async () => {
      const script = `process.on('SIGTERM', () => {}); console.log('up'); setTimeout(() => {}, 60000);`;
      const startedAt = Date.now();
      const result = await run(node, ['-e', script], {
        timeoutMs: 300,
        graceMs: 200,
        timeoutIsResult: true,
      });
      expect(result).toMatchObject({ timedOut: true, exitCode: 137, stdout: 'up\n' });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    }
  );

  it('does not report a timeout for a child that finished in time', async () => {
    const result = await run(node, ['-e', '0'], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ timedOut: false, exitCode: 0 });
  });
});

describe.skipIf(process.platform === 'win32')('run: process groups', () => {
  it('keeps the exit code and terminates a group member that outlived its leader', async () => {
    const pidFile = join(dir(), 'survivor.pid');
    const result = await run(
      'sh',
      ['-c', `(sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"); sleep 0.3; exit 0`],
      { processGroup: true }
    );
    const survivor = await readPid(pidFile);
    leftovers.push(survivor);
    expect(result.exitCode).toBe(0);
    expect(await processIdentity(survivor)).toBeUndefined();
    expect(logged.join('')).toContain('outlived their command and were terminated');
  });

  function detachingLeader(pidFile: string, argument: string): string {
    return `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', ${JSON.stringify(argument)}], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setTimeout(() => process.exit(0), 1000);
    `;
  }

  it('leaves a self-detached descendant it cannot attribute to this run', async () => {
    const pidFile = join(dir(), 'daemon.pid');
    let owner: ProcessOwnership | undefined;
    const result = await run(node, ['-e', detachingLeader(pidFile, 'not-anchored')], {
      processGroup: true,
      onProcessGroup: (ownership) => {
        owner = ownership;
        ownership.anchorTo([dir()]);
      },
    });
    const daemon = await readPid(pidFile);
    leftovers.push(daemon);
    expect(result.exitCode).toBe(0);
    expect(isProcessAlive(daemon)).toBe(true);
    const teardown = await owner?.finish(100);
    expect(teardown?.signalled.map((entry) => entry.pid)).not.toContain(daemon);
    expect(teardown?.detached.map((entry) => entry.pid)).toContain(daemon);
  });

  it('terminates a self-detached descendant whose command line names a directory this run owns', async () => {
    const pidFile = join(dir(), 'anchored.pid');
    const result = await run(node, ['-e', detachingLeader(pidFile, join(dir(), 'helper-data'))], {
      processGroup: true,
      onProcessGroup: (ownership) => {
        ownership.anchorTo([dir()]);
      },
    });
    const helper = await readPid(pidFile);
    leftovers.push(helper);
    expect(result.exitCode).toBe(0);
    expect(await processIdentity(helper)).toBeUndefined();
  });

  it("announces each group it starts and ends, and awaits the caller's own teardown", async () => {
    const events: string[] = [];
    const listener = {
      started: (pgid: number) => void events.push(`started ${pgid}`),
      ended: (pgid: number) => void events.push(`ended ${pgid}`),
    };
    onProcessGroup(listener);
    let pid = 0;
    await run(node, ['-e', '0'], {
      processGroup: true,
      onProcessGroup: (owner) => {
        pid = owner.pid;
      },
      afterExit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('caller teardown');
      },
    });
    expect(
      events.filter((event) => event.endsWith(String(pid)) || event === 'caller teardown')
    ).toEqual([`started ${pid}`, `ended ${pid}`, 'caller teardown']);
  });

  it("keeps the exit code and warns when the caller's teardown fails", async () => {
    const result = await run(node, ['-e', 'process.exit(2)'], {
      afterExit: () => Promise.reject(new Error('reap failed')),
    });
    expect(result.exitCode).toBe(2);
    expect(logged.join('')).toMatch(/Cleanup after PID \d+ failed: reap failed/);
  });
});

describe.skipIf(process.platform === 'win32')('run: interrupts', () => {
  it('forwards an interrupt to a process group as SIGTERM and holds the exit until it is gone', async () => {
    const marker = join(dir(), 'flushed');
    const script = `
      process.on('SIGTERM', () => setTimeout(() => {
        require('fs').writeFileSync(${JSON.stringify(marker)}, 'state saved');
        process.exit(0);
      }, 150));
      console.log('ready');
      setTimeout(() => {}, 60000);
    `;
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    const running = run(node, ['-e', script], {
      processGroup: true,
      graceMs: 5_000,
      onLine: ready,
    });
    await isReady;
    await runShutdown('SIGINT');
    // The pipeline returned, so the child's shutdown work is on disk.
    expect(await readFile(marker, 'utf8')).toBe('state saved');
    expect((await running).exitCode).toBe(0);
  });

  it('kills a forwarded child that ignores SIGTERM once its grace is over', async () => {
    const script = `process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 60000);`;
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    const running = run(node, ['-e', script], {
      forwardSignals: true,
      graceMs: 200,
      onLine: ready,
    });
    await isReady;
    await runShutdown('SIGTERM');
    expect((await running).exitCode).toBe(137);
  });

  it('does not signal a captured child by default, but still waits for it', async () => {
    const script = `process.on('SIGTERM', () => process.exit(9)); console.log('ready'); setTimeout(() => process.exit(0), 300);`;
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    const running = run(node, ['-e', script], { onLine: ready });
    await isReady;
    await runShutdown('SIGTERM');
    expect((await running).exitCode).toBe(0);
  });
});

describe('runBytes, findExecutable', () => {
  it('returns stdout as exact bytes', async () => {
    const result = await runBytes(node, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: Buffer.from([0, 255, 13, 10, 128]),
    });
    expect([...result.stdout]).toEqual([0, 255, 13, 10, 128]);
    expect(result.exitCode).toBe(0);
    await expect(runBytes('fireforge-no-such-program', [])).rejects.toMatchObject({
      code: 'command-not-found',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to pass off a read cut short by a leftover process as the output',
    async () => {
      const pidFile = join(dir(), 'holder.pid');
      await expect(runBytes(node, ['-e', leavesHolder(pidFile, 'partial')])).rejects.toMatchObject({
        code: 'command-output-incomplete',
      });
      leftovers.push(await readPid(pidFile));
    }
  );

  it('finds a program on PATH and reports an absent one as undefined', async () => {
    expect(await findExecutable('git')).toMatch(/[\\/]git(\.exe)?$/i);
    expect(await findExecutable('fireforge-no-such-program')).toBeUndefined();
  });

  // Process groups and `sh` are POSIX.
  it.skipIf(process.platform === 'win32')(
    'proves a killed tree is gone by identity, not by pid',
    async () => {
      const pidFile = join(dir(), 'child.pid');
      await run('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], {
        processGroup: true,
        timeoutMs: 300,
        timeoutIsResult: true,
      });
      const pid = await readPid(pidFile);
      leftovers.push(pid);
      await expect(processHasExited({ pid })).resolves.toBe(true);
    }
  );
});
