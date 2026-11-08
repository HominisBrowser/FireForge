// SPDX-License-Identifier: EUPL-1.2
/** A daemon a phase left with no foothold in the slot: the phase stands, and nobody is left unaware. */
import { afterAll, describe, expect, it, vi } from 'vitest';

import { jobVerdict } from '../../../commands/job-support.js';
import { submitJob, waitForJob } from '../client.js';
import { readSlot } from '../slots.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

vi.mock('../phase-settlement.js', async (original) => {
  const actual = await original<typeof import('../phase-settlement.js')>();
  return {
    ...actual,
    settleProcesses: vi.fn(async (...args: Parameters<typeof actual.settleProcesses>) => ({
      ...(await actual.settleProcesses(...args)),
      detached: [{ pid: 4242, group: 4242 }],
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
    expect(jobVerdict(job)).toContain('detached=4242');
    expect((await readSlot(f.namespace, 'a')).requiresAudit).toBe(true);
  }, 120_000);
});
