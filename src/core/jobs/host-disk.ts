// SPDX-License-Identifier: EUPL-1.2
/** Free disk space under a step, and what a red step should say about it. */
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { DEFAULT_DISK_LOW_GIB, type JobRecord, type StepDiskLow } from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { readJson } from './store.js';
import { walkTree } from './tool-files.js';

const GIB = 1024 ** 3;

/** The share of a volume that is always too little to leave free. */
const LOW_SHARE = 0.03;

/** A volume's bytes free to a user process, and its size. */
export interface VolumeSpace {
  freeBytes: number;
  totalBytes: number;
}

/** Reads a path's volume. Injectable so a test need not fill a disk. */
export type ReadSpace = (path: string) => Promise<VolumeSpace>;

export const readVolumeSpace: ReadSpace = async (path) => {
  const info = await statfs(path);
  return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
};

/**
 * Free bytes below which a volume is low: the configured GiB or 3% of the
 * volume, whichever is larger.
 */
export function diskLowThreshold(totalBytes: number, configuredGib?: number): number {
  return Math.max((configuredGib ?? DEFAULT_DISK_LOW_GIB) * GIB, Math.ceil(totalBytes * LOW_SHARE));
}

/** The volumes a step works on: the namespace's, and the slot's when it is another one. */
export interface WatchedVolumes {
  namespace: string;
  slot?: string;
}

/**
 * The paths to sample: the namespace, and the slot only when it lives on
 * another device, so one volume is never reported twice.
 */
async function watchedTargets(
  volumes: WatchedVolumes
): Promise<Array<['namespace' | 'slot', string]>> {
  const targets: Array<['namespace' | 'slot', string]> = [['namespace', volumes.namespace]];
  if (volumes.slot === undefined) return targets;
  const device = (path: string): Promise<number | undefined> =>
    stat(path).then(
      (info) => info.dev,
      () => undefined
    );
  const [namespaceDevice, slotDevice] = await Promise.all([
    device(volumes.namespace),
    device(volumes.slot),
  ]);
  if (namespaceDevice === undefined || namespaceDevice !== slotDevice)
    targets.push(['slot', volumes.slot]);
  return targets;
}

/**
 * Samples free space on the namespace's volume and the slot's, at once, every
 * `tickMs` and when stopped, as the load watch does. Only a sample below the
 * threshold counts; the lowest of those is kept. The timer never keeps the
 * process alive, and a volume that cannot be read is skipped.
 *
 * @returns Stops watching, and gives the lowest low reading, or undefined when none was low
 */
export function watchHostDisk(
  volumes: WatchedVolumes,
  options: {
    tickMs: number;
    gib?: number;
    now?: () => number;
    read?: ReadSpace;
  }
): () => Promise<StepDiskLow | undefined> {
  const now = options.now ?? Date.now;
  const read = options.read ?? readVolumeSpace;
  const started = now();
  let lowest: StepDiskLow | undefined;
  const targets = watchedTargets(volumes);
  const sample = async (): Promise<void> => {
    const at = now();
    for (const [volume, path] of await targets) {
      let space: VolumeSpace;
      try {
        space = await read(path);
      } catch {
        continue;
      }
      if (space.freeBytes >= diskLowThreshold(space.totalBytes, options.gib)) continue;
      if (lowest === undefined || space.freeBytes < lowest.freeBytes)
        lowest = {
          freeBytes: space.freeBytes,
          atSeconds: Math.max(0, Math.round((at - started) / 1000)),
          volume,
        };
    }
  };
  let pending = sample();
  const timer = setInterval(() => {
    pending = pending.then(sample);
  }, options.tickMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    pending = pending.then(sample);
    await pending;
    return lowest;
  };
}

/** The one-decimal GiB figure a reason and a verdict show. */
export const gibText = (bytes: number): string => (Math.floor((bytes / GIB) * 10) / 10).toFixed(1);

/** What the coordinator's own directories hold, as far as is cheap to know. */
export interface DiskUsage {
  /** Sum of what each slot's build has been measured to occupy. */
  slotBytes: number;
  slots: number;
  /** What job artifacts occupy. */
  artifactBytes: number;
}

/** Bytes a directory occupies on disk; a missing one occupies none. */
export async function physicalBytes(directory: string): Promise<number> {
  let bytes = 0;
  try {
    await walkTree(directory, ({ info }) => {
      bytes += info.blocks * 512;
    });
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  return bytes;
}

/**
 * Slots by the size their builds were measured at, which their metadata holds, so
 * no tree is walked; artifacts by walking, which holds a few files per job.
 */
export async function diskUsage(namespace: string): Promise<DiskUsage> {
  let slotBytes = 0;
  let slots = 0;
  for (const name of await readdir(join(namespace, 'slots')).catch(() => [] as string[])) {
    const slot = await readJson<Partial<SlotRecord>>(
      join(namespace, 'slots', name, 'slot.json')
    ).catch(() => undefined);
    if (slot === undefined) continue;
    slots += 1;
    slotBytes += slot.storage?.consumedBytes ?? 0;
  }
  return { slotBytes, slots, artifactBytes: await physicalBytes(join(namespace, 'artifacts')) };
}

/** The sentence a red step's reason gains when its disk ran low. */
export function diskLowSentence(low: StepDiskLow, usage?: DiskUsage): string {
  const where = low.volume === 'slot' ? "the slot's volume" : "the coordinator's volume";
  const held =
    usage === undefined
      ? ''
      : `; the coordinator holds ${gibText(usage.slotBytes)} GiB in ${String(usage.slots)} slot${usage.slots === 1 ? '' : 's'} and ${gibText(usage.artifactBytes)} GiB in job artifacts (fireforge host prune frees artifacts)`;
  return `Free disk fell to ${gibText(low.freeBytes)} GiB on ${where} ${String(low.atSeconds)}s in, so this red may come from disk pressure rather than the step${held}`;
}

/** A red, interrupted or cancelled verdict gains the disk sentence; nothing else about it changes. */
export function annotateDiskLow<T extends { state: JobRecord['state']; reason?: string }>(
  verdict: T,
  low: StepDiskLow | undefined,
  usage?: DiskUsage
): T {
  if (low === undefined || !['failed', 'interrupted', 'cancelled'].includes(verdict.state))
    return verdict;
  return {
    ...verdict,
    reason:
      verdict.reason === undefined
        ? diskLowSentence(low, usage)
        : `${verdict.reason}. ${diskLowSentence(low, usage)}`,
  };
}
