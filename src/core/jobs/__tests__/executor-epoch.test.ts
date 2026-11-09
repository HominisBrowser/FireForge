// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { initializeCoordinator, liveEndpoint, rpc } from '../client.js';
import * as evidence from '../evidence.js';
import type { JobRecord, JobRequest } from '../schema.js';
import { appendTransition, readJournal } from '../store.js';
import { LocalSupervisor } from '../supervisor.js';

it('refuses newly acknowledged work after loaded executor bytes change, while preserving idempotent terminal lookup', async () => {
  const fixture = await sourceFixture();
  const namespace = join(dirname(fixture.root), 'coordinator');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: fixture.root,
    intendedPaths: ['src'],
    pristineRepository: fixture.pristine,
  });
  await initializeCoordinator(namespace, { idleMs: 60_000 });
  const request: JobRequest = {
    schemaVersion: 1,
    key: randomUUID(),
    sourceId: snapshot.id,
    slot: 'a',
    steps: [{ command: 'status', args: [] }],
    quiet: false,
  };
  const recorded: JobRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    owner: 'fixture',
    request,
    state: 'cancelled',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: true,
  };
  await appendTransition(namespace, recorded);
  let epoch = 'a'.repeat(64);
  const fingerprint = vi
    .spyOn(evidence, 'executorFingerprint')
    .mockImplementation(() => Promise.resolve(epoch));
  let server: LocalSupervisor | undefined;
  try {
    server = await LocalSupervisor.start(namespace);
    epoch = 'b'.repeat(64);
    // Straight to the socket: a client on the changed bytes refuses before it gets here.
    const endpoint = await liveEndpoint(namespace);
    if (endpoint === undefined) throw new Error('No live supervisor');
    const submit = (body: JobRequest): Promise<unknown> =>
      rpc(endpoint, { operation: 'submit', request: body, snapshot });
    expect(((await submit(request)) as { id: string }).id).toBe(recorded.id);
    await expect(submit({ ...request, key: randomUUID() })).rejects.toThrow(
      /changed after startup/
    );
    expect((await readJournal(namespace)).size).toBe(1);
  } finally {
    await server?.close();
    fingerprint.mockRestore();
    await rm(dirname(fixture.root), { recursive: true, force: true });
  }
});
