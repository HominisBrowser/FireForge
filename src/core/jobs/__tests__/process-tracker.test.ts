// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ProcessBirth,
  processHasExitedAsync,
  processIdentity,
  sameProcess,
} from '../../../utils/process-birth.js';
import { finishOwnedProcesses, OwnedProcessTracker } from '../process-tracker.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
const fixtures: ProcessBirth[] = [];

async function slot(): Promise<{ directory: string; root: string; ledger: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ff-tracker-'));
  directories.push(directory);
  const root = join(directory, 'slot');
  await mkdir(join(root, 'engine'), { recursive: true });
  return { directory, root, ledger: join(directory, 'owned.json') };
}

function node(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}

async function birthOf(child: ChildProcess): Promise<ProcessBirth> {
  const birth = await vi.waitFor(() => {
    const identity = processIdentity(child.pid ?? 0);
    if (identity === undefined) throw new Error('not running yet');
    return identity;
  });
  fixtures.push(birth);
  return birth;
}

const LINGER = 'setTimeout(()=>{},30000)';

afterEach(async () => {
  for (const identity of fixtures.splice(0)) {
    if (sameProcess(identity)) process.kill(identity.pid, 'SIGKILL');
  }
  children.splice(0);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('OwnedProcessTracker', () => {
  it('records descendants durably, and terminates only what the run can claim', async () => {
    const { directory, root, ledger } = await slot();
    const anchoredFile = join(directory, 'anchored.pid');
    const daemonFile = join(directory, 'daemon.pid');
    const leader = node([
      '-e',
      `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const start = (arg, file) => {
        const c = spawn(process.execPath, ['-e', ${JSON.stringify(LINGER)}, arg], { detached: true, stdio: 'ignore' });
        c.unref();
        writeFileSync(file, String(c.pid));
      };
      start(${JSON.stringify(join(root, 'engine', 'tool'))}, ${JSON.stringify(anchoredFile)});
      start('not-anchored', ${JSON.stringify(daemonFile)});
      setInterval(() => {}, 1000);
    `,
    ]);
    const identity = await birthOf(leader);
    const tracker = new OwnedProcessTracker(ledger, identity, root);
    await tracker.start();
    const pidOf = (file: string): Promise<number> =>
      vi.waitFor(async () => {
        const pid = Number(await readFile(file, 'utf8'));
        if (!(pid > 0)) throw new Error('no pid yet');
        return pid;
      });
    const anchored = await pidOf(anchoredFile);
    const daemon = await pidOf(daemonFile);
    fixtures.push(
      { pid: daemon, start: processIdentity(daemon)?.start ?? '' },
      { pid: anchored, start: processIdentity(anchored)?.start ?? '' }
    );
    await vi.waitFor(
      async () => {
        const entries = JSON.parse(await readFile(ledger, 'utf8')) as {
          identity: ProcessBirth;
        }[];
        expect(entries.map((entry) => entry.identity.pid)).toEqual(
          expect.arrayContaining([identity.pid, anchored, daemon])
        );
      },
      { timeout: 5_000, interval: 50 }
    );

    leader.kill('SIGKILL');
    await once(leader, 'exit');
    const cleanup = await tracker.finish();

    expect(processIdentity(anchored)).toBeUndefined();
    expect(processIdentity(daemon)).toBeDefined();
    expect(cleanup.detached?.map((entry) => entry.pid)).toContain(daemon);
    expect(cleanup.clean).toBe(true);
  });

  it('does not veto a process that merely mentions the slot and a browser name', async () => {
    const { root, ledger } = await slot();
    const leader = node(['-e', LINGER]);
    const identity = await birthOf(leader);
    // What `rg firefox <slot>/engine` looks like during a phase's end.
    const bystander = node(['-e', LINGER, 'firefox', join(root, 'engine')]);
    await birthOf(bystander);
    await writeFile(`${ledger}.scope.json`, JSON.stringify({ phase: 'this-phase' }));
    await writeFile(ledger, JSON.stringify([{ identity, group: identity.pid }]));

    const cleanup = await finishOwnedProcesses(ledger, root, identity.pid);

    expect(cleanup.unknown).toEqual([]);
    expect(cleanup.clean).toBe(true);
    await expect(processHasExitedAsync(identity)).resolves.toBe(false);
  });

  it('vetoes a process carrying the phase marker, and never signals it', async () => {
    const { root, ledger } = await slot();
    const leader = node(['-e', LINGER]);
    const identity = await birthOf(leader);
    const marked = node(['-e', LINGER], { FIREFORGE_JOB_PHASE: 'this-phase' });
    const markedBirth = await birthOf(marked);
    await writeFile(`${ledger}.scope.json`, JSON.stringify({ phase: 'this-phase' }));
    await writeFile(ledger, JSON.stringify([{ identity, group: identity.pid }]));

    const cleanup = await vi.waitFor(async () => {
      const result = await finishOwnedProcesses(ledger, root, identity.pid);
      expect(result.unknown.map((entry) => entry.pid)).toContain(markedBirth.pid);
      return result;
    });

    expect(cleanup.clean).toBe(false);
    await expect(processHasExitedAsync(markedBirth)).resolves.toBe(false);
  });

  it('reports a marked daemon with no foothold in the slot, and vetoes one holding the slot open', async () => {
    const { directory, root, ledger } = await slot();
    const leader = node(['-e', LINGER]);
    const identity = await birthOf(leader);
    const elsewhere = node(['-e', LINGER], { FIREFORGE_JOB_PHASE: 'daemon-phase' });
    const elsewhereBirth = await birthOf(elsewhere);
    const entry = (birth: ProcessBirth): { identity: ProcessBirth; group: number } => ({
      identity: birth,
      group: birth.pid,
    });
    await writeFile(`${ledger}.scope.json`, JSON.stringify({ phase: 'daemon-phase' }));
    await writeFile(ledger, JSON.stringify([entry(identity), entry(elsewhereBirth)]));

    const clean = await finishOwnedProcesses(ledger, root, identity.pid);

    expect(clean.clean).toBe(true);
    expect(clean.detached?.map((row) => row.pid)).toContain(elsewhereBirth.pid);
    await expect(processHasExitedAsync(elsewhereBirth)).resolves.toBe(false);

    const inSlot = spawn(process.execPath, ['-e', LINGER], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FIREFORGE_JOB_PHASE: 'daemon-phase' },
    });
    children.push(inSlot);
    const inSlotBirth = await birthOf(inSlot);
    await writeFile(ledger, JSON.stringify([entry(identity), entry(inSlotBirth)]));

    const vetoed = await finishOwnedProcesses(ledger, root, identity.pid);

    expect(vetoed.clean).toBe(false);
    expect(vetoed.unknown.map((row) => row.pid)).toContain(inSlotBirth.pid);
    await expect(processHasExitedAsync(inSlotBirth)).resolves.toBe(false);
    expect(directory).toBeTruthy();
  });

  it('leaves a ledger entry whose birth no longer matches', async () => {
    const { root, ledger } = await slot();
    const other = node(['-e', LINGER]);
    const otherBirth = await birthOf(other);
    await writeFile(
      ledger,
      JSON.stringify([
        { identity: { pid: 1, start: 'absent' }, group: 1 },
        { identity: { pid: otherBirth.pid, start: 'a-different-birth' }, group: otherBirth.pid },
      ])
    );

    const cleanup = await finishOwnedProcesses(ledger, root, 0);

    expect(cleanup.clean).toBe(true);
    await expect(processHasExitedAsync(otherBirth)).resolves.toBe(false);
  });
});
