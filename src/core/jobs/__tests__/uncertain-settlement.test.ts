// SPDX-License-Identifier: EUPL-1.2
/**
 * A phase whose processes cannot be established as gone, when what records that
 * cannot be written either: the realistic shape of a full disk. Real processes, a
 * real supervisor and real file-system refusals.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { cancelJob, readJob, submitJob, waitForJob } from '../client.js';
import { groupHasLiveMembers } from '../process.js';
import { restoreSlot } from '../slot-lifecycle.js';
import { acquireSlot, readSlot, SlotBusyError } from '../slots.js';
import { readJournal, slotDirectory } from '../store.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

vi.mock('../process.js', async (original) => {
  const actual = await original<typeof import('../process.js')>();
  return { ...actual, groupHasLiveMembers: vi.fn(actual.groupHasLiveMembers) };
});

const fixtures: JobFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
}, 120_000);
async function open(): Promise<JobFixture> {
  const fixture = await jobFixture(['a']);
  fixtures.push(fixture);
  return fixture;
}

const green = { command: 'status' as const, args: [] };

/** Submits a job and, once it has a process, leaves a survivor in its phase. */
async function withSurvivor(
  f: JobFixture
): Promise<{ job: string; stop: () => Promise<void>; alive: () => boolean }> {
  const { id } = await submitJob(f.namespace, f.request([green]), f.snapshot);
  const running = await vi.waitFor(
    async () => {
      const record = (await readJournal(f.namespace)).get(id);
      if (record?.process === undefined) throw new Error('not launched yet');
      return record;
    },
    { timeout: 60_000, interval: 20 }
  );
  const survivor = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FIREFORGE_JOB_PHASE: running.phase?.nonce ?? '' },
  });
  await once(survivor, 'spawn');
  return {
    job: id,
    alive: () => survivor.exitCode === null && survivor.signalCode === null,
    stop: async () => {
      process.kill(-(survivor.pid ?? 0), 'SIGKILL');
      await once(survivor, 'exit');
    },
  };
}

describe.concurrent('a phase that ends uncertain', () => {
  it('a hold that cannot be written: never a clean red, and the slot never runs beside the survivor', async () => {
    const f = await open();
    const { job, stop, alive } = await withSurvivor(f);
    // Stands in for ENOSPC on the one write that records the survivor.
    const state = join(f.namespace, 'host-quarantine.json');
    await mkdir(state);
    const waiting: { id?: string } = {};
    try {
      const outcome = await waitForJob(f.namespace, job, 60_000);
      expect(outcome.state).toBe('failed');
      expect(outcome.reason).toMatch(/cleanup uncertain/);
      expect(outcome.reason).not.toMatch(/Supervisor task failed/);
      expect(alive()).toBe(true);
      // The slot itself could be written, so that much is on disk already.
      expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/cleanup uncertain/);
      await expect(acquireSlot(f.namespace, 'a')).rejects.toBeInstanceOf(SlotBusyError);

      const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
      waiting.id = next.id;
      const held = await waitForJob(f.namespace, next.id, 2_500);
      expect(held.state).toBe('queued');
      expect(held.blockedBy).toBeDefined();

      // The write lands by itself once it can, and only then does anything change hands.
      await rm(state, { recursive: true });
      await vi.waitFor(
        async () => {
          const release = await acquireSlot(f.namespace, 'a');
          await release();
        },
        { timeout: 15_000, interval: 200 }
      );
      await vi.waitFor(
        async () => {
          const queued = await readJob(f.namespace, next.id);
          expect(queued.state).toBe('queued');
          expect(queued.blockedBy).toMatch(/quarantined.*slot restore a/);
        },
        { timeout: 15_000, interval: 200 }
      );
      await expect(restoreSlot(f.namespace, 'a')).rejects.toThrow(/still runs/);
    } finally {
      await stop();
    }
    await vi.waitFor(() => expect(restoreSlot(f.namespace, 'a')).resolves.toBeDefined(), {
      timeout: 15_000,
      interval: 300,
    });
    // Restored, the waiting job finally runs, on a slot with nothing left beside it.
    expect((await waitForJob(f.namespace, waiting.id ?? '', 60_000)).state).toBe('passed');
  }, 240_000);

  it('a slot that cannot be marked: the lock stays, and the job’s row waits for the mark', async () => {
    const f = await open();
    const { job, stop } = await withSurvivor(f);
    const directory = slotDirectory(f.namespace, 'a');
    await chmod(directory, 0o500);
    const waiting: { id?: string } = {};
    try {
      const outcome = await waitForJob(f.namespace, job, 60_000);
      expect(outcome.state).toBe('failed');
      expect(outcome.reason).toMatch(/cleanup uncertain/);
      // A crash now must read as a running job, which recovery quarantines.
      expect((await readJournal(f.namespace)).get(job)?.state).toBe('running');
      expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();

      const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
      waiting.id = next.id;
      const held = await waitForJob(f.namespace, next.id, 2_500);
      expect(held.state).toBe('queued');
      expect(held.blockedBy).toMatch(/could not be written/);
      // Its claim is still the newest, and has not been let go of.
      const claims = (await readdir(directory)).filter((name) => name.startsWith('exclusive.'));
      expect(claims.some((name) => name.endsWith('.free'))).toBe(false);
    } finally {
      await chmod(directory, 0o700);
    }
    await vi.waitFor(
      async () => {
        expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/cleanup uncertain/);
        expect((await readJournal(f.namespace)).get(job)?.state).toBe('failed');
      },
      { timeout: 15_000, interval: 200 }
    );
    await cancelJob(f.namespace, waiting.id ?? '');
    await stop();
  }, 240_000);
});

// Alone in its describe: the mock's next answer has to reach this job's census.
describe('a phase whose census throws', () => {
  it('a census that throws at the end of a phase is uncertainty, and quarantines', async () => {
    const f = await open();
    vi.mocked(groupHasLiveMembers).mockRejectedValueOnce(new Error('census fell over'));
    const { id } = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const outcome = await waitForJob(f.namespace, id, 60_000);
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toMatch(/census fell over/);
    expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/census fell over/);
  }, 120_000);
});
