// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import type { DependencyCacheConfig, FireForgeConfig } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { warn } from '../../utils/logger.js';
import { readSourceBlobs, sourceGit } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { cacheTargetProblem } from '../config-validate-slots.js';
import { cloneTree, pathPresent } from './slot-template.js';
import type { SlotCache, SlotRecord } from './slot-types.js';
import { readJson, slotDirectory, writeDurable } from './store.js';
import { toolTreeDigest, treeStatSignature } from './tool-files.js';

/** What a slot's dependency tree was installed for, and what it was then. */
interface CacheRecord {
  lockfile: string;
  /** The lockfile's digest in the source it was installed for; null when there is none. */
  lockfileDigest: string | null;
  digest: string;
  signature: string;
}
type CacheRecords = Record<string, CacheRecord>;

const ROOT_MODULES = 'node_modules';

/** Every dependency tree a project's slots hold. The root `node_modules` needs no declaration. */
export function declaredCaches(config: Pick<FireForgeConfig, 'slots'>): DependencyCacheConfig[] {
  const declared = config.slots?.dependencyCaches ?? [];
  return declared.some((cache) => cache.target === ROOT_MODULES)
    ? [...declared]
    : [{ source: ROOT_MODULES, target: ROOT_MODULES }, ...declared];
}

/** The lockfile a dependency tree is installed from: declared, or `package-lock.json` beside it. */
export const lockfileOf = (cache: DependencyCacheConfig): string =>
  cache.lockfile ?? posix.join(posix.dirname(cache.target), 'package-lock.json');

const declaredExplicitly = (config: Pick<FireForgeConfig, 'slots'>, target: string): boolean =>
  (config.slots?.dependencyCaches ?? []).some((cache) => cache.target === target);

/** `target=path` from a command line. */
export function parseCacheAssignments(assignments: readonly string[]): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const assignment of assignments) {
    const split = assignment.indexOf('=');
    if (split < 1) throw new Error(`--cache takes <target>=<path>, not ${assignment}`);
    sources[assignment.slice(0, split)] = resolve(assignment.slice(split + 1));
  }
  return sources;
}

/**
 * Where each cache comes from on this host: a path the command named, or its
 * declared `source` in this checkout. `engine/` means the engine named, since a
 * source-mode checkout has none of its own.
 *
 * @throws When a declared tree is not there, naming how to supply it
 */
export async function resolveCacheSources(
  config: Pick<FireForgeConfig, 'slots'>,
  options: { projectRoot: string; engine?: string; named?: Readonly<Record<string, string>> }
): Promise<SlotCache[]> {
  const caches: SlotCache[] = [];
  const known = new Set(declaredCaches(config).map((cache) => cache.target));
  for (const target of Object.keys(options.named ?? {}))
    if (!known.has(target))
      throw new Error(`--cache ${target} names no cache declared in slots.dependencyCaches`);
  for (const cache of declaredCaches(config)) {
    const named = options.named?.[cache.target];
    if (named !== undefined) {
      caches.push({ source: named, target: cache.target });
      continue;
    }
    const source =
      options.engine !== undefined && cache.source.startsWith('engine/')
        ? join(options.engine, cache.source.slice('engine/'.length))
        : join(options.projectRoot, cache.source);
    if (await pathPresent(source)) caches.push({ source, target: cache.target });
    else if (declaredExplicitly(config, cache.target))
      throw new Error(
        `Dependency cache ${cache.target} has no tree at ${source}. Install it there, or name one: --cache ${cache.target}=<path>`
      );
  }
  return caches;
}

/** Never import user or runtime state as a dependency cache. A package may have any name. */
function privateCacheEntry(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some((part, index) => {
    const parent = parts[index - 1];
    if (parent === ROOT_MODULES || parent?.startsWith('@') === true) return false;
    return (
      /^(?:profiles?|profile-.+|mozprofile-.+|_virtualenvs|\.fireforge|secrets|\.ssh|\.aws|minidumps|crashreports)$/i.test(
        part
      ) ||
      /^(?:cookies|places|formhistory|permissions|storage)\.sqlite(?:-wal|-shm)?$|^(?:key4|cert9)\.db$|^logins\.(?:json|db)$/i.test(
        part
      )
    );
  });
}

