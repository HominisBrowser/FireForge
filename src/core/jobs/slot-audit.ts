// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { mapWithConcurrency } from '../../utils/concurrency.js';
import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { listProcesses } from '../../utils/process-list.js';
import { readSourceBlobs } from '../authored/index.js';
import { assertNoSourceAliases } from '../authored/paths.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { readBuildDerived } from './build-derived.js';
import { cacheTargets } from './dependency-caches.js';
import { readDerivedOutputs } from './derived.js';
import { slotGit } from './git-tools.js';
import type { SlotRecord } from './slot-types.js';
import { readJson, slotDirectory } from './store.js';
import { readRegularFile } from './tool-files.js';

interface Image {
  path: string;
  mode: '100644' | '100755';
  blob?: string;
  sha256?: string;
  deleted?: boolean;
}

async function readImage(root: string, image: Image, blobs: Map<string, Buffer>): Promise<Buffer> {
  await assertNoSourceAliases(root, image.path, { allowEngineRoot: true });
  const path = join(root, image.path);
  if (image.deleted) {
    try {
      await lstat(path);
    } catch (error) {
      if (getNodeErrorCode(error) === 'ENOENT') return Buffer.from('deleted');
      throw error;
    }
    throw new Error(`Deleted runtime path returned: ${image.path}`);
  }
  const file = await readRegularFile(path, `Runtime kind/mode drift: ${image.path}`);
  if (file.mode !== image.mode) throw new Error(`Runtime kind/mode drift: ${image.path}`);
  if (
    image.blob !== undefined &&
    (!blobs.has(image.blob) || !file.bytes.equals(blobs.get(image.blob) ?? Buffer.alloc(0)))
  )
    throw new Error(`Captured/runtime source drift: ${image.path}`);
  if (image.sha256 !== undefined && file.sha256 !== image.sha256)
    throw new Error(`Derived/build generation drift: ${image.path}`);
  return file.bytes;
}

async function auditRootPaths(
  root: string,
  allowed: Set<string>,
  caches: readonly string[],
  prefix = ''
): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && ['engine', 'node_modules', '.fireforge', '.git'].includes(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // A declared dependency tree answers to its lockfile record, not to this audit.
    if (caches.includes(path)) continue;
    if (entry.isDirectory()) await auditRootPaths(root, allowed, caches, path);
    else if (!entry.isFile() || !allowed.has(path))
      throw new Error(`Undeclared captured-root drift: ${path}`);
  }
}

/** A slot whose bytes or process state cannot be trusted until `slot restore` has run. */
export class SlotIntegrityError extends Error {
  override readonly name: string = 'SlotIntegrityError';
}

/** Preparation stopped partway. Unlike a failed audit, the job in hand may be the cause. */
export class SlotPreparationError extends SlotIntegrityError {
  override readonly name = 'SlotPreparationError';
}

/** Non-empty when a negative control's mutation was never restored. */
export async function pendingControl(root: string): Promise<boolean> {
  try {
    return (await readdir(join(root, '.fireforge', 'negative-control'))).length > 0;
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    return false;
  }
}

/** Ignored paths a build legitimately leaves: its object directories and Python's caches. */
const SANCTIONED_IGNORED = /^(?:obj-[^/]+\/|(?:.*\/)?__pycache__\/|.*\.pyc)$/;

/**
 * The engine's changes against its pristine index, as `git status` reports them,
 * including what any ignore file hides: a job-written `.mozconfig` is drift even
 * though upstream's ignore rules would keep it out of an ordinary status. Runs
 * under the hermetic configuration, so no user's global ignore file or fsmonitor
 * has a say. `caches` are the slot's declared dependency trees, root-relative: they
 * answer to their lockfile record.
 */
export async function engineChanges(
  engine: string,
  caches: readonly string[] = []
): Promise<string[]> {
  const stdout = await slotGit([
    '-C',
    engine,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored=matching',
    '--no-renames',
  ]);
  const cached = caches
    .filter((cache) => cache.startsWith('engine/'))
    .map((cache) => cache.slice('engine/'.length));
  return stdout
    .split('\0')
    .filter(
      (entry) =>
        entry !== '' &&
        !(entry.startsWith('!!') && SANCTIONED_IGNORED.test(entry.slice(3))) &&
        !cached.some((cache) => `${entry.slice(3)}/`.startsWith(`${cache}/`))
    );
}

/**
 * Refuses while any process of this user holds a file or working directory under
 * this path. This reaches what no process census can: macOS hides an Apple
 * binary's environment, so a detached `/bin/sh` left in a slot carries no marker
 * anyone can read, and only its working directory gives it away.
 *
 * @param path - The directory held
 * @param since - When the first job that could have started such a process was
 *   submitted. Given it, a holder that writes nothing and began outside those jobs
 *   is left alone, since a person's shell in a slot says nothing about the slot.
 *   Without it, every holder refuses, as destroying a slot's contents needs.
 */
