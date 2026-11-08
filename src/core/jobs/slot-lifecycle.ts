// SPDX-License-Identifier: EUPL-1.2
import { cp, lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { UnknownSlotError } from '../../errors/job.js';
import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { materializeAuthoredSnapshot, readSourceBlobs } from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { CACHE_RECORD_FILE, cacheTargets, installDependencyCaches } from './dependency-caches.js';
import { slotGit } from './git-tools.js';
import { observeHost } from './host-quarantine.js';
import { nativeBuildDigest, readHostToolchain } from './native-tools.js';
import { processHasExitedAsync, processIdentityAsync } from './process.js';
import type { ProcessIdentity } from './schema.js';
import { assertNoSlotUsers, engineChanges } from './slot-audit.js';
import {
  attachMetadata,
  clonesShareBytes,
  cloneTree,
  ensureTemplate,
  finishTrash,
  moveToTrash,
  pathPresent,
  readTemplate,
  removeTree,
  syncDisk,
} from './slot-template.js';
import type { SlotCache, SlotRecord } from './slot-types.js';
import { acquireSlot, auditSlot, prepareSlot, readSlot, writeCapturedInputs } from './slots.js';
import { checkStorageCapacity, reserveSlotStorage } from './storage.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

/** Files that describe a slot's source and build state, copied with what they describe. */
const SLOT_STATE_FILES = [
  'materialization.json',
  'snapshot.json',
  'build-derived.json',
  'derived.json',
  CACHE_RECORD_FILE,
];

/**
 * Clones a built slot's source and objects together, so their mtimes stay in the
 * order the build left them and an incremental build sees only real differences.
 * Its Mach sites stay behind, since they hold their own path: qualification
 * rebuilds them and relocates the object directory. The anchor comes along only
 * if this host's tools are the ones that built it.
 */
async function cloneBuiltSlot(
  namespace: string,
  from: string,
  id: string,
  storage: SlotRecord['storage']
): Promise<SlotRecord> {
  const directory = slotDirectory(namespace, id);
  const root = join(directory, 'root');
  const release = await acquireSlot(namespace, from);
  try {
    const source = await readSlot(namespace, from);
    if (source.quarantined !== null)
      throw new Error(`Slot ${from} is quarantined: ${source.quarantined}`);
    await auditSlot(namespace, source);
    const sourceDirectory = slotDirectory(namespace, from);
    await cloneTree(join(sourceDirectory, 'engine.git'), join(directory, 'engine.git'));
    await mkdir(root, { mode: 0o700 });
    await cloneTree(join(source.root, 'engine'), join(root, 'engine'));
    const engine = join(root, 'engine');
    await attachMetadata(join(directory, 'engine.git'), engine);
    for (const name of await readdir(engine))
      if (name.startsWith('obj-'))
        await rm(join(engine, name, 'tmp'), { recursive: true, force: true });
    for (const name of await readdir(source.root))
      if (!['engine', '.fireforge'].includes(name))
        await cloneTree(join(source.root, name), join(root, name));
    await mkdir(join(root, '.fireforge'), { recursive: true, mode: 0o700 });
    for (const name of ['state.json', 'last-build.json'])
      await cp(join(source.root, '.fireforge', name), join(root, '.fireforge', name)).catch(
        (error: unknown) => {
          if (getNodeErrorCode(error) !== 'ENOENT') throw error;
        }
      );
    for (const name of SLOT_STATE_FILES)
      await cp(join(sourceDirectory, name), join(directory, name)).catch((error: unknown) => {
        if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      });
    const snapshot = await readJson<AuthoredSnapshot>(join(directory, 'snapshot.json'));
    const tools = await readHostToolchain(namespace).catch(() => undefined);
    const inherited =
      source.fullBuildAnchor?.nativeToolsDigest !== undefined &&
      tools !== undefined &&
      source.fullBuildAnchor.nativeToolsDigest === nativeBuildDigest(tools, snapshot);
    const slot: SlotRecord = {
      ...source,
      id,
      root,
      pristineRepository: join(directory, 'engine.git'),
      requiresBuild: true,
      ...(storage === undefined ? {} : { storage }),
    };
    delete slot.trustedBuild;
    delete slot.packageSignature;
    delete slot.requiresAudit;
    if (!inherited) {
      delete slot.fullBuildAnchor;
      slot.requiresFullBuild = true;
    }
    return slot;
  } finally {
    await release();
  }
}

/** A provisioning that failed or was interrupted leaves nothing worth keeping, so its name just comes back. */
async function retireAbandonedProvision(namespace: string, id: string): Promise<void> {
  const directory = slotDirectory(namespace, id);
  if (!(await pathPresent(directory)) || (await pathPresent(join(directory, 'slot.json')))) return;
  const interrupted = await readJson<{ owner?: ProcessIdentity }>(
    join(directory, 'provisioning.json')
  ).catch(() => undefined);
  if (interrupted?.owner !== undefined && !(await processHasExitedAsync(interrupted.owner)))
    throw new Error(`Slot ${id} is still being provisioned by process ${interrupted.owner.pid}`);
  await removeTree(await moveToTrash(namespace, directory, id));
}

export interface CreateSlotOptions {
  namespace: string;
  id: string;
  snapshot: AuthoredSnapshot;
  /** Needed only until the pin has a template. */
  pristineRepository?: string;
  /** Clone this built slot, objects included, instead of the pristine template. */
  from?: string;
  caches?: readonly SlotCache[];
  expectedDivergenceBytes?: number;
  expectedMemoryBytes?: number;
  diskFloorBytes?: number;
}

/**
 * Provisions a slot under its own lock, so peers' jobs keep running throughout.
 * Everything but a built slot's objects is a clone of the pin's pristine
 * template, so this takes minutes and costs almost no disk. The slot joins the
 * scheduler's pool when its lock is released.
 */
export async function createSlot(options: CreateSlotOptions): Promise<SlotRecord> {
  const { namespace, id, snapshot } = options;
  const directory = slotDirectory(namespace, id);
  await finishTrash(namespace);
  await retireAbandonedProvision(namespace, id);
  const release = await acquireSlot(namespace, id, undefined, { create: true });
  try {
    if (await pathPresent(join(directory, 'slot.json')))
      throw new SlotExistsError(`Slot ${id} already exists`);
    await writeDurable(join(directory, 'provisioning.json'), {
      owner: await processIdentityAsync(process.pid),
    });
    const slot = await provision(options, directory);
    await writeDurable(join(directory, 'slot.json'), slot);
    await prepareSlot(namespace, slot, snapshot);
    await rm(join(directory, 'provisioning.json'), { force: true });
    return slot;
  } catch (error) {
    if (!(error instanceof SlotExistsError)) {
      await writeDurable(join(directory, 'creation-failed.json'), {
        error: toError(error).message,
      });
      await rm(join(directory, 'provisioning.json'), { force: true });
    }
    throw error;
  } finally {
    await release();
  }
}

class SlotExistsError extends Error {
  override readonly name = 'SlotExistsError';
}

async function provision(options: CreateSlotOptions, directory: string): Promise<SlotRecord> {
  const { namespace, id, snapshot, from } = options;
  const pin = snapshot.pin.commit;
  const root = join(directory, 'root');
  const existing = await readTemplate(namespace, pin);
  if (existing === undefined && options.pristineRepository === undefined && from === undefined)
    throw new Error(
      `Pin ${pin} has no slot template yet; name a pristine repository with --pristine-repository, or create a donor with: fireforge authored pristine fetch`
    );
  const template =
    existing ??
    (from === undefined
      ? await ensureTemplate(namespace, options.pristineRepository ?? '', pin)
      : undefined);
  const measured =
    from === undefined ? undefined : (await readSlot(namespace, from)).storage?.consumedBytes;
  const storage = await reserveSlotStorage(namespace, {
    sourceBytes: template?.sourceBytes ?? 0,
    cow: await clonesShareBytes(directory),
    ...(measured === undefined ? {} : { measuredBytes: measured }),
    ...(options.expectedDivergenceBytes === undefined
      ? {}
      : { expectedDivergenceBytes: options.expectedDivergenceBytes }),
    ...(options.expectedMemoryBytes === undefined
      ? {}
      : { expectedMemoryBytes: options.expectedMemoryBytes }),
    ...(options.diskFloorBytes === undefined ? {} : { diskFloorBytes: options.diskFloorBytes }),
  });
  await checkStorageCapacity(namespace, storage);
  let slot: SlotRecord;
  if (from !== undefined || template === undefined)
    slot = await cloneBuiltSlot(namespace, from ?? '', id, storage);
  else {
    await mkdir(root, { mode: 0o700 });
    await cloneTree(template.engine, join(root, 'engine'));
    await cloneTree(template.repository, join(directory, 'engine.git'));
    await attachMetadata(join(directory, 'engine.git'), join(root, 'engine'));
    slot = {
      schemaVersion: 1,
      id,
      root,
      pristineRepository: join(directory, 'engine.git'),
      pin,
      sourceId: '',
      generation: 0,
      successfulBuildGeneration: 0,
      inputs: [],
      quarantined: null,
      storage,
    };
  }
  await installDependencyCaches({
    namespace,
    slotId: id,
    root,
    pristineRepository: slot.pristineRepository,
    snapshot,
    caches: options.caches ?? [],
  });
  await syncDisk();
  return slot;
}

/**
 * Replaces a slot's dependency trees with this source's, under the slot's own lock.
 * A job refuses until this has run for a lockfile it has not seen.
 *
 * @throws While a job or a process holds the slot, or a tree is not what its lockfile states
 */
export async function refreshSlotDependencies(options: {
  namespace: string;
  id: string;
  snapshot: AuthoredSnapshot;
  caches: readonly SlotCache[];
}): Promise<string[]> {
  const { namespace, id, snapshot, caches } = options;
  const release = await acquireSlot(namespace, id);
  try {
    const slot = await readSlot(namespace, id);
    await assertNoSlotUsers(slot.root);
    // Trees follow lockfiles, not the pin, except for a lockfile the pin itself holds: that is read at the slot's.
    const samePin = slot.pin === snapshot.pin.commit;
    try {
      await installDependencyCaches({
        namespace,
        slotId: id,
        root: slot.root,
        pristineRepository: slot.pristineRepository,
        snapshot: samePin ? snapshot : { ...snapshot, pin: { ...snapshot.pin, commit: slot.pin } },
        caches,
        replace: true,
      });
    } catch (error) {
      if (samePin) throw error;
      const reason = toError(error).message.replace(/\.?$/, '.');
      throw new Error(
        `${reason} Slot ${id} is on pin ${slot.pin} and this checkout on ${snapshot.pin.commit}, so what the pin states is read at ${slot.pin}: name trees installed for it with --cache <target>=<path>`,
        { cause: error }
      );
    }
    return await cacheTargets(namespace, id);
  } finally {
    await release();
  }
}

/**
 * Removes a slot under its own lock, whatever state it is in: read-only qualified
 * sites, or a provisioning that never finished. The directory leaves its name in
 * one rename, so a crash after that leaves only trash, which the next removal,
 * creation or supervisor start finishes. The pin's template, retained sources,
 * job records and receipts stay.
 */
export async function removeSlot(namespace: string, id: string): Promise<{ removed: string }> {
  const directory = slotDirectory(namespace, id);
  const finished = await finishTrash(namespace);
  if (!(await pathPresent(directory))) {
    if (finished.includes(id)) return { removed: id };
    throw new UnknownSlotError(`Slot ${id} does not exist; fireforge slot list shows what exists`);
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Slot directory aliases another tree');
  const release = await acquireSlot(namespace, id);
  let trashed: string;
  try {
    const interrupted = await readJson<{ owner?: ProcessIdentity }>(
      join(directory, 'provisioning.json')
    ).catch(() => undefined);
    if (interrupted?.owner !== undefined && !(await processHasExitedAsync(interrupted.owner)))
      throw new Error(`Slot ${id} is still being provisioned by process ${interrupted.owner.pid}`);
    await assertNoSlotUsers(directory);
    trashed = await moveToTrash(namespace, directory, id);
  } catch (error) {
    await release();
    throw error;
  }
  await removeTree(trashed);
  return { removed: id };
}

/** Whether an engine path already holds exactly what the snapshot wants there, so it keeps its mtime. */
async function holdsSnapshotBytes(
  engine: string,
  file: AuthoredSnapshot['files'][number],
  blobs: ReadonlyMap<string, Buffer>
): Promise<boolean> {
  const path = join(engine, file.path);
  const info = await lstat(path).catch(() => undefined);
  if (file.kind === 'delete') return info === undefined;
  const wanted = file.blob === undefined ? undefined : blobs.get(file.blob);
  if (info?.isFile() !== true || wanted === undefined) return false;
  if (((info.mode & 0o111) !== 0 ? '100755' : '100644') !== file.mode) return false;
  return info.size === wanted.length && (await readFile(path)).equals(wanted);
}

/** Removes directories under `path` with nothing in them, and `path` itself if that empties it. */
async function removeEmptyDirectories(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries)
    if (entry.isDirectory()) await removeEmptyDirectories(join(path, entry.name));
  await rmdir(path).catch(() => undefined);
}

/**
 * Takes the engine back to its pristine tree plus exactly the snapshot, whatever
 * state an interruption left, and without consulting any record of how it got
 * there. Only object directories and what already holds the snapshot's bytes stay
 * untouched, so their mtimes keep the next build incremental. Everything generated
 * goes, directories included: a generator treats an empty directory as its own.
 */
async function resetEngine(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot
): Promise<void> {
  const engine = join(slot.root, 'engine');
  const directory = slotDirectory(namespace, slot.id);
  const owned = new Map(snapshot.files.map((file) => [file.path, file]));
  const blobs = await readSourceBlobs(
    snapshot.repository,
    snapshot.files.flatMap((file) => (file.blob === undefined ? [] : [file.blob]))
  );
  const tracked: string[] = [];
  for (const entry of await engineChanges(engine, await cacheTargets(namespace, slot.id))) {
    const path = entry.slice(3);
    const file = owned.get(path);
    if (file !== undefined && (await holdsSnapshotBytes(engine, file, blobs))) continue;
    if (entry.startsWith('??') || entry.startsWith('!!')) {
      await rm(join(engine, path), { force: true, recursive: true });
    } else tracked.push(path);
  }
  // Status lists files, so a directory with nothing in it needs asking about.
  const others = await slotGit([
    '-C',
    engine,
    'ls-files',
    '--others',
    '--directory',
    '-z',
    '--exclude=/obj-*/',
  ]);
  for (const path of others.split('\0'))
    if (path.endsWith('/')) await removeEmptyDirectories(join(engine, path));
  // A tracked path may have been replaced by a directory: what stood in its way has gone.
  for (let start = 0; start < tracked.length; start += 500)
    await slotGit([
      '--literal-pathspecs',
      '-C',
      engine,
      'checkout',
      'HEAD',
      '--',
      ...tracked.slice(start, start + 500),
    ]);
  for (const name of [
    'build-derived.json',
    'derived.json',
    'materialization.json',
    'materialization.json.journal',
  ])
    await rm(join(directory, name), { force: true });
}

/** Removes every root path that is not engine, dependency or private state, including strays. */
async function clearCapturedRoot(
  root: string,
  caches: readonly string[],
  prefix = ''
): Promise<void> {
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (prefix === '' && ['engine', 'node_modules', '.fireforge', '.git'].includes(name)) continue;
    if (caches.includes(path)) continue;
    if (caches.some((cache) => cache.startsWith(`${path}/`)))
      await clearCapturedRoot(root, caches, path);
    else await rm(join(root, path), { recursive: true, force: true });
  }
}

