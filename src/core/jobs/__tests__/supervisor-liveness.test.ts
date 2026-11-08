// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoredSnapshot } from '../../authored/types.js';
import { cancelJob, liveEndpoint, readJob, rpc, submitJob, waitForJob } from '../client.js';
import type { JobRecord, JobView } from '../schema.js';
import { quarantineSlot } from '../slot-lock.js';
import { readSlot } from '../slots.js';
import { readJournal, readJson, writeDurable } from '../store.js';
import { LocalSupervisor } from '../supervisor.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

const control = vi.hoisted(() => ({
  holdPrepare: undefined as Promise<void> | undefined,
  holdStamp: undefined as Promise<void> | undefined,
  /** A hold for one job's stamp, taking precedence over `holdStamp` for it. */
  holdStampOf: undefined as ((job: JobRecord) => Promise<void> | undefined) | undefined,
  holdSeal: undefined as Promise<void> | undefined,
  failTransition: undefined as ((job: JobRecord) => boolean) | undefined,
}));

// Slow work stubbed where it runs: everything else, the executor included, is real.
vi.mock('../slots.js', async (original) => {
  const actual = await original<typeof import('../slots.js')>();
  return {
    ...actual,
    prepareSlot: vi.fn(async (...args: Parameters<typeof actual.prepareSlot>) => {
      if (control.holdPrepare !== undefined && args[0].includes('coordinator'))
        await control.holdPrepare;
      return actual.prepareSlot(...args);
    }),
    sealSlot: vi.fn(async (...args: Parameters<typeof actual.sealSlot>) => {
      const receipt = await actual.sealSlot(...args);
      if (control.holdSeal !== undefined) await control.holdSeal;
      return receipt;
    }),
  };
});
vi.mock('../phase-report.js', async (original) => {
  const actual = await original<typeof import('../phase-report.js')>();
  return {
    ...actual,
    stampPhaseReport: vi.fn(async (...args: Parameters<typeof actual.stampPhaseReport>) => {
      const own = control.holdStampOf?.(args[1]);
      if (own !== undefined) await own;
      else if (control.holdStamp !== undefined) await control.holdStamp;
      return actual.stampPhaseReport(...args);
    }),
  };
});
vi.mock('../store.js', async (original) => {
  const actual = await original<typeof import('../store.js')>();
  return {
    ...actual,
    appendTransition: vi.fn(async (...args: Parameters<typeof actual.appendTransition>) => {
      if (control.failTransition?.(args[1]) === true)
        throw new Error('ENOSPC: no space left on device');
      return actual.appendTransition(...args);
    }),
  };
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const fixtures: JobFixture[] = [];
beforeEach(() => {
  control.holdPrepare = undefined;
  control.holdStamp = undefined;
  control.holdStampOf = undefined;
  control.holdSeal = undefined;
  control.failTransition = undefined;
});
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
async function open(slots: readonly string[] = ['a', 'b']): Promise<JobFixture> {
  const fixture = await jobFixture(slots);
  fixtures.push(fixture);
  return fixture;
}

const green = { command: 'status' as const, args: [] };

/** The target slot on another source, so a job there has real preparation to stall in. */
async function otherSource(f: JobFixture): Promise<AuthoredSnapshot> {
  const { captureAuthoredSnapshot } = await import('../../authored/index.js');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(f.root, 'src/browser/new.js'), 'export const value = 2;\n');
  return captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src'],
    pristineRepository: f.pristine,
  });
}