/**
 * Refuses state and links that would not mean the same in a slot. A link stays
 * inside its tree, or inside the engine for a tree the engine holds: npm links a
 * `file:` dependency to its source there, and a slot has that source too.
 */
async function assertRelocatable(source: string, container: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (privateCacheEntry(relative(source, path)))
        throw new Error(`Private/runtime cache entry refused: ${path}`);
      if (entry.isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link))
          throw new Error(`Dependency cache absolute alias is not relocatable: ${path}`);
        const reach = relative(container, resolve(directory, link));
        if (reach === '..' || reach.startsWith(`..${sep}`))
          throw new Error(`Dependency cache symlink escapes its root: ${path}`);
      } else if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw new Error(`Unsupported dependency cache entry: ${path}`);
    }
  };
  await visit(source);
}

/** The lockfile a source states: a captured file, or an engine file as this source leaves it. */
async function lockfileBytes(
  snapshot: AuthoredSnapshot,
  pristineRepository: string,
  path: string
): Promise<Buffer | undefined> {
  if (!path.startsWith('engine/')) {
    const input = snapshot.inputs.find((entry) => entry.path === path);
    if (input === undefined) return undefined;
    return (await readSourceBlobs(snapshot.repository, [input.blob])).get(input.blob);
  }
  const relativePath = path.slice('engine/'.length);
  const owned = snapshot.files.find((file) => file.path === relativePath);
  if (owned !== undefined)
    return owned.blob === undefined
      ? undefined
      : (await readSourceBlobs(snapshot.repository, [owned.blob])).get(owned.blob);
  try {
    return await sourceGit(pristineRepository, ['show', `${snapshot.pin.commit}:${relativePath}`]);
  } catch {
    return undefined;
  }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface LockEntry {
  version?: string;
  integrity?: string;
  optional?: boolean;
  peer?: boolean;
  devOptional?: boolean;
}

/** An npm lockfile's package table, empty for any other format: such a file states nothing to compare. */
function lockPackages(bytes: Buffer): Record<string, LockEntry> {
  try {
    return (
      (JSON.parse(bytes.toString('utf8')) as { packages?: Record<string, LockEntry> }).packages ??
      {}
    );
  } catch {
    return {};
  }
}

/**
 * Holds an installed tree to its lockfile, from the record npm keeps beside the
 * packages, whatever the tree's directory is called. Without this a stale checkout
 * would be cloned and recorded as current, which is the false green this whole
 * check exists to stop.
 *
 * @returns Why the two could not be compared, when they could not
 * @throws When the tree is not what its lockfile states
 */
async function compareWithLock(
  source: string,
  target: string,
  lockfile: string,
  lock: Buffer | undefined
): Promise<string | undefined> {
  if (lock === undefined) return `this source holds no ${lockfile}`;
  const stated = lockPackages(lock);
  if (Object.keys(stated).length === 0) return `${lockfile} is not an npm lockfile`;
  const remedy = `Run npm ci for ${target} first, at ${dirname(source)}`;
  let hidden: Buffer;
  try {
    hidden = await readFile(join(source, '.package-lock.json'));
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    if (basename(source) !== ROOT_MODULES) return `${target} holds no npm install record`;
    throw new Error(`${source} has no .package-lock.json to compare. ${remedy}`, { cause: error });
  }
  const installed = lockPackages(hidden);
  for (const [path, entry] of Object.entries(installed)) {
    const expected = stated[path];
    if (
      expected === undefined ||
      expected.version !== entry.version ||
      (expected.integrity !== undefined &&
        entry.integrity !== undefined &&
        expected.integrity !== entry.integrity)
    )
      throw new Error(
        `${source} holds ${path} ${entry.version ?? ''}, which its lockfile ${expected === undefined ? 'does not list' : `states as ${expected.version ?? ''}`}. ${remedy}`
      );
  }
  for (const [path, entry] of Object.entries(stated)) {
    if (!path.startsWith(`${ROOT_MODULES}/`) || installed[path] !== undefined) continue;
    if (entry.optional === true || entry.peer === true || entry.devOptional === true) continue;
    throw new Error(`${source} lacks ${path}, which its lockfile requires. ${remedy}`);
  }
  return undefined;
}

/** A tree's own entries. Dot entries other than npm's `.bin` are caches tools write as they run. */
async function identifiedEntries(tree: string): Promise<string[]> {
  return (await readdir(tree))
    .filter((name) => !name.startsWith('.') || name === '.bin')
    .sort()
    .map((name) => join(tree, name));
}

/** A tree's identity by its own bytes. A link leaving it counts as where it points. */
async function treeDigest(tree: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of await identifiedEntries(tree))
    hash
      .update(basename(entry))
      .update(await toolTreeDigest(entry, { externalLinks: true, aliases: [tree] }));
  return hash.digest('hex');
}

