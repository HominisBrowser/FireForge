// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { initializeCoordinator } from '../client.js';
import type { JobRequest, JobStep } from '../schema.js';
import { createSlot } from '../slot-lifecycle.js';
import { LocalSupervisor } from '../supervisor.js';
import { FIXTURE_MEMORY_GIB, FIXTURE_QUIET_LOAD } from './host-fixture.js';

export interface JobFixture extends Awaited<ReturnType<typeof sourceFixture>> {
  namespace: string;
  snapshot: Awaited<ReturnType<typeof captureAuthoredSnapshot>>;
  supervisor: LocalSupervisor;
  request: (steps: JobStep[], slot?: string) => JobRequest;
  close: () => Promise<void>;
}

/** A real namespace with real slots and an in-process supervisor. */
export async function jobFixture(slots: readonly string[] = ['a']): Promise<JobFixture> {
  const value = await sourceFixture();
  const namespace = join(dirname(value.root), 'coordinator');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src'],
    pristineRepository: value.pristine,
  });
  await initializeCoordinator(namespace, {
    idleMs: 60_000,
    legacyExcluded: true,
    quietLoad: FIXTURE_QUIET_LOAD,
    memory: FIXTURE_MEMORY_GIB,
    // Steps read a steady host, not this machine's network, lid, display and operator.
    steadyHost: true,
  });
  for (const id of slots)
    await createSlot({ namespace, id, snapshot, pristineRepository: value.pristine });
  const supervisor = await LocalSupervisor.start(namespace);
  let closed = false;
  return {
    ...value,
    namespace,
    snapshot,
    supervisor,
    request: (steps, slot = slots[0]) => ({
      schemaVersion: 1,
      key: randomUUID(),
      sourceId: snapshot.id,
      steps,
      quiet: false,
      ...(slot === undefined ? {} : { slot }),
    }),
    close: async () => {
      if (!closed) {
        closed = true;
        await supervisor.close().catch(() => undefined);
      }
      // A scheduling pass already under way can still write once after the close.
      await rm(dirname(value.root), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
}
