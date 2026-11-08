// SPDX-License-Identifier: EUPL-1.2
/** Refreshing a slot's dependency trees: what pin it reads lockfiles at, and what it holds while it does. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoredSnapshot } from '../../authored/types.js';
import { cacheTargets, installDependencyCaches } from '../dependency-caches.js';
import { assertNoSlotUsers } from '../slot-audit.js';
import { refreshSlotDependencies } from '../slot-lifecycle.js';
import { acquireSlot, readSlot } from '../slots.js';

vi.mock('../dependency-caches.js', () => ({
  CACHE_RECORD_FILE: 'dependency-caches.json',
  cacheTargets: vi.fn(),
  installDependencyCaches: vi.fn(),
}));
vi.mock('../slot-audit.js', () => ({ assertNoSlotUsers: vi.fn(), engineChanges: vi.fn() }));
vi.mock('../slots.js', () => ({
  acquireSlot: vi.fn(),
  auditSlot: vi.fn(),
  prepareSlot: vi.fn(),
  readSlot: vi.fn(),
  writeCapturedInputs: vi.fn(),
}));

const release = vi.fn();
const slot = { id: 'a', root: '/ns/slots/a/root', pin: 'old-pin', pristineRepository: '/pristine' };
const snapshot = {
  id: 'source',
  pin: { commit: 'new-pin' },
  config: {},
  inputs: [],
  files: [],
} as unknown as AuthoredSnapshot;
const caches = [{ source: '/checkout/node_modules', target: 'node_modules' }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acquireSlot).mockResolvedValue(release);
  vi.mocked(readSlot).mockResolvedValue(slot as never);
  vi.mocked(cacheTargets).mockResolvedValue(['node_modules']);
});

describe('refreshing a slot’s dependency trees', () => {
  it('serves a slot on another pin, reading what the pin states at the slot’s own pin', async () => {
    await expect(
      refreshSlotDependencies({ namespace: '/ns', id: 'a', snapshot, caches })
    ).resolves.toEqual(['node_modules']);
    expect(assertNoSlotUsers).toHaveBeenCalledWith(slot.root);
    expect(installDependencyCaches).toHaveBeenCalledWith({
      namespace: '/ns',
      slotId: 'a',
      root: slot.root,
      pristineRepository: '/pristine',
      snapshot: { ...snapshot, pin: { commit: 'old-pin' } },
      caches,
      replace: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('names both pins when a tree does not match the slot pin’s lockfile', async () => {
    vi.mocked(installDependencyCaches).mockRejectedValue(
      new Error('/engine/node_modules holds x 2, which its lockfile states as 1. Run npm ci')
    );
    await expect(
      refreshSlotDependencies({ namespace: '/ns', id: 'a', snapshot, caches })
    ).rejects.toThrow(
      'which its lockfile states as 1. Run npm ci. Slot a is on pin old-pin and this checkout on new-pin, so what the pin states is read at old-pin: name trees installed for it with --cache <target>=<path>'
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('passes the snapshot through unchanged on the slot’s own pin', async () => {
    vi.mocked(readSlot).mockResolvedValue({ ...slot, pin: 'new-pin' } as never);
    await refreshSlotDependencies({ namespace: '/ns', id: 'a', snapshot, caches });
    expect(vi.mocked(installDependencyCaches).mock.calls[0]?.[0].snapshot).toBe(snapshot);
  });
});
