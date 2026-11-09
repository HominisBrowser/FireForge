// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode, toError } from '../../utils/errors.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { CACHE_RECORD_FILE } from './dependency-caches.js';
import type { DerivedOutput } from './derived.js';
import { nativeBuildDigest, readHostToolchain } from './native-tools.js';
import { assertNoSlotUsers, auditSlot } from './slot-audit.js';
import { invalidateBuildIdentity, quarantineSlot, SlotBusyError } from './slot-lock.js';
import {
  attachMetadata,
  clonesShareBytes,
  cloneTree,
  moveToTrash,
  removeTree,
  syncDisk,
} from './slot-template.js';
import type { BuildDerivedLedger, SlotRecord } from './slot-types.js';
import { acquireSlot, readSlot } from './slots.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

/** Where a destination slot records a replication into it, so a crash or a reader can tell. */
const MARKER = 'replication.json';

/** A replication into a slot: copying the trees, swapping them in, or waiting on the job that relocates them. */
export interface ReplicationMarker {
  from: string;
  phase: 'copying' | 'swapping' | 'relocating';
  startedAt: string;
  /** The qualification job that relocates the copied object directory. */
  job?: string;
}

/** Files in a slot's directory that describe its source and build, copied with what they describe. */
const STATE_FILES = [
  'materialization.json',
  'materialization.json.journal',
  'snapshot.json',
  'build-derived.json',
  'derived.json',
  CACHE_RECORD_FILE,
];

/**
 * A replication that never touched the destination. `retry` says whether the
 * same pair may be tried again later: a lock or a process in the way goes away,
 * a missing toolchain or a volume without copy-on-write does not.
 */
