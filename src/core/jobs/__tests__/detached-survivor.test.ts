// SPDX-License-Identifier: EUPL-1.2
/** A daemon a phase left with no foothold in the slot: the phase stands, and nobody is left unaware. */
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { jobVerdict } from '../../../commands/job-support.js';
import { cancelJob, submitJob, waitForJob } from '../client.js';
import { processIdentityAsync } from '../process.js';
import { readDetachedRecord } from '../slot-detached.js';
import { readSlot } from '../slots.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

vi.mock('../phase-settlement.js', async (original) => {
  const actual = await original<typeof import('../phase-settlement.js')>();
  return {
    ...actual,
    settleProcesses: vi.fn(async (...args: Parameters<typeof actual.settleProcesses>) => ({
      ...(await actual.settleProcesses(...args)),
      // This test's own process: alive, by its exact birth, and holding nothing in the slot.
      detached: [
        {
          pid: process.pid,
          group: process.pid,
          start: (await processIdentityAsync(process.pid))?.start,
        },
      ],
    })),
  };
});

const fixtures: JobFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
}, 60_000);

describe('a self-detached process with no foothold', () => {
  it('shows on the verdict line, and the next job on that slot audits first', async () => {
    const f = await jobFixture(['a']);
    fixtures.push(f);
    const { id } = await submitJob(
      f.namespace,
      f.request([{ command: 'status', args: [] }]),
      f.snapshot
    );
    const job = await waitForJob(f.namespace, id, 60_000);
    expect(job.state, job.reason).toBe('passed');
    expect(jobVerdict(job)).toContain(`detached=${String(process.pid)}`);
    expect((await readSlot(f.namespace, 'a')).requiresAudit).toBe(true);
    expect(await readDetachedRecord(f.namespace, 'a')).toMatchObject([
      { pid: process.pid, job: id },
    ]);
    // Still footholdless at the next admission: the slot serves, and remembers it once,
    // under the job that left it last.
    const next = await submitJob(
      f.namespace,
      f.request([{ command: 'status', args: [] }]),
      f.snapshot
    );
    const second = await waitForJob(f.namespace, next.id, 60_000);
    expect(second.state, second.reason).toBe('passed');
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    expect((await readDetachedRecord(f.namespace, 'a')).map((entry) => entry.job)).toEqual([
      next.id,
    ]);

    // Once it holds a file in the slot, the next admission quarantines the slot by name.
    const { root } = await readSlot(f.namespace, 'a');
    const held = await open(join(root, 'late.txt'), 'w');
    try {
      const third = await submitJob(
        f.namespace,
        f.request([{ command: 'status', args: [] }]),
        f.snapshot
      );
      await vi.waitFor(
        async () => {
          expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(
            new RegExp(
              `process ${String(process.pid)} \\(.+\\) left detached by job ${next.id}, now holds .*late\\.txt`
            )
          );
        },
        { timeout: 30_000, interval: 100 }
      );
      await cancelJob(f.namespace, third.id);
    } finally {
      await held.close();
    }
  }, 120_000);
});