export async function assertNoSlotUsers(path: string, since?: string): Promise<void> {
  const canonical = await realpath(path);
  const command = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  let output: string;
  try {
    ({ stdout: output } = await promisify(execFile)(
      command,
      ['-n', '-P', '-Fpan', '-u', String(process.getuid?.())],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
    ));
  } catch (error) {
    throw new Error(
      'Cannot establish that the slot has no live users; preserve it until ownership can be audited',
      { cause: error }
    );
  }
  let pid = 0;
  let access = '';
  const users = new Map<number, { writes: boolean }>();
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('f')) access = '';
    if (line.startsWith('a')) access = line.slice(1);
    if (
      line.startsWith('n') &&
      [path, canonical].some(
        (prefix) => line.slice(1) === prefix || line.slice(1).startsWith(`${prefix}/`)
      )
    ) {
      const writes = users.get(pid)?.writes === true || access === 'w' || access === 'u';
      users.set(pid, { writes });
    }
  }
  if (users.size === 0) return;
  const table = since === undefined ? undefined : await processTree();
  for (const [user, { writes }] of users) {
    if (
      table !== undefined &&
      since !== undefined &&
      !writes &&
      beganOutsideJobs(user, table, Date.parse(since) / 1000)
    ) {
      process.stderr.write(
        `Process ${String(user)} reads slot ${path} but began outside its jobs, so it is left alone\n`
      );
      continue;
    }
    throw new Error(`Slot is still in use by process ${String(user)}`);
  }
}

type ProcessTree = ReadonlyMap<number, { parent: number; began: number }>;

async function processTree(): Promise<ProcessTree> {
  const rows = await listProcesses(['pid', 'ppid', 'lstart'] as const);
  return new Map(
    rows.map((row) => [row.pid, { parent: row.ppid, began: Number(row.lstart) }] as const)
  );
}

/**
 * Whether a process holding a slot path cannot be anything a job started: an
 * operator's shell, an agent's, an editor. A job's process descends from this
 * supervisor or, once orphaned, hangs from init with a birth inside the job's
 * time. So the process is outside only when its line does not pass through this
 * process and the oldest ancestor below init is older than the first job that
 * could have started it. One that has already gone holds nothing.
 */
function beganOutsideJobs(pid: number, table: ProcessTree, since: number): boolean {
  let current = pid;
  let entry = table.get(current);
  if (entry === undefined) return true;
  for (;;) {
    if (current === process.pid) return false;
    const parent = table.get(entry.parent);
    // A birth is a whole second, so that whole second has to be over before the job.
    if (entry.parent <= 1 || parent === undefined) return entry.began + 1 <= since;
    current = entry.parent;
    entry = parent;
  }
}

/**
 * The boundary audit. Any failure means the slot cannot be trusted, so it is
 * always a {@link SlotIntegrityError}.
 */
export async function auditSlot(
  namespace: string,
  slot: SlotRecord
): Promise<{ runtimeDigest: string; ledgerDigest: string }> {
  try {
    return await auditSlotContents(namespace, slot);
  } catch (error) {
    throw new SlotIntegrityError(toError(error).message, {
      cause: error,
    });
  }
}

/** One batched object read and bounded file IO, then the full upstream boundary census before receipt sealing. */
async function auditSlotContents(
  namespace: string,
  slot: SlotRecord
): Promise<{ runtimeDigest: string; ledgerDigest: string }> {
  const snapshot = await readJson<AuthoredSnapshot>(
    join(slotDirectory(namespace, slot.id), 'snapshot.json')
  );
  if (snapshot.id !== slot.sourceId) throw new Error('Slot source identity mismatch');
  if (await pendingControl(slot.root))
    throw new Error('Negative control restoration remains pending');
  const derived = await readDerivedOutputs(namespace, slot);
  const build = await readBuildDerived(namespace, slot);
  const images = new Map<string, Image>();
  for (const input of snapshot.inputs)
    images.set(input.path, { path: input.path, mode: input.mode, blob: input.blob });
  for (const file of snapshot.files)
    images.set(`engine/${file.path}`, {
      path: `engine/${file.path}`,
      mode: file.mode,
      ...(file.blob === undefined ? {} : { blob: file.blob }),
      deleted: file.kind === 'delete',
    });
  for (const [path, image] of Object.entries(build))
    images.set(`engine/${path}`, {
      path: `engine/${path}`,
      mode: image.mode,
      sha256: image.sha256,
    });
  for (const image of Object.values(derived))
    images.set(image.path, { path: image.path, mode: image.mode, sha256: image.sha256 });
  const caches = await cacheTargets(namespace, slot.id);
  await auditRootPaths(
    slot.root,
    new Set([...images.keys()].filter((path) => !path.startsWith('engine/'))),
    caches
  );
  const blobs = await readSourceBlobs(snapshot.repository, [
    ...new Set(
      [...images.values()].flatMap((image) => (image.blob === undefined ? [] : [image.blob]))
    ),
  ]);
  const ordered = [...images.values()].sort((a, b) => a.path.localeCompare(b.path));
  const contents = await mapWithConcurrency(ordered, 16, (image) =>
    readImage(slot.root, image, blobs)
  );
  const hash = createHash('sha256');
  ordered.forEach((image, index) =>
    hash
      .update(JSON.stringify({ path: image.path, mode: image.mode }))
      .update(contents[index] ?? Buffer.alloc(0))
  );
  const allowed = new Set([
    ...snapshot.files.map((file) => file.path),
    ...Object.keys(build),
    ...Object.keys(derived)
      .filter((path) => path.startsWith('engine/'))
      .map((path) => path.slice(7)),
  ]);
  const changes = await engineChanges(join(slot.root, 'engine'), caches);
  for (const entry of changes)
    if (!allowed.has(entry.slice(3).replace(/\/$/, '')))
      throw new Error(`Undeclared engine drift: ${entry.slice(3)}`);
  const ledger = await readFile(join(slotDirectory(namespace, slot.id), 'materialization.json'));
  return {
    runtimeDigest: hash.digest('hex'),
    ledgerDigest: createHash('sha256').update(ledger).digest('hex'),
  };
}
