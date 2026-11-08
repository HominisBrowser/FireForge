// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import {
  clearHostQuarantine,
  holdHostGroup,
  observeHost,
  quarantineHostUnknown,
} from '../host-quarantine.js';
import {
  groupHasLiveMembers,
  isSameProcess,
  processIdentityAsync,
  signalOwnedProcess,
} from '../process.js';
import {
  finishOwnedProcesses,
  phaseMarkedProcesses,
  readProcessLedger,
} from '../process-tracker.js';
import { recoverJobJournal } from '../recovery.js';
import type { JobRecord } from '../schema.js';
import { createSlot } from '../slot-lifecycle.js';
import { readSlot } from '../slots.js';
import { appendTransition, damagedJournalPath, readJson } from '../store.js';

vi.mock('../process.js', async (original) => ({
  ...(await original<typeof import('../process.js')>()),
  groupHasLiveMembers: vi.fn(() => Promise.resolve(false)),
  isSameProcess: vi.fn(() => Promise.resolve(false)),
  signalOwnedProcess: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../process-tracker.js', () => ({
  finishOwnedProcesses: vi.fn(() => Promise.resolve({ clean: true, unknown: [] })),
  phaseMarkedProcesses: vi.fn(() => Promise.resolve([])),
  readProcessLedger: vi.fn(() => Promise.resolve([])),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(isSameProcess).mockResolvedValue(false);
  vi.mocked(groupHasLiveMembers).mockResolvedValue(false);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ff-owner-fixture-'));
  directories.push(path);
  return path;
}

/** Whether anything host-wide is outstanding. */
async function hostQuarantined(root: string): Promise<boolean> {
  const observation = await observeHost(root);
  return observation.blocked !== undefined || observation.groups.length > 0;
}

describe('host admission quarantine', () => {
  const resources = { cpu: 2, memory: 4, build: 0, browser: 1, display: 0 };
  it('holds a surviving group’s resources, not the host, and forgets it once it is gone', async () => {
    const root = await directory();
    expect(await hostQuarantined(root)).toBe(false);
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await holdHostGroup(root, { group: child.pid ?? 0, job: 'one', slot: 'a', resources });
    await holdHostGroup(root, { group: child.pid ?? 0, job: 'duplicate' });
    const held = await observeHost(root);
    expect(held.blocked).toBeUndefined();
    expect(held.held).toMatchObject({ cpu: 2, memory: 4, browser: 1 });
    expect(held.groups).toHaveLength(1);
    await expect(clearHostQuarantine(root)).rejects.toThrow(/still run/);
    process.kill(-(child.pid ?? 0), 'SIGKILL');
    await exited;
    await vi.waitFor(async () => {
      expect((await observeHost(root)).groups).toEqual([]);
    });
    expect(await hostQuarantined(root)).toBe(false);
  });
  it('blocks the host for an unscoped reason until an explicit clear', async () => {
    const root = await directory();
    await quarantineHostUnknown(root, 'unidentifiable helper');
    await quarantineHostUnknown(root, 'a later reason');
    const observed = await observeHost(root);
    expect(observed.blocked).toMatch(/unidentifiable helper.*host-clear/);
    expect(await hostQuarantined(root)).toBe(true);
    expect(await clearHostQuarantine(root)).toEqual({ cleared: ['unidentifiable helper'] });
    expect(await hostQuarantined(root)).toBe(false);
  });
  it('propagates corrupt census state rather than converting it to an empty host', async () => {
    const root = await directory();
    await writeFile(join(root, 'host-quarantine.json'), '{broken');
    for (const action of [
      () => hostQuarantined(root),
      () => holdHostGroup(root, { group: 1, job: 'job' }),
      () => quarantineHostUnknown(root, 'failed'),
    ])
      await expect(action()).rejects.toThrow();
  });
});
it('replays queued/terminal jobs and quarantines interrupted ownership and unknown helpers', async () => {
  const f = await sourceFixture();
  directories.push(dirname(f.root));
  const namespace = join(dirname(f.root), 'coordinator');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src'],
    pristineRepository: f.pristine,
  });
  await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
  const request = {
    schemaVersion: 1 as const,
    key: 'fixture',
    slot: 'a',
    sourceId: snapshot.id,
    steps: [{ command: 'status' as const, args: [] }],
    resources: { cpu: 1, memory: 1, build: 0, browser: 0, display: 0 },
    quiet: false,
  };
  const base: JobRecord = {
    schemaVersion: 1,
    id: 'interrupted',
    owner: 'fixture',
    request,
    state: 'running',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    phase: { index: 0, active: true, ticket: 7 },
    process: { pid: 987654, start: 'owned-fixture' },
    executionToken: 'must-disappear',
  };
  await appendTransition(namespace, { ...base, id: 'queued', state: 'queued' });
  await appendTransition(namespace, { ...base, id: 'finished', state: 'passed' });
  await appendTransition(namespace, base);
  vi.mocked(isSameProcess)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  vi.mocked(finishOwnedProcesses).mockResolvedValueOnce({
    clean: false,
    unknown: [{ pid: 12345, group: 333 }],
  });
  const result = await recoverJobJournal(namespace, 2);
  expect(result.nextTicket).toBe(8);
  expect(result.jobs.get('queued')?.state).toBe('queued');
  expect(result.jobs.get('interrupted')).toMatchObject({ state: 'interrupted', epoch: 2 });
  expect(result.jobs.get('interrupted')?.executionToken).toBeUndefined();
  expect(signalOwnedProcess).toHaveBeenCalledWith(base.process, 'SIGTERM');
  expect((await readSlot(namespace, 'a')).quarantined).toMatch(/interruption/);
  expect(
    (
      await readJson<{ groups: Array<{ group: number }> }>(join(namespace, 'host-quarantine.json'))
    ).groups.map((entry) => entry.group)
  ).toEqual([333]);
  // The census being unavailable now is settled by a later census, not by an operator.
  await appendTransition(namespace, { ...base, id: 'failed-census' });
  vi.mocked(finishOwnedProcesses).mockRejectedValueOnce(new Error('census unavailable'));
  const later = await recoverJobJournal(namespace, 3);
  expect(later.jobs.get('failed-census')?.state).toBe('interrupted');
  const state = await readJson<{ unknown?: string; groups: Array<{ group: number }> }>(
    join(namespace, 'host-quarantine.json')
  );
  expect(state.unknown).toBeUndefined();
  expect(state.groups.map((entry) => entry.group)).toContain(987654);
});
it('isolates one job’s recovery failure: a damaged slot leaves the other slot and the start intact', async () => {
  const f = await sourceFixture();
  directories.push(dirname(f.root));
  const namespace = join(dirname(f.root), 'coordinator');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src'],
    pristineRepository: f.pristine,
  });
  for (const id of ['a', 'b'])
    await createSlot({ namespace, id, snapshot, pristineRepository: f.pristine });
  await writeFile(join(namespace, 'slots', 'a', 'slot.json'), '{not json');
  const job = (id: string, slot: string): JobRecord => ({
    schemaVersion: 1,
    id,
    owner: 'fixture',
    request: {
      schemaVersion: 1,
      key: id,
      slot,
      sourceId: snapshot.id,
      steps: [{ command: 'status', args: [] }],
      quiet: false,
    },
    state: 'running',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    phase: { index: 0, active: true, ticket: 1 },
  });
  await appendTransition(namespace, job('broken', 'a'));
  await appendTransition(namespace, job('healthy', 'b'));
  const { jobs } = await recoverJobJournal(namespace, 2);
  expect(jobs.get('broken')?.state).toBe('interrupted');
  expect(jobs.get('broken')?.reason).toMatch(/recovery of slot a was incomplete/);
  expect(jobs.get('healthy')?.state).toBe('interrupted');
  expect((await readSlot(namespace, 'b')).quarantined).toMatch(/interruption/);
});

