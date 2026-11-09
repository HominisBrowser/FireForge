// SPDX-License-Identifier: EUPL-1.2
/** A supervisor is a real detached process, so nothing but its own logic ends it. */
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { ensureSupervisor, initializeCoordinator, readJob, submitJob } from '../client.js';
import { processHasExitedAsync } from '../process.js';
import type { ProcessIdentity } from '../schema.js';
import { createSlot } from '../slot-lifecycle.js';
import { type HostFixture, hostFixture, removeHostFixture } from './host-fixture.js';

// Real processes and real clones, beside whatever else the suite is running.
vi.setConfig({ testTimeout: 180_000 });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Whether the fixture's long step is still running, by the one command line only it has. */
const sleeping = (): boolean =>
  execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' })
    .split('\n')
    .some((line) => line.startsWith('sleep 3117'));

const gone = (owner: ProcessIdentity): Promise<void> =>
  vi.waitFor(
    async () => {
      expect(await processHasExitedAsync(owner)).toBe(true);
    },
    { timeout: 45_000, interval: 200 }
  );

describe('a supervisor exits by itself', () => {
  it('when idle, publishing nothing behind it', async () => {
    const f = await sourceFixture();
    const directory = dirname(f.root);
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const namespace = join(directory, 'coordinator');
    await initializeCoordinator(namespace, { idleMs: 200 });
    const { owner } = await ensureSupervisor(namespace);
    await gone(owner);
  }, 60_000);

  it('when its namespace is deleted, however long its idle time', async () => {
    const f = await sourceFixture();
    const directory = dirname(f.root);
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const namespace = join(directory, 'coordinator');
    await initializeCoordinator(namespace, { idleMs: 3_600_000 });
    const { owner } = await ensureSupervisor(namespace);
    await rm(namespace, { recursive: true, force: true });
    await gone(owner);
  }, 60_000);

  it('when its namespace is emptied around a job still queued', async () => {
    const f = await sourceFixture();
    const directory = dirname(f.root);
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const namespace = join(directory, 'coordinator');
    await initializeCoordinator(namespace, { idleMs: 3_600_000 });
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      pristineRepository: f.pristine,
    });
    await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
    const { owner } = await ensureSupervisor(namespace);
    // Held off the slot by a lock nothing releases, so the job can never finish on its own.
    const { acquireSlot } = await import('../slots.js');
    await acquireSlot(namespace, 'a', { jobId: 'held' });
    await submitJob(
      namespace,
      {
        schemaVersion: 1,
        key: 'stuck',
        slot: 'a',
        sourceId: snapshot.id,
        steps: [{ command: 'status', args: [] }],
        quiet: false,
      },
      snapshot
    );
    // The supervisor is still writing in there, which is what a test's own cleanup meets.
    await rm(namespace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await gone(owner);
  }, 90_000);

  it('when its namespace is deleted around a running job, stopping what it started', async () => {
    const f: HostFixture = await hostFixture({
      check: {
        skip: ['status', 'verify', 'lint', 'typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [
          {
            name: 'slow',
            command: 'sleep 3117',
            footprint: { static: true },
          },
        ],
      },
    });
    cleanups.push(() => removeHostFixture(f));
    const init = await f.cli(f.project, ['host', 'init']);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    await initializeCoordinator(f.namespace, { idleMs: 3_600_000 });
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.project,
      pristineRepository: f.pristine,
    });
    const { owner } = await ensureSupervisor(f.namespace);
    const job = await submitJob(
      f.namespace,
      {
        schemaVersion: 1,
        key: 'slow',
        sourceId: snapshot.id,
        steps: [{ command: 'check', args: [] }],
        quiet: false,
      },
      snapshot
    );
    await vi.waitFor(
      async () => {
        expect((await readJob(f.namespace, job.id)).state).toBe('running');
      },
      { timeout: 60_000, interval: 200 }
    );
    await vi.waitFor(
      () => {
        expect(sleeping()).toBe(true);
      },
      { timeout: 60_000, interval: 200 }
    );
    await rm(f.namespace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await gone(owner);
    expect(sleeping()).toBe(false);
  }, 180_000);
});