/** A control left unrestored and the locks of a process that no longer exists. Nothing else here is state. */
async function clearPrivateRuntimeState(root: string): Promise<void> {
  const privateRoot = join(root, '.fireforge');
  await rm(join(privateRoot, 'negative-control'), { recursive: true, force: true });
  await rm(join(privateRoot, 'profiles'), { recursive: true, force: true });
  for (const name of await readdir(privateRoot).catch(() => [] as string[]))
    if (name.startsWith('engine-session.lock'))
      await rm(join(privateRoot, name), { recursive: true, force: true });
}

/**
 * Brings a quarantined slot back under its own lock, with no other agent
 * affected. The snapshot on disk is the truth, whatever the slot's record says:
 * a crash between the two writes of a preparation leaves them disagreeing. Its
 * source goes back to pristine plus that snapshot, the audit decides, and the
 * quarantine clears only after that. A crash here leaves it quarantined and able
 * to run again. The object directory stays, so the build that follows is
 * incremental. That build has to be a full one, because whatever made this slot
 * uncertain may have touched compiled output.
 *
 * @throws When a live process holds or uses the slot, or the audit still fails
 */
export async function restoreSlot(namespace: string, id: string): Promise<SlotRecord> {
  const release = await acquireSlot(namespace, id);
  try {
    const slot = await readSlot(namespace, id);
    const { groups } = await observeHost(namespace);
    const live = groups.find((entry) => entry.slot === id);
    if (live !== undefined)
      throw new Error(
        `Slot ${id} cannot be restored while process group ${String(live.group)} from job ${live.job} still runs; stop it first`
      );
    await assertNoSlotUsers(slot.root);
    const directory = slotDirectory(namespace, id);
    const snapshot = await readJson<AuthoredSnapshot>(join(directory, 'snapshot.json'));
    await clearPrivateRuntimeState(slot.root);
    await resetEngine(namespace, slot, snapshot);
    await clearCapturedRoot(slot.root, await cacheTargets(namespace, id));
    await writeCapturedInputs(namespace, slot, snapshot);
    await materializeAuthoredSnapshot({
      snapshot,
      engineDir: join(slot.root, 'engine'),
      ledgerPath: join(directory, 'materialization.json'),
      pristineRepository: slot.pristineRepository,
    });
    slot.sourceId = snapshot.id;
    slot.generation += 1;
    slot.requiresBuild = true;
    slot.requiresFullBuild = true;
    delete slot.requiresAudit;
    delete slot.trustedBuild;
    delete slot.packageSignature;
    delete slot.fullBuildAnchor;
    await auditSlot(namespace, slot);
    slot.quarantined = null;
    await writeDurable(join(directory, 'slot.json'), slot);
    return slot;
  } finally {
    await release();
  }
}