describe('decide versus do', () => {
  it('a stalled 15 s prepare on slot a leaves status and authorize on slot b under a second', async () => {
    const f = await open();
    const stalled = gate();
    const released = gate();
    control.holdPrepare = stalled.wait;
    control.holdStamp = released.wait;
    const other = await otherSource(f);
    const onA = await submitJob(
      f.namespace,
      { ...f.request([green], 'a'), sourceId: other.id },
      other
    );
    const onB = await submitJob(f.namespace, f.request([green], 'b'), f.snapshot);
    // A real CLI on slot b runs and exits, then the job parks with its token still live.
    await vi.waitFor(
      async () => {
        const journal = (await readJournal(f.namespace)).get(onB.id);
        const log = await readFile(join(f.namespace, 'logs', `${onB.id}.log`), 'utf8').catch(
          () => ''
        );
        expect(journal?.executionToken).toBeDefined();
        expect(log).toContain('FIREFORGE-JOB-STEP');
      },
      { timeout: 60_000, interval: 100 }
    );
    const running = (await readJournal(f.namespace)).get(onB.id);
    const endpoint = await liveEndpoint(f.namespace);
    if (endpoint === undefined || running === undefined) throw new Error('no supervisor');
    expect((await readJob(f.namespace, onA.id)).state).toBe('running');
    for (let round = 0; round < 5; round += 1) {
      const started = performance.now();
      const status = (await rpc(endpoint, { operation: 'status', jobId: onB.id })) as JobView;
      const authorized = (await rpc(endpoint, {
        operation: 'authorize',
        jobId: onB.id,
        token: running.executionToken ?? '',
        command: 'status',
        phase: running.phase?.nonce ?? '',
      })) as { slot: string };
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(status.id).toBe(onB.id);
      expect(authorized.slot).toBe('b');
    }
    released.open();
    expect((await waitForJob(f.namespace, onB.id, 60_000)).state).toBe('passed');
    expect((await readJob(f.namespace, onA.id)).state).toBe('running');
    stalled.open();
    expect((await waitForJob(f.namespace, onA.id, 60_000)).state).toBe('passed');
  }, 180_000);

  it('a client that retries a timed-out submit with the same key gets the one job', async () => {
    const f = await open(['a']);
    const request = f.request([green]);
    const [first, second] = await Promise.all([
      submitJob(f.namespace, request, f.snapshot),
      submitJob(f.namespace, request, f.snapshot),
    ]);
    expect(first.id).toBe(second.id);
    expect((await readJournal(f.namespace)).size).toBe(1);
    await waitForJob(f.namespace, first.id, 60_000);
  }, 90_000);

  it('reruns a red under a derived key, but still attaches to a live or passed job', async () => {
    const f = await open(['a']);
    const key = `auto-${'c'.repeat(40)}`;
    const red = { command: 'status' as const, args: ['--raw', '--fail-on', 'x'] };
    const request = { ...f.request([red]), key };
    const first = await submitJob(f.namespace, request, f.snapshot);
    expect((await submitJob(f.namespace, request, f.snapshot)).id).toBe(first.id);
    expect((await waitForJob(f.namespace, first.id, 60_000)).state).toBe('failed');
    const second = await submitJob(f.namespace, request, f.snapshot);
    expect(second.id).not.toBe(first.id);
    await waitForJob(f.namespace, second.id, 60_000);
  }, 150_000);

  it('reads survive a stalled seal, and a cancel during it wins: no receipt, no passed', async () => {
    const f = await open(['a']);
    const stalled = gate();
    control.holdSeal = stalled.wait;
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    await vi.waitFor(
      async () => {
        expect((await readJob(f.namespace, job.id)).state).toBe('sealing');
      },
      { timeout: 60_000, interval: 100 }
    );
    const receipt = join(f.namespace, 'receipts', `${job.id}.json`);
    await vi.waitFor(
      async () => {
        await readFile(receipt);
      },
      { timeout: 60_000, interval: 100 }
    );
    const cancelled = await cancelJob(f.namespace, job.id);
    expect(cancelled.state).not.toBe('passed');
    stalled.open();
    const outcome = await waitForJob(f.namespace, job.id, 30_000);
    expect(outcome.state).toBe('cancelled');
    expect(outcome.receipt).toBeUndefined();
    await expect(readFile(receipt)).rejects.toThrow(/ENOENT/);
    expect((await readJournal(f.namespace)).get(job.id)?.state).toBe('cancelled');
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
  }, 120_000);
});

