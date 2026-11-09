// SPDX-License-Identifier: EUPL-1.2
import { readdir, statfs } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { sourceGit } from '../authored/git.js';
import { type CoordinatorConfig, DEFAULT_MAX_SLOTS } from './schema.js';
import type { StorageReservation } from './slot-types.js';
import { readJson } from './store.js';
import { walkTree } from './tool-files.js';

export const GIB = 1024 ** 3;
export type { StorageReservation } from './slot-types.js';

/** What a slot can still grow by. What it already occupies is gone from free space. */
const unconsumed = (item: StorageReservation): number =>
  Math.max(0, item.reservedBytes - (item.consumedBytes ?? 0));

/**
 * Provisioning needs room for every slot's remaining growth on top of the floor,
 * and every slot's working set within the memory jobs may use together.
 */
function assertCapacity(values: {
  availableBytes: number;
  reservations: StorageReservation[];
  memoryBudgetBytes: number;
  maxSlots: number;
}): void {
  if (values.reservations.length > values.maxSlots)
    throw new Error(
      `Slot count exceeds the configured limit of ${values.maxSlots}; raise it with: fireforge host init --max-slots <n>`
    );
  const floor = Math.max(0, ...values.reservations.map((item) => item.floorBytes));
  const disk = values.reservations.reduce((sum, item) => sum + unconsumed(item), 0);
  const memory = values.reservations.reduce((sum, item) => sum + item.memoryBytes, 0);
  if (values.availableBytes < floor + disk)
    throw new Error(
      `Disk floor: ${Math.ceil((floor + disk - values.availableBytes) / GIB)} GiB more headroom required for full slot divergence`
    );
  if (memory > values.memoryBudgetBytes)
    throw new Error('Planned slot working sets exceed the host memory budget');
}

async function slotReservations(namespace: string): Promise<StorageReservation[]> {
  const reservations: StorageReservation[] = [];
  try {
    for (const entry of await readdir(join(namespace, 'slots'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const slot = await readJson<{ storage?: StorageReservation }>(
          join(namespace, 'slots', entry.name, 'slot.json')
        );
        if (slot.storage) reservations.push(slot.storage);
      } catch (error) {
        if (getNodeErrorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  return reservations;
}

async function availableBytes(namespace: string): Promise<number> {
  const fs = await statfs(namespace);
  return fs.bavail * fs.bsize;
}

/** Check provisioning a new slot against disk, memory and the slot limit. */
export async function checkStorageCapacity(
  namespace: string,
  additional?: StorageReservation
): Promise<void> {
  const reservations = await slotReservations(namespace);
  if (additional) reservations.push(additional);
  let config: Partial<CoordinatorConfig> = {};
  try {
    config = await readJson<Partial<CoordinatorConfig>>(join(namespace, 'config.json'));
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  // The memory `host init` recorded, or stated with --memory: by default 80% of physical memory.
  const memoryGib = config.capacity?.memory;
  assertCapacity({
    availableBytes: await availableBytes(namespace),
    reservations,
    memoryBudgetBytes: memoryGib === undefined ? totalmem() * 0.8 : memoryGib * GIB,
    maxSlots: config.maxSlots ?? DEFAULT_MAX_SLOTS,
  });
}

/**
 * Why no phase may start for lack of disk, if so. Only the floor applies at
 * admission: a slot's reservation is checked once, when it is provisioned, and
 * a job waits here instead of failing.
 */
export async function diskBlock(namespace: string): Promise<string | undefined> {
  const reservations = await slotReservations(namespace);
  const floor = Math.max(0, ...reservations.map((item) => item.floorBytes));
  const available = await availableBytes(namespace);
  return available < floor
    ? `Waiting for disk: ${Math.floor(available / GIB)} GiB free, ${Math.ceil(floor / GIB)} GiB floor`
    : undefined;
}

/**
 * Refuses a release build with no room for it. A release has its own object
 * directory, as large as a development one, which no reservation holds until a
 * slot has built one: what the slot already holds of it does not count again.
 */
export async function assertReleaseRoom(
  namespace: string,
  storage: StorageReservation | undefined
): Promise<void> {
  if (storage === undefined) return;
  const built = (await slotReservations(namespace)).map((item) => item.consumedBytes ?? 0);
  const objdir = Math.max(storage.reservedBytes, ...built);
  const needed = storage.floorBytes + Math.max(0, objdir - (storage.releaseBytes ?? 0));
  const available = await availableBytes(namespace);
  if (available < needed)
    throw new Error(
      `Disk floor: ${Math.ceil((needed - available) / GIB)} GiB more headroom required for a release build's object directory`
    );
}

/** A cold provisioning estimate uses committed blob sizes, not arbitrary donor working-tree files. */
export async function treeLogicalBytes(repository: string, tree: string): Promise<number> {
  const entries = (
    await sourceGit(repository, ['ls-tree', '-r', '-l', '--full-tree', tree])
  ).toString();
  return entries.split('\n').reduce((sum, row) => {
    const match = /^\d+ blob [a-f0-9]+\s+(\d+)\t/.exec(row);
    return sum + (match?.[1] ? Number(match[1]) : 0);
  }, 0);
}

/** What an object directory comes to, against the source size, until a real build measures it. */
const OBJDIR_PER_SOURCE_BYTE = 5;

/**
 * The room a new slot can still come to need. Clones share everything they copy,
 * so what remains is its object directory diverging entirely: what the largest
 * built slot measured, or an estimate from the source until one exists. A
 * physical copy occupies its source as well. An operator's measurement replaces
 * the estimate in either direction.
 */
export async function reserveSlotStorage(
  namespace: string,
  options: {
    sourceBytes: number;
    cow: boolean;
    measuredBytes?: number;
    expectedDivergenceBytes?: number;
    expectedMemoryBytes?: number;
    diskFloorBytes?: number;
  }
): Promise<StorageReservation> {
  const built = (await slotReservations(namespace)).map((item) => item.consumedBytes ?? 0);
  const objdir =
    options.expectedDivergenceBytes ??
    options.measuredBytes ??
    (Math.max(0, ...built) || options.sourceBytes * OBJDIR_PER_SOURCE_BYTE);
  const storage: StorageReservation = {
    reservedBytes: Math.ceil(objdir + (options.cow ? 0 : options.sourceBytes)),
    memoryBytes: options.expectedMemoryBytes ?? 4 * GIB,
    floorBytes: Math.max(GIB, options.diskFloorBytes ?? 8 * GIB),
  };
  if (
    ![storage.reservedBytes, storage.memoryBytes, storage.floorBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  )
    throw new Error('Invalid slot storage/memory reservation');
  return storage;
}

/** Bytes a tree occupies on disk, for recording how far an object directory has grown. */
export async function directoryPhysicalBytes(directory: string): Promise<number> {
  let bytes = 0;
  await walkTree(directory, ({ info }) => {
    bytes += info.blocks * 512;
  });
  return bytes;
}
