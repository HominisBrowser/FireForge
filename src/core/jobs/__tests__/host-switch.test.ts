// SPDX-License-Identifier: EUPL-1.2
/** A host with a pinned build: which clients it takes, and how it switches builds under queued work. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutorMismatchError } from '../../../errors/job.js';
import * as logger from '../../../utils/logger.js';
import { measureCurrentIdentity } from '../../proof/identity.js';
import { initializeCoordinator, readJob, submitJob } from '../client.js';
import * as evidence from '../evidence.js';
import * as fingerprint from '../executor-fingerprint.js';
import { pinRuntime, readPinnedRuntime } from '../pinned-runtime.js';
import type { Endpoint } from '../protocol.js';
import { readJournal, readJson, writeDurable } from '../store.js';
import { LocalSupervisor } from '../supervisor.js';
import { FIXTURE_MEMORY_GIB, FIXTURE_QUIET_LOAD } from './host-fixture.js';
import { type JobFixture, jobFixture } from './job-fixture.js';
import { fakePackage } from './pinned-fixture.js';

const SUPERVISOR = 'a'.repeat(64);
const CLIENT = 'b'.repeat(64);
const PINNED = 'c'.repeat(64);

async function eventually<T>(read: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('a host that pins another build than the running supervisor', () => {
  let f: JobFixture;
  let marker: string;
  let restarted: LocalSupervisor | undefined;

  beforeEach(async () => {
    vi.spyOn(evidence, 'executorFingerprint').mockResolvedValue(SUPERVISOR);
    vi.spyOn(fingerprint, 'executorFingerprint').mockResolvedValue(CLIENT);
    f = await jobFixture();
    marker = join(dirname(f.root), 'pinned-supervisor-started');
    const from = await fakePackage(join(dirname(f.root), 'pinned'), {
      executor: PINNED,
      marker,
    });
    await pinRuntime(f.namespace, {
      from,
      runtime: { node: process.execPath, environment: {} },
    });
  });

  afterEach(async () => {
    await restarted?.close().catch(() => undefined);
    restarted = undefined;
    await f.close();
    vi.restoreAllMocks();
  });

  it('takes a client of another build, holds its job for the pinned build, and hands over when idle', async () => {
    const notice = vi.spyOn(logger, 'notice').mockImplementation(() => undefined);
    // A supervisor that goes idle quickly once only held jobs remain.
    await f.supervisor.close();
    await initializeCoordinator(f.namespace, {
      idleMs: 300,
      quietLoad: FIXTURE_QUIET_LOAD,
      memory: FIXTURE_MEMORY_GIB,
    });
    restarted = await LocalSupervisor.start(f.namespace);
    const job = await submitJob(
      f.namespace,
      f.request([{ command: 'status', args: [] }]),
      f.snapshot
    );
    expect(job.state).toBe('queued');
    expect(notice).toHaveBeenCalledOnce();
    expect(notice.mock.calls[0]?.[0]).toMatch(
      /jobs run on the host's pinned FireForge 9\.9\.9\+gabc1234/
    );
    expect((await readJournal(f.namespace)).get(job.id)?.executorToolsDigest).toBe(PINNED);
    const blocked = await eventually(async () => (await readJob(f.namespace, job.id)).blockedBy);
    expect(blocked).toMatch(/Waiting for the host to switch to FireForge 9\.9\.9\+gabc1234/);
    // Idle with only a held job, it closes and starts the pinned build itself.
    expect(await eventually(() => readFile(marker, 'utf8'))).toBe(f.namespace);
    expect((await readJob(f.namespace, job.id)).state).toBe('queued');
  });

  it('measures evidence against the pinned build, not this client', async () => {
    const identity = await measureCurrentIdentity(f.namespace, f.snapshot.id, true, false);
    expect(identity.executor).toBe(PINNED);
  });

  it('refuses a client that speaks another protocol, naming both builds and the remedy', async () => {
    const record = await readPinnedRuntime(f.namespace);
    if (record === undefined) throw new Error('no pinned record');
    await writeDurable(join(f.namespace, 'runtime', 'current.json'), {
      ...record,
      current: { ...record.current, protocol: 99 },
    });
    const refusal = await submitJob(
      f.namespace,
      f.request([{ command: 'status', args: [] }]),
      f.snapshot
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutorMismatchError);
    expect((refusal as Error).message).toMatch(
      /pinned FireForge 9\.9\.9\+gabc1234 \(protocol 99\).*protocol 1\).*fireforge host upgrade/
    );
    expect((await readJournal(f.namespace)).size).toBe(0);
  });

  it('refuses while a supervisor that records no protocol still runs, saying the host switches when it idles', async () => {
    const path = join(f.namespace, 'endpoint.json');
    const endpoint = await readJson<Endpoint>(path);
    delete endpoint.protocol;
    await writeDurable(path, endpoint);
    await expect(
      submitJob(f.namespace, f.request([{ command: 'status', args: [] }]), f.snapshot)
    ).rejects.toThrow(
      /an unrecorded protocol.*switches to its pinned FireForge 9\.9\.9\+gabc1234 when that supervisor next goes idle/
    );
  });
});