describe('an unattended supervisor', () => {
  it('assigns a free slot to a job naming none, and records what ran in its receipt', async () => {
    const f = await open();
    await quarantineSlot(f.namespace, 'a', 'kept out of the pool');
    const request = f.request([green]);
    delete request.slot;
    const job = await submitJob(f.namespace, request, f.snapshot);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state, outcome.reason).toBe('passed');
    expect(outcome.slot).toBe('b');
    expect(outcome.receipt?.steps[0]?.args).toEqual([]);
  }, 90_000);

  it('gives two jobs in the same environment the same environment digest', async () => {
    const f = await open();
    const [first, second] = await Promise.all([
      submitJob(f.namespace, f.request([green], 'a'), f.snapshot),
      submitJob(f.namespace, f.request([green], 'b'), f.snapshot),
    ]);
    const [one, two] = await Promise.all([
      waitForJob(f.namespace, first.id, 60_000),
      waitForJob(f.namespace, second.id, 60_000),
    ]);
    expect(one.receipt?.environmentDigest).toBeDefined();
    expect(one.receipt?.environmentDigest).toBe(two.receipt?.environmentDigest);
  }, 120_000);

  it('stops serving a namespace that was deleted, rather than stranding itself', async () => {
    const f = await open(['a']);
    const endpoint = await liveEndpoint(f.namespace);
    if (endpoint === undefined) throw new Error('no supervisor');
    await rm(f.namespace, { recursive: true, force: true });
    await vi.waitFor(
      async () => {
        await expect(rpc(endpoint, { operation: 'list' })).rejects.toThrow();
      },
      { timeout: 10_000, interval: 100 }
    );
  }, 30_000);

  it('retires when idle however often it is polled', async () => {
    const f = await open(['a']);
    await f.supervisor.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    await writeDurable(join(f.namespace, 'config.json'), {
      ...(await readJson<object>(join(f.namespace, 'config.json'))),
      idleMs: 300,
    });
    const supervisor = await LocalSupervisor.start(f.namespace);
    try {
      const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
      await waitForJob(f.namespace, job.id, 60_000);
      await vi.waitFor(
        async () => {
          await readJob(f.namespace, job.id);
          await expect(readFile(join(f.namespace, 'endpoint.json'))).rejects.toThrow(/ENOENT/);
        },
        { timeout: 15_000, interval: 50 }
      );
    } finally {
      await supervisor.close().catch(() => undefined);
      await f.close();
    }
  }, 120_000);
});

