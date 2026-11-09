// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoredSnapshot } from '../../authored/types.js';
import type { CoordinatorConfig, JobRequest } from '../schema.js';
import type { SlotRecord } from '../slot-types.js';
import { validateSubmission } from '../submission.js';

const slots = new Map<string, SlotRecord>();

vi.mock('../evidence.js', () => ({ executorFingerprint: vi.fn(() => Promise.resolve('digest')) }));
vi.mock('../slots.js', () => ({
  readSlot: vi.fn((_namespace: string, name: string) => {
    const slot = slots.get(name);
    return slot === undefined
      ? Promise.reject(new Error(`no slot ${name}`))
      : Promise.resolve(slot);
  }),
}));
vi.mock('../../authored/index.js', () => ({
  authenticateAuthoredSnapshot: vi.fn((snapshot: AuthoredSnapshot) => Promise.resolve(snapshot)),
}));
vi.mock('../captured-inputs.js', () => ({
  authenticateAdapterInputs: vi.fn(() => Promise.resolve()),
}));
// A display step reaches the session probe only after the kept profile was judged.
vi.mock('../display-probe.js', () => ({
  probeSessionRefusal: vi.fn(() => Promise.resolve('past the profile check')),
}));

const PIN = 'a'.repeat(40);

describe('a kept profile at submission', () => {
  let base: string;
  let namespace: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fireforge-kept-profile-'));
    namespace = join(base, 'namespace');
    await mkdir(join(namespace, 'slots', 'a'), { recursive: true });
    await mkdir(join(namespace, 'slots', 'stale'), { recursive: true });
    await mkdir(join(base, 'slot-a'), { recursive: true });
    slots.clear();
    slots.set('a', { id: 'a', root: join(base, 'slot-a'), pin: PIN } as SlotRecord);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const submit = (profile: string | undefined): Promise<unknown> =>
    validateSubmission({
      namespace,
      config: {} as CoordinatorConfig,
      request: {
        slot: 'a',
        steps: [
          {
            command: 'run',
            args: [],
            interactive: true,
            ...(profile === undefined ? {} : { profile }),
          },
        ],
      } as unknown as JobRequest,
      snapshot: { pin: { commit: PIN } } as unknown as AuthoredSnapshot,
      executorDigest: 'digest',
    });

  it('refuses one inside a slot root, naming the slot, and skips a slot it cannot read', async () => {
    await expect(submit(join(base, 'slot-a', 'profile'))).rejects.toThrow(
      /cannot live inside slot a/
    );
  });

  it('refuses one inside the coordinator namespace', async () => {
    await expect(submit(join(namespace, 'profile'))).rejects.toThrow(
      /cannot live inside the coordinator namespace/
    );
  });

  it('takes one outside both, and a run with no kept profile, to the next check', async () => {
    await expect(submit(join(base, 'kept'))).rejects.toThrow('past the profile check');
    await expect(submit(undefined)).rejects.toThrow('past the profile check');
  });

  it('judges a kept profile on a host with no slot directory yet', async () => {
    await rm(join(namespace, 'slots'), { recursive: true });
    await expect(submit(join(namespace, 'profile'))).rejects.toThrow(
      /cannot live inside the coordinator namespace/
    );
  });
});
