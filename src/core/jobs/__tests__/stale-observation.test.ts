// SPDX-License-Identifier: EUPL-1.2
import { afterAll, describe, expect, it, vi } from 'vitest';

import { submitJob, waitForJob } from '../client.js';
import { quarantineHostUnknown } from '../host-quarantine.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

/** Holds the next scheduling pass after it observed the host, until released. */
const gate = vi.hoisted(() => ({
  hold: undefined as undefined | { reached: () => void; release: Promise<void> },
}));

vi.mock('../admission-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admission-context.js')>();
  return {
    ...actual,
    observeAdmission: async (...args: Parameters<typeof actual.observeAdmission>) => {
      const context = await actual.observeAdmission(...args);
      const hold = gate.hold;
      if (hold !== undefined) {
        gate.hold = undefined;
        hold.reached();
        await hold.release;
      }
      return context;
    },
  };
});

const fixtures: JobFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
}, 60_000);

describe('a scheduling pass whose observation predates a host quarantine', () => {
  it('admits nothing submitted after the quarantine was written', async () => {
    const f = await jobFixture();
    fixtures.push(f);
    let release = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      gate.hold = {
        reached: resolve,
        release: new Promise<void>((done) => {
          release = done;
        }),
      };
    });
    // The heartbeat's next pass observes a host with no quarantine, then waits here.
    await reached;
    await quarantineHostUnknown(f.namespace, 'an executor nobody can identify');
    const job = await submitJob(
      f.namespace,
      f.request([{ command: 'status', args: [] }]),
      f.snapshot
    );
    release();
    const view = await waitForJob(f.namespace, job.id, 3_000);
    expect(view.state).toBe('queued');
    expect(view.blockedBy).toMatch(/an executor nobody can identify.*host-clear/);
  }, 60_000);
});