const treeSignature = async (tree: string): Promise<string> =>
  treeStatSignature(await identifiedEntries(tree));

const recordPath = (namespace: string, slotId: string): string =>
  join(slotDirectory(namespace, slotId), 'dependency-caches.json');

async function readRecords(namespace: string, slotId: string): Promise<CacheRecords> {
  try {
    return await readJson<CacheRecords>(recordPath(namespace, slotId));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return {};
    throw error;
  }
}

/** The file name a slot's record lives under, which a clone of the slot takes along. */
export const CACHE_RECORD_FILE = 'dependency-caches.json';

/** The trees a slot holds by declaration, which its audits leave to this module. */
export async function cacheTargets(namespace: string, slotId: string): Promise<string[]> {
  return Object.keys(await readRecords(namespace, slotId));
}

/** Refuses a path no tree may have, before anything is deleted at it. */
function assertCacheTarget(target: string, remedy: string): void {
  const problem = cacheTargetProblem(target);
  if (problem !== undefined)
    throw new Error(`Dependency cache target ${target} ${problem}. ${remedy}`);
}

/** Refuses a target reached through a link a source put in the slot: removing it would land elsewhere. */
async function assertRealParents(root: string, target: string): Promise<void> {
  let path = root;
  for (const part of target.split('/').slice(0, -1)) {
    path = join(path, part);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return;
    if (!info.isDirectory())
      throw new Error(`Dependency cache target ${target} passes through ${path}, not a directory`);
  }
}

/** A tree in the engine holds nothing upstream or this source tracks there. */
async function assertNoEngineSource(
  target: string,
  snapshot: AuthoredSnapshot,
  pristineRepository: string
): Promise<void> {
  if (!target.startsWith('engine/')) return;
  const path = target.slice('engine/'.length);
  const tracked = await sourceGit(pristineRepository, ['ls-tree', snapshot.pin.commit, '--', path]);
  if (tracked.length > 0 || snapshot.files.some((file) => file.path.startsWith(`${path}/`)))
    throw new Error(`Dependency cache ${target} overlaps tracked engine source`);
}

/**
 * Clones dependency trees into a slot and records what each is, removing only the
 * declared target. `replace` also takes out what the source no longer declares.
 * Caller holds the slot's lock.
 *
 * @throws When a tree is undeclared, holds private state, or is not what its lockfile states
 */
