// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutorMismatchError } from '../../../errors/job.js';
import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import {
  cancelJob,
  initializeCoordinator,
  listJobs,
  readJob,
  submitJob,
  waitForJob,
} from '../client.js';
import * as evidence from '../evidence.js';
import * as fingerprint from '../executor-fingerprint.js';
import type { Endpoint } from '../protocol.js';
import type { JobRecord, JobRequest } from '../schema.js';
import { appendTransition, readJournal, readJson, writeDurable } from '../store.js';
import { LocalSupervisor } from '../supervisor.js';

const SUPERVISOR_DIGEST = 'a'.repeat(64);

describe('a client whose FireForge differs from the running supervisor', () => {
  let root: string;
  let namespace: string;
  let snapshot: AuthoredSnapshot;
  let request: JobRequest;
  let recorded: JobRecord;
  let server: LocalSupervisor | undefined;
  let clientDigest: string;

  beforeEach(async () => {
    const fixture = await sourceFixture();
    root = dirname(fixture.root);
    namespace = join(root, 'coordinator');
    snapshot = await captureAuthoredSnapshot({
      projectRoot: fixture.root,
      intendedPaths: ['src'],
      pristineRepository: fixture.pristine,
    });
    await initializeCoordinator(namespace, { idleMs: 60_000 });
    request = {
      schemaVersion: 1,
      key: randomUUID(),
      sourceId: snapshot.id,
      slot: 'a',
      steps: [{ command: 'status', args: [] }],
      quiet: false,
    };
    recorded = {
      schemaVersion: 1,
      id: randomUUID(),
      owner: 'fixture',
      request,
      state: 'cancelled',
      epoch: 1,
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cancellationRequested: true,
    };
    await appendTransition(namespace, recorded);
    clientDigest = SUPERVISOR_DIGEST;
    // The supervisor reads its digest through evidence, the client directly.
    vi.spyOn(evidence, 'executorFingerprint').mockResolvedValue(SUPERVISOR_DIGEST);
    vi.spyOn(fingerprint, 'executorFingerprint').mockImplementation(() =>
      Promise.resolve(clientDigest)
    );
    server = await LocalSupervisor.start(namespace);
  });

  afterEach(async () => {
    await server?.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes its executor digest and package in the endpoint', async () => {
    const endpoint = await readJson<Endpoint>(join(namespace, 'endpoint.json'));
    expect(endpoint.executorDigest).toBe(SUPERVISOR_DIGEST);
    expect(endpoint.packageRoot).toMatch(/\S/);
    expect(endpoint.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('passes a client on the same FireForge', async () => {
    expect((await submitJob(namespace, request, snapshot)).id).toBe(recorded.id);
  });

  it('refuses before submitting, naming the supervisor package and the remedy', async () => {
    const path = join(namespace, 'endpoint.json');
    await writeDurable(path, {
      ...(await readJson<Endpoint>(path)),
      packageRoot: '/peer/worktree/node_modules/fireforge',
      version: '0.55.0+gpeer',
    });
    clientDigest = 'b'.repeat(64);
    const refusal = await submitJob(namespace, { ...request, key: randomUUID() }, snapshot).catch(
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(ExecutorMismatchError);
    const message = (refusal as Error).message;
    expect(message).toContain('/peer/worktree/node_modules/fireforge');
    expect(message).toContain('0.55.0+gpeer');
    expect(message).toMatch(/npm ci/);
    expect(message).toMatch(/goes idle|go idle/);
    expect((await readJournal(namespace)).size).toBe(1);
  });

  it('refuses a supervisor that does not publish its executor', async () => {
    const path = join(namespace, 'endpoint.json');
    const { schemaVersion, socket, epoch, owner } = await readJson<Endpoint>(path);
    await writeDurable(path, { schemaVersion, socket, epoch, owner });
    await expect(submitJob(namespace, request, snapshot)).rejects.toThrow(
      /does not record which FireForge/
    );
  });

  it('keeps reads, waits and cancellation working across the mismatch', async () => {
    clientDigest = 'b'.repeat(64);
    expect((await readJob(namespace, recorded.id)).state).toBe('cancelled');
    expect((await listJobs(namespace)).map((job) => job.id)).toEqual([recorded.id]);
    expect((await waitForJob(namespace, recorded.id, 1_000)).state).toBe('cancelled');
    expect((await cancelJob(namespace, recorded.id)).state).toBe('cancelled');
  });
});
