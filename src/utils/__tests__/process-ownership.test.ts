// SPDX-License-Identifier: EUPL-1.2
/**
 * What a process tree's owner may signal, against real processes. Mocks cannot
 * see the costs and races this code exists for, and anything that decides who
 * gets signalled has to be shown on the real process table.
 */
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecTimeoutError } from '../../errors/base.js';
import { exec, execStream } from '../process.js';
import {
  isAliveIn,
  type ProcessBirth,
  processHasExitedAsync,
  processIdentity,
  processIdentityAsync,
  sameProcess,
  signalIfAlive,
  snapshotFromProcfs,
  snapshotProcesses,
} from '../process-birth.js';
import { setProcessCleanupReporter } from '../process-cleanup.js';
import { ownProcessTree, type ProcessOwnership, ProcessTreeSampler } from '../process-group.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});
vi.mock('../process-birth.js', async (original) => {
  const actual = await original<typeof import('../process-birth.js')>();
  return { ...actual, snapshotProcesses: vi.fn(actual.snapshotProcesses) };
});

const directories: string[] = [];
const started: ProcessBirth[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ff-ownership-'));
  directories.push(path);
  return path;
}

/** Waits for a pid file a fixture writes. */
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

/** Remembers a fixture process, so the test ends it whatever happens. */
function fixture(pid: number): ProcessBirth {
  const identity = processIdentity(pid);
  if (identity === undefined) throw new Error(`Fixture ${pid} is not running`);
  started.push(identity);
  return identity;
}

/**
 * A leader that starts a self-detached node process and lingers long enough for
 * the sampler to see the descent.
 */
function detachingLeader(pidFile: string, argument: string): string {
  return `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', ${JSON.stringify(argument)}], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setTimeout(() => process.exit(0), 1000);
  `;
}

