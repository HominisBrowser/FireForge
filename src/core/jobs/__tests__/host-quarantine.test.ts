// SPDX-License-Identifier: EUPL-1.2
/** What holds a group on this host, against real processes and real files. */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearHostQuarantine,
  holdHostGroup,
  observeHost,
  quarantineHostUnknown,
} from '../host-quarantine.js';
import { processIdentityAsync } from '../process.js';
import type { ProcessIdentity } from '../schema.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

async function namespace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fireforge-host-quarantine-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A detached group leader that belongs to nobody here. */
async function bystander(
  env: NodeJS.ProcessEnv = {}
): Promise<{ child: ChildProcess; identity: ProcessIdentity }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  await once(child, 'spawn');
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    process.kill(-(child.pid ?? 0), 'SIGKILL');
    await once(child, 'exit');
  });
  const identity = await processIdentityAsync(child.pid ?? 0);
  if (identity === undefined) throw new Error('No identity');
  return { child, identity };
}

const onDisk = async (path: string): Promise<{ unknown?: string; groups: unknown[] }> =>
  JSON.parse(await readFile(join(path, 'host-quarantine.json'), 'utf8')) as {
    unknown?: string;
    groups: unknown[];
  };

describe.skipIf(process.platform === 'win32')('host quarantine', () => {
  it('loses no update when writers overlap', async () => {
    const path = await namespace();
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        holdHostGroup(path, { group: 2 ** 22 + index, job: `j${String(index)}`, members: [] })
      )
    );
    expect((await onDisk(path)).groups).toHaveLength(6);
    await Promise.all([
      quarantineHostUnknown(path, 'nobody can name this executor'),
      holdHostGroup(path, { group: 2 ** 22 + 50, job: 'x', members: [] }),
    ]);
    const after = await onDisk(path);
    expect(after.unknown).toBe('nobody can name this executor');
    expect(after.groups).toHaveLength(7);
  });

  it('keeps a hold written while a census of the earlier ones is running', async () => {
    const path = await namespace();
    // Gone at once, so this observation rewrites the file with that group forgotten.
    await holdHostGroup(path, { group: 2 ** 22 + 1, job: 'gone', members: [] });
    const { identity } = await bystander();
    const [observed] = await Promise.all([
      observeHost(path),
      holdHostGroup(path, { group: identity.pid, job: 'late' }),
    ]);
    expect(observed.groups.map((entry) => entry.job)).not.toContain('gone');
    const { groups } = await observeHost(path);
    expect(groups.map((entry) => entry.job)).toEqual(['late']);
  });

  it('holds a group by the births in it, and forgets a number something unrelated now has', async () => {
    const path = await namespace();
    const ours = await bystander();
    await holdHostGroup(path, {
      group: ours.identity.pid,
      job: 'ours',
      phase: 'our-marker',
      resources: { cpu: 2, memory: 1, build: 1, browser: 0, display: 0 },
    });
    const observed = await observeHost(path);
    expect(observed.groups.map((entry) => entry.job)).toEqual(['ours']);
    expect(observed.held.build).toBe(1);

    const unrelated = await bystander({ FIREFORGE_JOB_PHASE: 'someone-elses-marker' });
    await holdHostGroup(path, {
      group: unrelated.identity.pid,
      job: 'reused-number',
      phase: 'the-phase-that-ended',
      members: [{ pid: unrelated.identity.pid, start: 'an earlier birth' }],
    });
    const { groups, held } = await observeHost(path);
    expect(groups.map((entry) => entry.job)).toEqual(['ours']);
    expect(held.build).toBe(1);
    expect(unrelated.child.exitCode).toBeNull();
  });

  it('a member carrying the phase marker keeps a hold whose births have all gone', async () => {
    const path = await namespace();
    const survivor = await bystander({ FIREFORGE_JOB_PHASE: 'the-phase' });
    await holdHostGroup(path, {
      group: survivor.identity.pid,
      job: 'marked',
      phase: 'the-phase',
      members: [{ pid: survivor.identity.pid, start: 'not the birth it has now' }],
    });
    expect((await observeHost(path)).groups.map((entry) => entry.job)).toEqual(['marked']);
  });

  it('refuses a clear by name while a group runs, and clears it when told the number moved on', async () => {
    const path = await namespace();
    const live = await bystander();
    await holdHostGroup(path, { group: live.identity.pid, job: 'stuck' });
    await expect(clearHostQuarantine(path)).rejects.toThrow(
      new RegExp(`${String(live.identity.pid)} \\(job stuck\\).*--forget-group`)
    );
    const cleared = await clearHostQuarantine(path, [live.identity.pid]);
    expect(cleared.cleared).toEqual([`process group ${String(live.identity.pid)} (job stuck)`]);
    expect((await observeHost(path)).groups).toEqual([]);
    expect(live.child.exitCode).toBeNull();
  });
});