export async function installDependencyCaches(options: {
  namespace: string;
  slotId: string;
  root: string;
  pristineRepository: string;
  snapshot: AuthoredSnapshot;
  caches: readonly SlotCache[];
  replace?: boolean;
}): Promise<void> {
  const { namespace, slotId, root, pristineRepository, snapshot, caches } = options;
  const declared = declaredCaches(snapshot.config);
  const records = await readRecords(namespace, slotId);
  if (options.replace === true)
    for (const target of Object.keys(records))
      if (!declared.some((cache) => cache.target === target)) {
        assertCacheTarget(target, `Remove this slot: fireforge slot remove ${slotId}`);
        await assertRealParents(root, target);
        await rm(join(root, target), { recursive: true, force: true });
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by path
        delete records[target];
      }
  for (const cache of caches) {
    const declaration = declared.find((entry) => entry.target === cache.target);
    if (declaration === undefined || !isAbsolute(cache.source))
      throw new Error('Only an explicitly declared dependency cache is accepted');
    assertCacheTarget(cache.target, 'Correct slots.dependencyCaches in fireforge.json');
    if (
      snapshot.inputs.some(
        (input) => input.path === cache.target || input.path.startsWith(`${cache.target}/`)
      )
    )
      throw new Error(`Dependency cache ${cache.target} overlaps files this source captures`);
    await assertNoEngineSource(cache.target, snapshot, pristineRepository);
    await assertRealParents(root, cache.target);
    const lockfile = lockfileOf(declaration);
    const lock = await lockfileBytes(snapshot, pristineRepository, lockfile);
    const source = await realpath(cache.source);
    const incomparable = await compareWithLock(source, cache.target, lockfile, lock);
    await assertRelocatable(source, cache.target.startsWith('engine/') ? dirname(source) : source);
    const target = join(root, cache.target);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cloneTree(source, target);
    const earlier = records[cache.target];
    const lockfileDigest = lock === undefined ? null : sha256(lock);
    const treeIdentity = await treeDigest(target);
    records[cache.target] = {
      lockfile,
      lockfileDigest,
      digest: treeIdentity,
      signature: await treeSignature(target),
    };
    if (incomparable !== undefined && declaredExplicitly(snapshot.config, cache.target))
      warn(
        `${cache.target} cannot be compared with its lockfile: ${incomparable}. It is identified by its bytes, with ${lockfile} by its digest, so nothing here shows the tree was installed from it.${
          earlier !== undefined &&
          earlier.lockfileDigest !== lockfileDigest &&
          earlier.digest === treeIdentity
            ? ` ${lockfile} changed and these are the same bytes as before: reinstall the tree if it should have changed.`
            : ''
        }`
      );
  }
  await writeDurable(recordPath(namespace, slotId), records);
}

/**
 * A job runs only on the dependency trees its source's lockfiles state. Refused
 * before launch, naming the command that fixes it: a bumped lockfile over an old
 * tree would otherwise pass under a source that claims the new tools.
 */
export async function assertDependencyCachesCurrent(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot
): Promise<void> {
  const records = await readRecords(namespace, slot.id);
  const refresh = `Run: fireforge slot refresh-deps ${slot.id}`;
  const declared = declaredCaches(snapshot.config);
  for (const target of Object.keys(records))
    if (!declared.some((cache) => cache.target === target))
      throw new Error(
        `Slot ${slot.id} holds ${target}, which this source does not declare. ${refresh}`
      );
  let moved = false;
  for (const cache of declared) {
    const record = records[cache.target];
    const lockfile = lockfileOf(cache);
    if (record === undefined) {
      if (declaredExplicitly(snapshot.config, cache.target))
        throw new Error(
          `Slot ${slot.id} has no ${cache.target}, which this source declares. ${refresh}`
        );
      continue;
    }
    const lock = await lockfileBytes(snapshot, slot.pristineRepository, lockfile);
    if ((lock === undefined ? null : sha256(lock)) !== record.lockfileDigest)
      throw new Error(
        `Slot ${slot.id}'s ${cache.target} was installed for another ${lockfile} than this source's. ${refresh}`
      );
    const tree = join(slot.root, cache.target);
    const present = await lstat(tree).catch(() => undefined);
    if (present === undefined)
      throw new Error(`Slot ${slot.id} lost its ${cache.target}. ${refresh}`);
    const signature = await treeSignature(tree);
    if (signature === record.signature) continue;
    if ((await treeDigest(tree)) !== record.digest)
      throw new Error(
        `Slot ${slot.id}'s ${cache.target} changed since it was installed. ${refresh}`
      );
    record.signature = signature;
    moved = true;
  }
  if (moved) await writeDurable(recordPath(namespace, slot.id), records);
}