afterEach(async () => {
  vi.mocked(snapshotProcesses).mockClear();
  for (const identity of started.splice(0)) {
    if (sameProcess(identity)) process.kill(identity.pid, 'SIGKILL');
  }
  setProcessCleanupReporter(() => Promise.resolve());
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('exec results', () => {
  it('resolves a clean exit 0 while a background process holds the pipes', async () => {
    const root = await directory();
    const pidFile = join(root, 'bg.pid');
    const result = await exec('sh', [
      '-c',
      `echo hello; sleep 30 & echo $! > ${JSON.stringify(pidFile)}; exit 0`,
    ]);
    const background = fixture(await readPid(pidFile));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.pipesHeld).toBe(true);
    // Holding a pipe does not make a process this command's to signal.
    await expect(processHasExitedAsync(background)).resolves.toBe(false);
  });

  it('gives a timed-out command its grace to run a SIGTERM handler', async () => {
    const root = await directory();
    const handled = join(root, 'handled');
    await expect(
      exec(
        'sh',
        [
          '-c',
          `trap 'echo yes > ${JSON.stringify(handled)}; exit 0' TERM; while :; do sleep 0.05; done`,
        ],
        { timeout: 300 }
      )
    ).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(await readFile(handled, 'utf8')).toContain('yes');
  });

  it('escalates to SIGKILL after the grace when a timed-out command ignores SIGTERM', async () => {
    const root = await directory();
    const pidFile = join(root, 'leader.pid');
    const startedAt = Date.now();
    await expect(
      exec(
        'sh',
        ['-c', `trap '' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 0.05; done`],
        { timeout: 300 }
      )
    ).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1500);
    expect(processIdentity(await readPid(pidFile))).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('positive tree ownership', () => {
  it('keeps the exit code and terminates a group member that outlived its leader', async () => {
    const root = await directory();
    const pidFile = join(root, 'survivor.pid');
    const code = await execStream(
      'sh',
      [
        '-c',
        `(sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}); sleep 0.3; exit 0`,
      ],
      { processGroup: true }
    );
    expect(code).toBe(0);
    expect(processIdentity(await readPid(pidFile))).toBeUndefined();
  });

  it('leaves a self-detached descendant it cannot anchor to this run', async () => {
    const root = await directory();
    const pidFile = join(root, 'daemon.pid');
    let owner: ProcessOwnership | undefined;
    const code = await execStream(
      process.execPath,
      ['-e', detachingLeader(pidFile, 'not-anchored')],
      {
        processGroup: true,
        onProcessGroup: (_id, ownership) => {
          owner = ownership;
          owner?.anchorTo([root]);
        },
      }
    );
    const daemon = fixture(await readPid(pidFile));
    expect(code).toBe(0);
    await expect(processHasExitedAsync(daemon)).resolves.toBe(false);
    const teardown = await owner?.finish();
    expect(teardown?.signalled.map((entry) => entry.pid)).not.toContain(daemon.pid);
    expect(teardown?.detached.map((entry) => entry.pid)).toContain(daemon.pid);
  });

  it('terminates a self-detached descendant whose command line names this run', async () => {
    const root = await directory();
    const pidFile = join(root, 'anchored.pid');
    let owner: ProcessOwnership | undefined;
    const code = await execStream(
      process.execPath,
      ['-e', detachingLeader(pidFile, join(root, 'helper-data'))],
      {
        processGroup: true,
        onProcessGroup: (_id, ownership) => {
          owner = ownership;
          owner?.anchorTo([root]);
        },
      }
    );
    expect(code).toBe(0);
    expect(processIdentity(await readPid(pidFile))).toBeUndefined();
    expect((await owner?.finish())?.signalled.length).toBeGreaterThan(0);
  });

  it('never terminates the job supervisor, even when its command line names this run', async () => {
    const root = await directory();
    const pidFile = join(root, 'supervisor.pid');
    const argument = join(root, 'dist/src/core/jobs/supervisor-main.js');
    const code = await execStream(process.execPath, ['-e', detachingLeader(pidFile, argument)], {
      processGroup: true,
      onProcessGroup: (_id, ownership) => {
        ownership?.anchorTo([root]);
      },
    });
    const supervisor = fixture(await readPid(pidFile));
    expect(code).toBe(0);
    await expect(processHasExitedAsync(supervisor)).resolves.toBe(false);
  });

  it('never signals a PID whose birth no longer matches', async () => {
    const root = await directory();
    const pidFile = join(root, 'other.pid');
    await exec('sh', ['-c', `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`]);
    const other = fixture(await readPid(pidFile));
    const snapshot = await snapshotProcesses();
    if (snapshot === undefined) throw new Error('census failed');
    const recycled = { pid: other.pid, start: `${other.start}-earlier` };
    expect(isAliveIn(snapshot, recycled)).toBe(false);
    expect(signalIfAlive(snapshot, recycled, 'SIGKILL')).toBe(false);
    await expect(processHasExitedAsync(other)).resolves.toBe(false);
  });

  it('reports a failed census as uncertain and signals nothing', async () => {
    const root = await directory();
    const pidFile = join(root, 'held.pid');
    const report = vi.fn(() => Promise.resolve());
    setProcessCleanupReporter(report);
    vi.mocked(snapshotProcesses).mockResolvedValue(undefined);
    try {
      const child = (await import('node:child_process')).spawn(
        'sh',
        ['-c', `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; sleep 30`],
        { detached: true, stdio: 'ignore' }
      );
      const owner = ownProcessTree(child);
      const member = await readPid(pidFile);
      const leader = child.pid ?? 0;
      started.push(
        { pid: leader, start: processIdentity(leader)?.start ?? '' },
        { pid: member, start: processIdentity(member)?.start ?? '' }
      );
      const teardown = await owner?.finish(0);
      expect(teardown?.uncertain).toBe('process census unavailable');
      expect(teardown?.signalled).toEqual([]);
      expect(processIdentity(member)).toBeDefined();
      child.unref();
    } finally {
      vi.mocked(snapshotProcesses).mockImplementation(
        (await vi.importActual<typeof import('../process-birth.js')>('../process-birth.js'))
          .snapshotProcesses
      );
    }
  });
});

describe.skipIf(process.platform === 'win32')('sampling cost', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockClear();
    vi.mocked(execFileSync).mockClear();
  });

  it('follows 500 live processes without blocking the event loop, and forgets them once dead', async () => {
    const { spawn } = await import('node:child_process');
    const leader = spawn(
      'sh',
      ['-c', 'i=0; while [ $i -lt 500 ]; do sleep 60 & i=$((i+1)); done; wait'],
      { detached: true, stdio: 'ignore' }
    );
    const pid = leader.pid ?? 0;
    const sampler = new ProcessTreeSampler(pid, {
      isLeaderRunning: () => leader.exitCode === null && leader.signalCode === null,
    });
    let maxLag = 0;
    let last = Date.now();
    const meter = setInterval(() => {
      maxLag = Math.max(maxLag, Date.now() - last - 10);
      last = Date.now();
    }, 10);
    try {
      await sampler.start();
      await vi.waitFor(
        () => {
          expect(sampler.owned().length).toBeGreaterThan(500);
        },
        { timeout: 20_000, interval: 100 }
      );
      vi.mocked(execFile).mockClear();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // One listing per tick, whatever the size of the tree.
      expect(vi.mocked(execFile).mock.calls.length).toBeLessThan(30);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
      expect(maxLag).toBeLessThan(500);
    } finally {
      clearInterval(meter);
      process.kill(-pid, 'SIGKILL');
    }
    await vi.waitFor(
      async () => {
        await sampler.sample();
        expect(sampler.owned()).toEqual([]);
      },
      { timeout: 10_000, interval: 100 }
    );
    sampler.stop();
  }, 60_000);

  it('never runs python for an identity, whatever PATH holds', async () => {
    const root = await directory();
    const marker = join(root, 'ran');
    const python = join(root, 'python3');
    await writeFile(python, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    await chmod(python, 0o755);
    await writeFile(join(root, 'ctypes.py'), `open(${JSON.stringify(marker)}, 'w').write('ran')\n`);
    const previousPath = process.env['PATH'];
    process.env['PATH'] = [root, previousPath].join(delimiter);
    try {
      const birth = processIdentity(process.pid);
      expect(birth?.pid).toBe(process.pid);
      expect(await processIdentityAsync(process.pid)).toEqual(birth);
      expect((await snapshotProcesses())?.get(process.pid)?.start).toBe(birth?.start);
    } finally {
      process.env['PATH'] = previousPath;
    }
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).not.toContain('python');
    }
  });
});