describe('guarded background work', () => {
  it('a journal failure at a phase end leaves the supervisor alive and other jobs running', async () => {
    const f = await open();
    const release = gate();
    // The other job's phase ends only after the doomed job's failure is recorded,
    // so what this asserts does not depend on which phase end the host runs first.
    const later = gate();
    control.holdStamp = release.wait;
    const doomed = await submitJob(f.namespace, f.request([green], 'a'), f.snapshot);
    const other = await submitJob(f.namespace, f.request([green], 'b'), f.snapshot);
    control.holdStampOf = (job) => (job.id === other.id ? later.wait : undefined);
    await vi.waitFor(
      async () => {
        for (const id of [doomed.id, other.id])
          expect((await readJournal(f.namespace)).get(id)?.executionToken).toBeDefined();
      },
      { timeout: 60_000, interval: 100 }
    );
    // Only the doomed job's writes fail, from its phase end on: a full disk seen by one writer.
    control.failTransition = (job) => job.id === doomed.id;
    release.open();
    await vi.waitFor(
      async () => {
        expect((await readJob(f.namespace, doomed.id)).state).toBe('failed');
      },
      { timeout: 60_000, interval: 100 }
    );
    const ended = await readJob(f.namespace, doomed.id);
    expect(ended.reason).toMatch(/ENOSPC/);
    expect(ended.receipt).toBeUndefined();
    later.open();
    // Admission waits on an unwritable journal, and says so; nothing else stopped.
    await vi.waitFor(
      async () => {
        const waiting = await readJob(f.namespace, other.id);
        expect(waiting.blockedBy).toMatch(/journal cannot be written/);
      },
      { timeout: 60_000, interval: 100 }
    );
    // The row reaches the journal once the disk recovers, and admission resumes.
    control.failTransition = undefined;
    const passed = await waitForJob(f.namespace, other.id, 60_000);
    expect(passed.state, passed.reason).toBe('passed');
    await vi.waitFor(
      async () => {
        expect((await readJournal(f.namespace)).get(doomed.id)?.state).toBe('failed');
      },
      { timeout: 10_000, interval: 100 }
    );
    const next = await submitJob(f.namespace, f.request([green], 'a'), f.snapshot);
    expect((await waitForJob(f.namespace, next.id, 60_000)).state).toBe('passed');
  }, 240_000);

  it('never claims passed when the row that would say so cannot be written', async () => {
    const f = await open(['a']);
    control.failTransition = (job) => job.state === 'passed';
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toMatch(/ENOSPC/);
    expect(outcome.receipt).toBeUndefined();
    await expect(readFile(join(f.namespace, 'receipts', `${job.id}.json`))).rejects.toThrow(
      /ENOENT/
    );
    control.failTransition = undefined;
  }, 90_000);

  it('a step past its deadline is cancelled and says why', async () => {
    const f = await open(['a']);
    const hold = gate();
    control.holdStamp = hold.wait;
    // Admitted with a deadline already in the past, enforced by the next heartbeat.
    const job = await submitJob(
      f.namespace,
      f.request([{ ...green, deadlineSeconds: 1 }]),
      f.snapshot
    );
    const outcome = await vi.waitFor(
      async () => {
        const view = await readJob(f.namespace, job.id);
        expect(view.cancellationRequested).toBe(true);
        return view;
      },
      { timeout: 60_000, interval: 100 }
    );
    expect(outcome.reason).toMatch(/exceeded its deadline/);
    hold.open();
    expect((await waitForJob(f.namespace, job.id, 60_000)).state).toBe('cancelled');
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
  }, 120_000);

  it('a CLI reporting an uncertain teardown costs nothing once the final census is clean', async () => {
    const f = await open(['a']);
    const hold = gate();
    control.holdStamp = hold.wait;
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const running = await vi.waitFor(
      async () => {
        const record = (await readJournal(f.namespace)).get(job.id);
        expect(record?.executionToken).toBeDefined();
        return record;
      },
      { timeout: 60_000, interval: 100 }
    );
    const endpoint = await liveEndpoint(f.namespace);
    if (endpoint === undefined || running === undefined) throw new Error('no supervisor');
    // The journal row is on disk a moment before the supervisor answers from it.
    await vi.waitFor(
      () =>
        rpc(endpoint, {
          operation: 'cleanup-uncertain',
          jobId: job.id,
          token: running.executionToken ?? '',
          command: 'status',
          phase: running.phase?.nonce ?? '',
          reason: 'census timed out under load',
        }),
      { timeout: 10_000, interval: 50 }
    );
    hold.open();
    expect((await waitForJob(f.namespace, job.id, 60_000)).state).toBe('passed');
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    await expect(readFile(join(f.namespace, 'host-quarantine.json'))).rejects.toThrow(/ENOENT/);
  }, 90_000);

  it('a socket directory never depends on the caller’s TMPDIR', async () => {
    const f = await open(['a']);
    const endpoint = await readJson<{ socket: string }>(join(f.namespace, 'endpoint.json'));
    const tmpdir = process.env['TMPDIR'];
    if (tmpdir !== undefined && !f.namespace.startsWith(tmpdir))
      expect(endpoint.socket.startsWith(tmpdir)).toBe(false);
    expect(endpoint.socket.startsWith(f.namespace) || endpoint.socket.startsWith('/tmp/')).toBe(
      true
    );
  }, 30_000);
});
