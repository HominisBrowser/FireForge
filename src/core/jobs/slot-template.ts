// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getNodeErrorCode } from '../../utils/errors.js';
import { sleep } from '../../utils/sleep.js';
import { exportPristineTree } from '../authored/index.js';
import { cloneEntry, detectCowSupport } from '../tree-cow.js';
import { slotGit } from './git-tools.js';
import { claimDirectory, SlotBusyError } from './slot-lock.js';
import { treeLogicalBytes } from './storage.js';
import { readJson, writeDurable } from './store.js';

const runFile = promisify(execFile);

/** A pristine tree at one pin, kept in the namespace. Every slot on that pin clones it. */
export interface SlotTemplate {
  directory: string;
  engine: string;
  repository: string;
  /** Logical bytes of the pinned tree. */
  sourceBytes: number;
}

const templateDirectory = (namespace: string, pin: string): string =>
  join(namespace, 'templates', pin);

/**
 * Brings an index up to date with its worktree. A clone keeps every whole-second
 * mtime and size the index recorded, and `core.checkStat=minimal` compares only
 * those, so this is a stat pass: only the template's own first refresh has to
 * hash the tree.
 */
async function refreshIndex(repository: string, engine: string): Promise<void> {
  try {
    await slotGit([
      '--git-dir',
      repository,
      '--work-tree',
      engine,
      '-c',
      'core.bare=false',
      'update-index',
      '-q',
      '--refresh',
    ]);
  } catch (error) {
    // Exit 1 only reports that some entry differs, which a materialized slot expects.
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
}

/** Fresh private Git metadata at a pin: no donor config, hooks, refs or ignored files. */
async function seedMetadata(repository: string, pristine: string, commit: string): Promise<void> {
  const format = (await slotGit(['-C', pristine, 'rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(format)) throw new Error('Unsupported pristine object format');
  await slotGit([
    'init',
    '--bare',
    '--quiet',
    '--template=',
    `--object-format=${format}`,
    repository,
  ]);
  await slotGit([
    '--git-dir',
    repository,
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    '--depth=1',
    pristine,
    commit,
  ]);
  await slotGit(['--git-dir', repository, 'update-ref', 'HEAD', commit]);
  for (const [key, value] of [
    ['core.hooksPath', '/dev/null'],
    ['core.checkStat', 'minimal'],
    ['core.trustctime', 'false'],
  ] as const)
    await slotGit(['--git-dir', repository, 'config', key, value]);
  await slotGit(['--git-dir', repository, 'read-tree', commit]);
  await mkdir(join(repository, 'info'), { recursive: true });
  await writeFile(join(repository, 'info', 'exclude'), '/obj-*/\n/.mozconfig\n/mozconfig\n');
}

/** A clone's Git metadata pointed at its own worktree. */
export async function attachMetadata(repository: string, engine: string): Promise<void> {
  await slotGit(['--git-dir', repository, 'config', 'core.bare', 'false']);
  await slotGit(['--git-dir', repository, 'config', 'core.worktree', engine]);
  await rm(join(engine, '.git'), { force: true });
  await writeFile(join(engine, '.git'), `gitdir: ${repository}\n`, { mode: 0o600 });
  await refreshIndex(repository, engine);
}

/** The one sync provisioning asks for: per-file durability is pointless when a crash just retries. */
export async function syncDisk(): Promise<void> {
  await runFile('sync');
}

/** The template for a pin, if one is complete. */
export async function readTemplate(
  namespace: string,
  pin: string
): Promise<SlotTemplate | undefined> {
  const directory = templateDirectory(namespace, pin);
  try {
    const { sourceBytes } = await readJson<{ sourceBytes: number }>(
      join(directory, 'template.json')
    );
    return {
      directory,
      engine: join(directory, 'engine'),
      repository: join(directory, 'engine.git'),
      sourceBytes,
    };
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Waits out a live holder: a template takes minutes once and any contender wants the same one. */
async function claimTemplateBuild(directory: string): Promise<() => Promise<void>> {
  for (;;) {
    try {
      return await claimDirectory(directory, 'Slot template');
    } catch (error) {
      if (!(error instanceof SlotBusyError)) throw error;
      await sleep(1_000);
    }
  }
}

/**
 * The pin's template, exported once. It is built beside its final name and
 * renamed into place, so a crash leaves nothing a later create could mistake for
 * a template, and any number of slot creates share one export.
 */
export async function ensureTemplate(
  namespace: string,
  pristine: string,
  pin: string
): Promise<SlotTemplate> {
  const existing = await readTemplate(namespace, pin);
  if (existing !== undefined) return existing;
  const parent = join(namespace, 'templates');
  const locks = join(parent, `.lock-${pin}`);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const release = await claimTemplateBuild(locks);
  try {
    const raced = await readTemplate(namespace, pin);
    if (raced !== undefined) return raced;
    for (const name of await readdir(parent))
      if (name.startsWith(`${pin}.building-`)) await removeTree(join(parent, name));
    const building = `${templateDirectory(namespace, pin)}.building-${randomUUID()}`;
    await mkdir(building, { recursive: true, mode: 0o700 });
    const engine = join(building, 'engine');
    const repository = join(building, 'engine.git');
    await exportPristineTree(pristine, pin, engine);
    await seedMetadata(repository, pristine, pin);
    await refreshIndex(repository, engine);
    await syncDisk();
    await writeDurable(join(building, 'template.json'), {
      pin,
      sourceBytes: await treeLogicalBytes(pristine, pin),
    });
    await rename(building, templateDirectory(namespace, pin));
    const created = await readTemplate(namespace, pin);
    if (created === undefined) throw new Error('Slot template did not publish');
    return created;
  } finally {
    await release();
  }
}

/** Clones a tree with the host's cheapest mechanism, preserving mtimes. */
export async function cloneTree(source: string, destination: string): Promise<void> {
  await cloneEntry(await detectCowSupport(dirname(destination)), source, destination);
}

/** Whether cloning here shares bytes, for what a new slot has to reserve. */
export async function clonesShareBytes(directory: string): Promise<boolean> {
  return (await detectCowSupport(directory)) !== 'none';
}

/** Deletes a tree whatever its permissions say: qualified sites are read-only on purpose. */
export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(getNodeErrorCode(error) ?? '')) throw error;
    // Another finisher may be deleting this too, which only makes the chmod's job smaller.
    await runFile('chmod', ['-R', 'u+rwX', path]).catch(() => undefined);
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  }
}

const trashDirectory = (namespace: string): string => join(namespace, 'trash');

/**
 * Moves a slot's directory out of its name in one step. After this the name is
 * free and what remains can only be deleted, by this process or whichever next
 * finds it.
 */
export async function moveToTrash(
  namespace: string,
  directory: string,
  id: string
): Promise<string> {
  await mkdir(trashDirectory(namespace), { recursive: true, mode: 0o700 });
  const destination = join(trashDirectory(namespace), `${id}-${randomUUID()}`);
  await rename(directory, destination);
  return destination;
}

/**
 * Deletes what a removal left in the trash, so an interrupted one finishes. It
 * never fails its caller, which has work of its own to do.
 *
 * @returns The slot names whose removal this completed
 */
export async function finishTrash(namespace: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(trashDirectory(namespace));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const finished: string[] = [];
  for (const name of names)
    try {
      await removeTree(join(trashDirectory(namespace), name));
      finished.push(name.replace(/-[a-f0-9-]{36}$/, ''));
    } catch {
      // Whoever comes next tries again: nothing depends on this having gone.
    }
  return finished;
}

/** Whether a path exists. */
export async function pathPresent(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
