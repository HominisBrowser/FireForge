// SPDX-License-Identifier: EUPL-1.2
/**
 * Identity against real processes: anything that decides who is alive or who
 * may be signalled has to be shown on the real process table.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { useTempDir, writeTree } from '../../testing/temp.js';
import {
  isAliveIn,
  isIdentityAlive,
  isProcessAlive,
  isProcessGroupAlive,
  listProcesses,
  ownIdentity,
  processHasExited,
  processIdentity,
  signalIfAlive,
  snapshotFromProcfs,
  snapshotProcesses,
} from './identity.js';

const children: ChildProcess[] = [];
const dir = useTempDir();

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

describe.skipIf(process.platform === 'win32')('process identity', () => {
  it('identifies this process the same way every time, and finds it in a snapshot', async () => {
    const own = await ownIdentity();
    expect(own?.pid).toBe(process.pid);
    expect(await processIdentity(process.pid)).toEqual(own);
    const snapshot = await snapshotProcesses();
    expect(snapshot?.get(process.pid)).toMatchObject({ ...own, parent: process.ppid });
    expect(own !== undefined && snapshot !== undefined && isAliveIn(snapshot, own)).toBe(true);
  });

  it('tells a live process from an exited one', async () => {
    const child = sleeper();
    const identity = await processIdentity(child.pid ?? 0);
    expect(identity).toBeDefined();
    if (identity === undefined) return;
    expect(isProcessAlive(identity.pid)).toBe(true);
    expect(isIdentityAlive(identity)).toBe(true);
    await expect(processHasExited(identity)).resolves.toBe(false);
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(isIdentityAlive(identity)).toBe(false);
    await expect(processHasExited(identity)).resolves.toBe(true);
    expect(await processIdentity(identity.pid)).toBeUndefined();
  });

  it('never takes a live pid with another birth for the recorded process', async () => {
    const child = sleeper();
    const identity = await processIdentity(child.pid ?? 0);
    if (identity === undefined) throw new Error('fixture not running');
    const recycled = { pid: identity.pid, start: `${identity.start}-earlier` };
    await expect(processHasExited(recycled)).resolves.toBe(true);
    const snapshot = await snapshotProcesses();
    if (snapshot === undefined) throw new Error('snapshot failed');
    expect(isAliveIn(snapshot, recycled)).toBe(false);
    expect(signalIfAlive(snapshot, recycled, 'SIGKILL')).toBe(false);
    await expect(processHasExited(identity)).resolves.toBe(false);
    // Without a recorded start only the pid can be judged.
    await expect(processHasExited({ pid: identity.pid })).resolves.toBe(false);
  });

  it('answers for pids that cannot exist', async () => {
    expect(await processIdentity(0)).toBeUndefined();
    expect(await processIdentity(-5)).toBeUndefined();
    expect(isProcessGroupAlive(1)).toBe(false);
    await expect(processHasExited({ pid: 2 ** 22 + 12345, start: 'x' })).resolves.toBe(true);
  });

  it('sees a process group while it has members', async () => {
    const leader = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      detached: true,
    });
    children.push(leader);
    const pgid = leader.pid ?? 0;
    expect(isProcessGroupAlive(pgid)).toBe(true);
    process.kill(-pgid, 'SIGKILL');
    await once(leader, 'exit');
    expect(isProcessGroupAlive(pgid)).toBe(false);
  });

  it('lists requested columns for chosen pids, and nothing for none', async () => {
    const child = sleeper();
    const rows = await listProcesses(['pid', 'ppid', 'command'], { pids: [child.pid ?? 0] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: child.pid, ppid: process.pid });
    expect(rows[0]?.command).toContain('setTimeout');
    expect(await listProcesses(['pid'], { pids: [] })).toEqual([]);
  });
});

describe('snapshotFromProcfs', () => {
  it('reads births, parents and groups from procfs, zombies excepted', async () => {
    await writeTree(dir(), {
      'sys/kernel/random/boot_id': 'boot-1\n',
      // comm may hold spaces and parentheses; only what follows the last ")" is split.
      '100/stat': `100 (odd) name)) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5555 0 0\n`,
      '200/stat': `200 (child) R 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 6666 0 0\n`,
      '300/stat': `300 (defunct) Z 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7777 0 0\n`,
      '400/stat': 'damaged',
      'self/stat': 'ignored',
    });
    const snapshot = await snapshotFromProcfs(dir());
    expect([...(snapshot?.values() ?? [])].sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 100, start: 'boot-1:5555', parent: 1, group: 100 },
      { pid: 200, start: 'boot-1:6666', parent: 100, group: 100 },
    ]);
  });

  it('is unknown, not empty, when procfs cannot be read', async () => {
    expect(await snapshotFromProcfs(join(dir(), 'missing'))).toBeUndefined();
  });
});
