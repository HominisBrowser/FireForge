// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertReleaseRoom, checkStorageCapacity, GIB, reserveSlotStorage } from '../storage.js';
import { writeDurable } from '../store.js';

const free = vi.hoisted(() => ({ bytes: 100 * 1024 ** 3 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: () => Promise.resolve({ bavail: Math.floor(free.bytes / 4096), bsize: 4096 }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  free.bytes = 100 * GIB;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-capacity-'));
  directories.push(root);
  return root;
}
const REAL_SOURCE = Math.round(5.6 * GIB);
const REAL_OBJDIR = 27 * GIB;

describe('slot reservations', () => {
  it('three clones of a real tree fit on this disk: only object directories can still grow', async () => {
    const root = await fixture();
    for (const name of ['a', 'b', 'c']) {
      const storage = await reserveSlotStorage(root, { sourceBytes: REAL_SOURCE, cow: true });
      expect(storage.reservedBytes).toBe(REAL_SOURCE * 5);
      await checkStorageCapacity(root, storage);
      await writeDurable(join(root, 'slots', name, 'slot.json'), { storage });
    }
  });

  it('what a built slot measured replaces the estimate, and what it occupies stops counting', async () => {
    const root = await fixture();
    await writeDurable(join(root, 'slots', 'a', 'slot.json'), {
      storage: {
        reservedBytes: REAL_OBJDIR,
        memoryBytes: GIB,
        floorBytes: 8 * GIB,
        consumedBytes: REAL_OBJDIR,
      },
    });
    const next = await reserveSlotStorage(root, { sourceBytes: REAL_SOURCE, cow: true });
    expect(next.reservedBytes).toBe(REAL_OBJDIR);
    free.bytes = 40 * GIB;
    await checkStorageCapacity(root, next);
    free.bytes = 30 * GIB;
    await expect(checkStorageCapacity(root, next)).rejects.toThrow(/Disk floor: 5 GiB/);
  });

  it('a release build needs room for a second object directory, less what the slot already holds', async () => {
    const root = await fixture();
    const storage = {
      reservedBytes: REAL_OBJDIR,
      memoryBytes: GIB,
      floorBytes: 8 * GIB,
      consumedBytes: REAL_OBJDIR,
    };
    await writeDurable(join(root, 'slots', 'a', 'slot.json'), { storage });
    free.bytes = 30 * GIB;
    await expect(assertReleaseRoom(root, storage)).rejects.toThrow(
      /Disk floor: 5 GiB more headroom required for a release/
    );
    await expect(
      assertReleaseRoom(root, { ...storage, releaseBytes: REAL_OBJDIR })
    ).resolves.toBeUndefined();
    free.bytes = 35 * GIB;
    await expect(assertReleaseRoom(root, storage)).resolves.toBeUndefined();
    free.bytes = 7 * GIB;
    await expect(
      assertReleaseRoom(root, { ...storage, releaseBytes: REAL_OBJDIR })
    ).rejects.toThrow(/Disk floor/);
  });

  it('a measured divergence overrides downward as well as up', async () => {
    const root = await fixture();
    free.bytes = 20 * GIB;
    const measured = await reserveSlotStorage(root, {
      sourceBytes: REAL_SOURCE,
      cow: true,
      expectedDivergenceBytes: 2 * GIB,
    });
    expect(measured.reservedBytes).toBe(2 * GIB);
    await checkStorageCapacity(root, measured);
    const clone = await reserveSlotStorage(root, {
      sourceBytes: REAL_SOURCE,
      cow: true,
      measuredBytes: 3 * GIB,
    });
    expect(clone.reservedBytes).toBe(3 * GIB);
  });

  it('without copy-on-write the source occupies real space too', async () => {
    const root = await fixture();
    const physical = await reserveSlotStorage(root, { sourceBytes: REAL_SOURCE, cow: false });
    expect(physical.reservedBytes).toBe(REAL_SOURCE * 6);
  });

  it('refuses a fourth slot by default and a working set over the memory budget', async () => {
    const root = await fixture();
    const storage = { reservedBytes: 150, memoryBytes: 1, floorBytes: GIB };
    for (const name of ['a', 'b', 'c'])
      await writeDurable(join(root, 'slots', name, 'slot.json'), { storage });
    await expect(checkStorageCapacity(root, storage)).rejects.toThrow(/Slot count/);
    await rm(join(root, 'slots'), { recursive: true });
    await expect(
      checkStorageCapacity(root, { ...storage, reservedBytes: Number.MAX_SAFE_INTEGER })
    ).rejects.toThrow(/Disk floor/);
    await expect(
      checkStorageCapacity(root, { ...storage, memoryBytes: Number.MAX_SAFE_INTEGER })
    ).rejects.toThrow(/memory budget/);
  });
});
