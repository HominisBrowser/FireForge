// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { judgeHolder, slotHolderVerdicts, stopSlotOrphans } from '../slot-orphans.js';

const row = (parent: number, command: string): { parent: number; command: string } => ({
  parent,
  command,
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('judgeHolder', () => {
  const table = new Map([
    [10, row(1, '/bin/sleep 120')],
    [20, row(21, 'node helper.js')],
    [21, row(22, 'node runner.js')],
    [22, row(1, '-zsh')],
    [30, row(31, 'node helper.js')],
    [31, row(1, '/usr/bin/node executor.js')],
    [40, row(41, 'vim file')],
    [41, row(42, '/bin/sh -c vim file')],
    [42, row(1, 'node leftover.js')],
    [50, row(1, 'node /x/supervisor-main.js')],
  ]);

  it('takes init’s child with nothing above it', () => {
    expect(judgeHolder(10, table, new Set(), 999)).toMatchObject({ orphan: true });
  });

  it('refuses anything under an interactive shell', () => {
    expect(judgeHolder(20, table, new Set(), 999)).toMatchObject({
      orphan: false,
      reason: expect.stringContaining('interactive shell (process 22, -zsh)') as string,
    });
  });

  it('refuses a running job’s process and its descendants', () => {
    expect(judgeHolder(31, table, new Set([31]), 999).orphan).toBe(false);
    expect(judgeHolder(30, table, new Set([31]), 999)).toMatchObject({
      orphan: false,
      reason: expect.stringContaining('descends from a running job (process 31)') as string,
    });
    expect(judgeHolder(30, table, new Set(), 999).orphan).toBe(true);
  });

  it('treats a one-shot `sh -c` wrapper as leftover work, not a person’s shell', () => {
    expect(judgeHolder(40, table, new Set(), 999).orphan).toBe(true);
  });

  it('never takes this command or its line', () => {
    expect(judgeHolder(10, table, new Set(), 10).orphan).toBe(false);
    expect(judgeHolder(20, table, new Set(), 21).orphan).toBe(false);
  });

  it('never takes a supervisor, or a process it cannot read', () => {
    expect(judgeHolder(50, table, new Set(), 999).orphan).toBe(false);
    expect(judgeHolder(77, table, new Set(), 999).orphan).toBe(false);
  });
});

describe('stopSlotOrphans', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((task) => task()));
  });

  async function slotRoot(): Promise<{ namespace: string; root: string }> {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'ff-orphans-')));
    cleanup.push(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'root');
    const namespace = join(base, 'ns');
    await mkdir(root);
    await mkdir(namespace);
    return { namespace, root };
  }

  /** A process with init as its parent and `directory` as its working directory. */
  async function orphanIn(directory: string, command: string): Promise<number> {
    const launcher = spawn('/bin/sh', ['-c', `(${command}) >/dev/null 2>&1 </dev/null & echo $!`], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = once(launcher, 'exit');
    const [pid] = (await once(launcher.stdout, 'data')) as [Buffer];
    await exited;
    const orphan = Number(pid.toString().trim());
    cleanup.push(() => {
      try {
        process.kill(orphan, 'SIGKILL');
      } catch {
        // Already stopped.
      }
      return Promise.resolve();
    });
    return orphan;
  }

  it('stops an orphan holding the slot and reports its command', async () => {
    const { namespace, root } = await slotRoot();
    const pid = await orphanIn(root, 'exec /bin/sleep 120');
    await expect(slotHolderVerdicts(namespace, root)).resolves.toMatchObject([
      { pid, orphan: true },
    ]);
    const stopped = await stopSlotOrphans(namespace, root, { graceMs: 3_000 });
    expect(stopped).toEqual([{ pid, command: expect.stringContaining('sleep 120') as string }]);
    expect(alive(pid)).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { namespace, root } = await slotRoot();
    const pid = await orphanIn(root, `trap '' TERM; while :; do /bin/sleep 1; done`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stopped = await stopSlotOrphans(namespace, root, { graceMs: 400, settleMs: 5_000 });
    expect(stopped.map((entry) => entry.pid)).toContain(pid);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('refuses by name, stopping nothing, while a holder is not an orphan', async () => {
    const { namespace, root } = await slotRoot();
    const orphan = await orphanIn(root, 'exec /bin/sleep 120');
    // A child of this process: this command's own line is never an orphan.
    const child = spawn('/bin/sleep', ['120'], { cwd: root, stdio: 'ignore' });
    cleanup.push(() => {
      child.kill('SIGKILL');
      return Promise.resolve();
    });
    const childPid = child.pid ?? 0;
    await expect(stopSlotOrphans(namespace, root)).rejects.toThrow(
      new RegExp(`process ${String(childPid)} .*is not one`)
    );
    expect(alive(orphan)).toBe(true);
  });

  it('finds nothing to stop when nothing holds the slot', async () => {
    const { namespace, root } = await slotRoot();
    await expect(stopSlotOrphans(namespace, root)).resolves.toEqual([]);
  });
});