describe('births', () => {
  it.skipIf(process.platform === 'win32')('reads a birth that matches the wall clock', () => {
    const start = processIdentity(process.pid)?.start;
    if (process.platform !== 'darwin') return;
    const expected = (Date.now() - process.uptime() * 1000) / 1000;
    expect(Math.abs(Number(start) - expected)).toBeLessThan(3);
  });

  it('reads the process table from procfs on Linux, zombies excepted', async () => {
    const proc = await directory();
    const stat = (pid: number, comm: string, state: string): string =>
      `${pid} (${comm}) ${state} 1 ${pid} ${pid} ${Array.from({ length: 15 }, () => '0').join(' ')} ${pid * 10} 0 0\n`;
    await mkdir(join(proc, 'sys/kernel/random'), { recursive: true });
    await writeFile(join(proc, 'sys/kernel/random/boot_id'), 'boot\n');
    for (const [pid, comm, state] of [
      [100, 'odd ) name (x', 'S'],
      [101, 'gone', 'Z'],
    ] as const) {
      await mkdir(join(proc, String(pid)));
      await writeFile(join(proc, String(pid), 'stat'), stat(pid, comm, state));
    }
    await mkdir(join(proc, 'self'));

    const snapshot = await snapshotFromProcfs(proc);

    expect(snapshot?.get(100)).toEqual({ pid: 100, start: 'boot:1000', parent: 1, group: 100 });
    expect(snapshot?.has(101)).toBe(false);
    expect(await snapshotFromProcfs(join(proc, 'missing'))).toBeUndefined();
  });
});