export class ReplicationDeclined extends Error {
  override readonly name = 'ReplicationDeclined';
  constructor(
    message: string,
    readonly retry = false,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** What people read while a replication runs. */
export const replicationText = (from: string, to: string): string =>
  `replicating slot ${from}'s build into ${to}`;

/** The replication recorded into a slot, if any. */
export async function readReplicationMarker(
  namespace: string,
  id: string
): Promise<ReplicationMarker | undefined> {
  try {
    return await readJson<ReplicationMarker>(join(slotDirectory(namespace, id), MARKER));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Records where a replication into a slot has got to. */
export async function writeReplicationMarker(
  namespace: string,
  id: string,
  marker: ReplicationMarker
): Promise<void> {
  await writeDurable(join(slotDirectory(namespace, id), MARKER), marker);
}

/** Ends the record of a replication into a slot. */
export async function clearReplicationMarker(namespace: string, id: string): Promise<void> {
  await rm(join(slotDirectory(namespace, id), MARKER), { force: true });
}

/** Copies a file that may not exist, removing the destination's own copy either way. */
async function replaceFile(source: string, destination: string): Promise<void> {
  await rm(destination, { force: true });
  await cp(source, destination).catch((error: unknown) => {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  });
}

/** Renumbers the copied generation-bound ledgers for the destination's own next generation. */
async function renumberLedgers(directory: string, generation: number): Promise<void> {
  const derivedPath = join(directory, 'derived.json');
  const derived = await readJson<Record<string, DerivedOutput>>(derivedPath).catch(() => undefined);
  if (derived !== undefined) {
    for (const entry of Object.values(derived)) entry.generation = generation;
    await writeDurable(derivedPath, derived);
  }
  const buildPath = join(directory, 'build-derived.json');
  const build = await readJson<BuildDerivedLedger>(buildPath).catch(() => undefined);
  if (build !== undefined) await writeDurable(buildPath, { ...build, generation });
}

/**
 * Refuses unless the destination can hold the copy: copy-on-write shares the
 * object directory's bytes, so it costs minutes and almost no disk. Without it
 * the copy is physical, which is allowed only while free disk above the floor
 * stays more than twice the source's measured object directory.
 */
async function assertRoom(namespace: string, source: SlotRecord, dest: SlotRecord): Promise<void> {
  if (await clonesShareBytes(slotDirectory(namespace, dest.id))) return;
  const objects = source.storage?.consumedBytes;
  const fs = await statfs(namespace);
  const floor = Math.max(source.storage?.floorBytes ?? 0, dest.storage?.floorBytes ?? 0);
  if (objects === undefined || fs.bavail * fs.bsize <= floor + 2 * objects)
    throw new ReplicationDeclined(
      'This volume has no copy-on-write and free disk does not comfortably exceed the object directory'
    );
}

/** Everything that has to hold before the destination is touched; anything wrong declines. */
async function assertReplicable(
  namespace: string,
  source: SlotRecord,
  dest: SlotRecord
): Promise<void> {
  if (source.quarantined !== null || dest.quarantined !== null)
    throw new ReplicationDeclined('A quarantined slot takes no part in a replication');
  if (source.pin !== dest.pin)
    throw new ReplicationDeclined(`Slot ${dest.id} is on another pin than slot ${source.id}`);
  if (source.fullBuildAnchor === undefined)
    throw new ReplicationDeclined(`Slot ${source.id} holds no full build`);
  const snapshot = await readJson<AuthoredSnapshot>(
    join(slotDirectory(namespace, source.id), 'snapshot.json')
  );
  const tools = await readHostToolchain(namespace).catch(() => undefined);
  // Only qualification can relocate the copy, and only this host's tools keep the anchor.
  if (
    tools === undefined ||
    source.fullBuildAnchor.nativeToolsDigest !== nativeBuildDigest(tools, snapshot)
  )
    throw new ReplicationDeclined(`This host's toolchain did not build slot ${source.id}`);
  try {
    await assertNoSlotUsers(source.root);
    await assertNoSlotUsers(dest.root);
  } catch (error) {
    throw new ReplicationDeclined(toError(error).message, true, { cause: error });
  }
  try {
    await auditSlot(namespace, source);
  } catch (error) {
    // The source's next job audits it again and decides; a replication only steps aside.
    throw new ReplicationDeclined(
      `Slot ${source.id} did not audit: ${toError(error).message}`,
      false,
      {
        cause: error,
      }
    );
  }
  await assertRoom(namespace, source, dest);
}

/** Clones the source's engine, its Git metadata and its captured root beside the destination. */
async function stage(source: SlotRecord, staging: string): Promise<void> {
  const root = join(staging, 'root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await cloneTree(source.pristineRepository, join(staging, 'engine.git'));
  for (const name of await readdir(source.root))
    if (name !== '.fireforge') await cloneTree(join(source.root, name), join(root, name));
  const engine = join(root, 'engine');
  for (const name of await readdir(engine))
    if (name.startsWith('obj-'))
      await rm(join(engine, name, 'tmp'), { recursive: true, force: true });
}

/** Moves the destination's trees out and the staged ones in. Returns what went to the trash. */
async function swapIn(
  namespace: string,
  source: SlotRecord,
  dest: SlotRecord,
  staging: string
): Promise<string[]> {
  const directory = slotDirectory(namespace, dest.id);
  const trashed: string[] = [];
  for (const name of await readdir(dest.root))
    if (name !== '.fireforge')
      trashed.push(await moveToTrash(namespace, join(dest.root, name), `${dest.id}-replaced`));
  trashed.push(await moveToTrash(namespace, dest.pristineRepository, `${dest.id}-replaced`));
  await rename(join(staging, 'engine.git'), dest.pristineRepository);
  for (const name of await readdir(join(staging, 'root')))
    await rename(join(staging, 'root', name), join(dest.root, name));
  await attachMetadata(dest.pristineRepository, join(dest.root, 'engine'));
  const privateRoot = join(dest.root, '.fireforge');
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  for (const name of await readdir(privateRoot))
    if (['negative-control', 'profiles'].includes(name) || name.startsWith('engine-session.lock'))
      await rm(join(privateRoot, name), { recursive: true, force: true });
  for (const name of ['state.json', 'last-build.json'])
    await replaceFile(join(source.root, '.fireforge', name), join(privateRoot, name));
  for (const name of STATE_FILES)
    await replaceFile(join(slotDirectory(namespace, source.id), name), join(directory, name));
  return trashed;
}

/** The destination's record: the source's build identity at the destination's own paths and next generation. */
function replicaRecord(source: SlotRecord, dest: SlotRecord): SlotRecord {
  const generation = Math.max(source.generation, dest.generation) + 1;
  const successful = Math.max(source.successfulBuildGeneration, dest.successfulBuildGeneration) + 1;
  const record: SlotRecord = {
    ...source,
    id: dest.id,
    root: dest.root,
    pristineRepository: dest.pristineRepository,
    quarantined: null,
    generation,
    successfulBuildGeneration: successful,
    // Its package holds the source slot's paths until a build here rewrites them.
    requiresBuild: true,
    ...(source.fullBuildAnchor === undefined
      ? {}
      : { fullBuildAnchor: { ...source.fullBuildAnchor, buildGeneration: successful } }),
  };
  delete record.storage;
  if (dest.storage !== undefined)
    record.storage = {
      ...dest.storage,
      ...(source.storage?.consumedBytes === undefined
        ? {}
        : { consumedBytes: source.storage.consumedBytes }),
    };
  delete record.trustedBuild;
  delete record.packageSignature;
  delete record.requiresAudit;
  return record;
}

/** Moves every object directory out of a slot, so the full build it now needs starts clean. */
async function dropObjdirs(namespace: string, slot: SlotRecord): Promise<string[]> {
  const engine = join(slot.root, 'engine');
  const trashed: string[] = [];
  for (const name of await readdir(engine).catch(() => [] as string[]))
    if (name.startsWith('obj-'))
      trashed.push(await moveToTrash(namespace, join(engine, name), `${slot.id}-replaced`));
  return trashed;
}

/** Deletes what a replication moved aside, once no lock waits on it. Nothing depends on it going. */
async function emptyTrash(paths: readonly string[]): Promise<void> {
  for (const path of paths) await removeTree(path).catch(() => undefined);
}

/**
 * Copies one idle slot's build into another, holding both slots' locks, so two
 * slots can serve jobs that need it. The source must be between jobs: its lock
 * is what keeps a build from running under the copy. Its source tree, Git
 * metadata, captured root, dependency trees and object directories are cloned
 * beside the destination, then swapped in; the destination keeps its own Mach
 * sites, storage reservation and private state. Its record takes the source's
 * build identity (anchor, source, recipe) at a generation past both slots', and
 * needs a build before its package is trusted. Until a qualification relocates
 * the copied object directory, the marker keeps every other job off it.
 *
 * Nothing touches the destination until the source audits and the destination
 * has room. A failure while swapping leaves it needing a full build and
 * quarantined, since its trees are then a mix. The source is never marked.
 *
 * @throws {ReplicationDeclined} When nothing was touched
 */
export async function replicateSlotBuild(
  namespace: string,
  from: string,
  to: string
): Promise<void> {
  const releaseFrom = await claim(namespace, from);
  let trashed: string[];
  try {
    const releaseTo = await claim(namespace, to);
    try {
      trashed = await replicateLocked(namespace, await readSlot(namespace, from), to);
    } finally {
      await releaseTo();
    }
  } finally {
    await releaseFrom();
  }
  await emptyTrash(trashed);
}

/** A slot's lock, or a decline that says whether it may be tried again. */
async function claim(namespace: string, id: string): Promise<() => Promise<void>> {
  try {
    return await acquireSlot(namespace, id);
  } catch (error) {
    throw new ReplicationDeclined(toError(error).message, error instanceof SlotBusyError, {
      cause: error,
    });
  }
}

async function replicateLocked(
  namespace: string,
  source: SlotRecord,
  to: string
): Promise<string[]> {
  const dest = await readSlot(namespace, to);
  await assertReplicable(namespace, source, dest);
  const startedAt = new Date().toISOString();
  await writeReplicationMarker(namespace, to, { from: source.id, phase: 'copying', startedAt });
  const staging = join(slotDirectory(namespace, to), `replica-${randomUUID()}`);
  try {
    await stage(source, staging);
  } catch (error) {
    await removeTree(staging).catch(() => undefined);
    await clearReplicationMarker(namespace, to);
    throw new ReplicationDeclined(
      `Copying slot ${source.id} failed: ${toError(error).message}`,
      false,
      {
        cause: error,
      }
    );
  }
  await writeReplicationMarker(namespace, to, { from: source.id, phase: 'swapping', startedAt });
  // Durable before anything moves: whatever happens next, this slot no longer claims its old build.
  await invalidateBuildIdentity(namespace, dest, true);
  try {
    const trashed = await swapIn(namespace, source, dest, staging);
    const record = replicaRecord(source, dest);
    await renumberLedgers(slotDirectory(namespace, to), record.generation);
    await writeDurable(join(slotDirectory(namespace, to), 'slot.json'), record);
    await syncDisk();
    await writeReplicationMarker(namespace, to, {
      from: source.id,
      phase: 'relocating',
      startedAt,
    });
    await removeTree(staging);
    return trashed;
  } catch (error) {
    await abandonSwap(namespace, to, source.id, toError(error).message);
    await removeTree(staging).catch(() => undefined);
    throw error;
  }
}

/**
 * A swap that stopped partway: the slot's trees are a mix. Its object
 * directories go, so the full build `slot restore` asks for starts clean.
 * Caller holds the slot's lock.
 */
async function abandonSwap(
  namespace: string,
  id: string,
  from: string,
  reason: string
): Promise<void> {
  const slot = await readJson<SlotRecord>(join(slotDirectory(namespace, id), 'slot.json'));
  await emptyTrash(await dropObjdirs(namespace, slot).catch(() => []));
  await quarantineSlot(
    namespace,
    id,
    `Replicating slot ${from}'s build into it stopped partway: ${reason}`
  );
  await clearReplicationMarker(namespace, id);
}

/**
 * Settles a replication that will not finish: a relocation that did not pass,
 * or one a crash interrupted. A slot interrupted while copying is untouched; one
 * interrupted while swapping is quarantined; any other keeps its consistent
 * source and loses the copied object directories and its anchor, so it reads
 * `needs=full-build`. The source is never touched.
 *
 * @throws {SlotBusyError} While something holds the slot; the next pass tries again
 */
export async function abandonReplication(
  namespace: string,
  id: string,
  marker: ReplicationMarker,
  reason: string
): Promise<void> {
  const release = await acquireSlot(namespace, id);
  const trashed: string[] = [];
  try {
    const directory = slotDirectory(namespace, id);
    for (const name of await readdir(directory))
      if (name.startsWith('replica-'))
        trashed.push(await moveToTrash(namespace, join(directory, name), `${id}-replaced`));
    if (marker.phase === 'copying') await clearReplicationMarker(namespace, id);
    else if (marker.phase === 'swapping') await abandonSwap(namespace, id, marker.from, reason);
    else {
      const slot = await readSlot(namespace, id);
      trashed.push(...(await dropObjdirs(namespace, slot)));
      delete slot.objdirToolsDigest;
      await invalidateBuildIdentity(namespace, slot, true);
      await clearReplicationMarker(namespace, id);
    }
  } finally {
    await release();
  }
  await emptyTrash(trashed);
}