describe('a job an interrupted supervisor left behind', () => {
  /** A slot and a real process in its own group, standing for what the job left running. */
  async function left(): Promise<{
    namespace: string;
    leader: { pid: number; start: string };
    job: (id: string, nonce?: string, recycled?: boolean) => JobRecord;
    groups: () => Promise<number[]>;
    stop: () => Promise<void>;
  }> {
    const f = await sourceFixture();
    directories.push(dirname(f.root));
    const namespace = join(dirname(f.root), 'coordinator');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
    const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const pid = child.pid ?? 0;
    let identity = await processIdentityAsync(pid);
    for (let tries = 0; identity === undefined && tries < 50; tries += 1)
      identity = await processIdentityAsync(pid);
    if (identity === undefined) throw new Error('fixture process has no identity');
    const leader = identity;
    return {
      namespace,
      leader,
      job: (id, nonce, recycled = false) => ({
        schemaVersion: 1,
        id,
        owner: 'fixture',
        request: {
          schemaVersion: 1,
          key: id,
          slot: 'a',
          sourceId: snapshot.id,
          steps: [{ command: 'status', args: [] }],
          resources: { cpu: 1, memory: 1, build: 0, browser: 0, display: 0 },
          quiet: false,
        },
        state: 'running',
        epoch: 1,
        submittedAt: '',
        updatedAt: '',
        cancellationRequested: false,
        phase: {
          index: 0,
          active: true,
          ticket: 1,
          ...(nonce === undefined ? {} : { nonce }),
        },
        // A leader gone or recycled leaves its group to be known by a birth or a marker alone.
        process: recycled ? { ...leader, start: 'another-birth' } : leader,
      }),
      groups: async () =>
        (
          await readJson<{ groups: Array<{ group: number }> }>(
            join(namespace, 'host-quarantine.json')
          ).catch(() => ({ groups: [] }))
        ).groups.map((entry) => entry.group),
      stop: async () => {
        process.kill(-pid, 'SIGKILL');
        await exited;
      },
    };
  }

  it('holds a group by a recorded birth, and once however many ways it is known', async () => {
    const { namespace, leader, job, groups, stop } = await left();
    try {
      vi.mocked(readProcessLedger).mockResolvedValueOnce([{ identity: leader }] as never);
      vi.mocked(finishOwnedProcesses).mockResolvedValueOnce({
        clean: false,
        unknown: [{ group: leader.pid }, { group: 4242 }],
      } as never);
      await appendTransition(namespace, job('birth'));
      await recoverJobJournal(namespace, 2);
      expect(await groups()).toEqual([leader.pid, 4242]);
    } finally {
      await stop();
    }
  });

  it('holds a group by the marker of its phase, and only that phase', async () => {
    const { namespace, leader, job, groups, stop } = await left();
    try {
      // No marker to read and no birth to match: a number alone is nothing of this job's.
      await appendTransition(namespace, job('unmarked', undefined, true));
      await recoverJobJournal(namespace, 2);
      expect(await groups()).toEqual([]);
      // Marked by another group: still nothing of this job's.
      vi.mocked(phaseMarkedProcesses).mockResolvedValueOnce([{ group: 1 }] as never);
      await appendTransition(namespace, job('elsewhere', 'nonce', true));
      await recoverJobJournal(namespace, 3);
      expect(await groups()).toEqual([]);
      vi.mocked(phaseMarkedProcesses).mockResolvedValueOnce([{ group: leader.pid }] as never);
      await appendTransition(namespace, job('marked', 'nonce', true));
      await recoverJobJournal(namespace, 4);
      expect(await groups()).toEqual([leader.pid]);
    } finally {
      await stop();
    }
  });

  it('holds a group it cannot rule out when the marker census fails', async () => {
    const { namespace, leader, job, groups, stop } = await left();
    try {
      vi.mocked(phaseMarkedProcesses).mockRejectedValueOnce(new Error('census unavailable'));
      await appendTransition(namespace, job('uncensused', 'nonce', true));
      await recoverJobJournal(namespace, 2);
      expect(await groups()).toEqual([leader.pid]);
    } finally {
      await stop();
    }
  });

  it('keeps the row open, as a mark still to land, when a hold cannot be written', async () => {
    const { namespace, leader, job, stop } = await left();
    try {
      vi.mocked(readProcessLedger).mockResolvedValueOnce([{ identity: leader }] as never);
      await writeFile(join(namespace, 'host-quarantine.json'), '{broken');
      await appendTransition(namespace, job('unheld'));
      const { marks, jobs } = await recoverJobJournal(namespace, 2);
      expect(marks).toMatchObject([{ job: 'unheld', slot: 'a' }]);
      expect(jobs.get('unheld')?.state).toBe('interrupted');
    } finally {
      await rm(join(namespace, 'host-quarantine.json'), { force: true });
      await stop();
    }
  });

  it('still ends a job whose receipt cannot be cleared, saying its slot was not settled', async () => {
    const { namespace, job, stop } = await left();
    try {
      await mkdir(join(namespace, 'receipts', 'stuck.json'), { recursive: true });
      await appendTransition(namespace, job('stuck'));
      const { jobs } = await recoverJobJournal(namespace, 2);
      expect(jobs.get('stuck')?.reason).toMatch(/recovery of slot a was incomplete/);
    } finally {
      await stop();
    }
  });

  it('starts anyway when damaged rows cannot be moved aside, keeping them to try again', async () => {
    const { namespace, job, stop } = await left();
    try {
      await appendTransition(namespace, { ...job('queued-one'), state: 'queued' });
      await appendFile(join(namespace, 'journal.jsonl'), 'not a row\n');
      await appendTransition(namespace, { ...job('queued-two'), state: 'queued' });
      await mkdir(damagedJournalPath(namespace));
      const { damaged, jobs } = await recoverJobJournal(namespace, 2);
      expect(damaged).toBe(1);
      expect(jobs.get('queued-one')?.state).toBe('queued');
    } finally {
      await stop();
    }
  });
});
