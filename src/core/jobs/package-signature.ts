// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import type { PackageSignature, SlotRecord } from './slot-types.js';
import { type TreeEntry, walkTree, withinRoots } from './tool-files.js';

/** A package that moved after the build that made it: nothing that runs from it proves anything. */
export class PackageChangedError extends Error {
  override readonly name = 'PackageChangedError';
}

/**
 * What a running browser or harness writes beside the package: lock files, update
 * state, crash reports and Python's caches, and the `.purgecaches` marker a build
 * leaves for the browser to remove at startup. None of it is what the build made.
 */
const RUNTIME_RESIDUE =
  /^(?:\.purgecaches|\.parentlock|parent\.lock|lock|\.DS_Store|__pycache__|updates|active-update\.xml|update\.(?:log|status|version)|Crash Reports|minidumps|.*\.(?:log|pyc))$/;

const skipResidue = (name: string): boolean => RUNTIME_RESIDUE.test(name);

/** What a build leaves in `dist/` to be run: its staging tree and any application bundle. */
async function packageRoots(root: string): Promise<string[]> {
  const engine = join(root, 'engine');
  const roots: string[] = [];
  const objects = await readdir(engine, { withFileTypes: true }).catch(() => []);
  for (const object of objects) {
    if (!object.name.startsWith('obj-') || !object.isDirectory()) continue;
    const dist = join(engine, object.name, 'dist');
    const names = await readdir(dist).catch(() => [] as string[]);
    for (const name of names)
      if (name === 'bin' || name.endsWith('.app')) roots.push(join(dist, name));
  }
  return roots.sort();
}

/** How many links resolve at once: an objdir's `dist/bin` holds thousands. */
const LINK_BATCH = 64;

/** What a link resolves to, or why it resolves to nothing. */
type LinkTarget = { kind: 'resolved'; info: Stats } | { kind: 'missing' | 'cycle' };

/** A following stat, one call however long the chain: the file the link runs. */
async function resolveLink(path: string): Promise<LinkTarget> {
  try {
    return { kind: 'resolved', info: await stat(path) };
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'cycle' };
    throw error;
  }
}

/**
 * Which links a package signature binds by target, given the package roots: a
 * target in an objdir or outside the slot is, one in the engine's source tree is
 * not. Undefined for a link left to the slot audit, else whether it is outside.
 */
async function linkScope(
  root: string,
  entries: readonly string[]
): Promise<(path: string, text: string) => { outside: boolean } | undefined> {
  const real = await realpath(root).catch(() => root);
  const slot = [root, real];
  const engine = [join(root, 'engine'), join(real, 'engine')];
  // `engine/obj-*/dist/<root>`: each package root's objdir, as both spellings of the slot.
  const objdirs = entries.flatMap((entry) => {
    const objdir = dirname(dirname(entry));
    return [objdir, join(real, relative(root, objdir))];
  });
  return (path, text) => {
    const target = resolve(dirname(path), text);
    const outside = !withinRoots(target, slot);
    return outside || withinRoots(target, objdirs) || !withinRoots(target, engine)
      ? { outside }
      : undefined;
  };
}

/**
 * A stat of everything the build made to be run, and of the file each symbolic link
 * in it runs: an objdir's `dist/bin` is mostly links, and a link's own stat says
 * nothing of its target. A target in an objdir is build output and bound here; one
 * outside the slot (a toolchain library under `~/.mozbuild`, say) is bound the same
 * way and marked as outside. A target in the engine's source tree is captured
 * source, which the slot audit binds to its snapshot and a new source rewrites
 * before its build, so it is left to that audit. A linked directory outside the
 * package roots is walked once, so links back into it end. A directory counts by
 * its name alone, since a lock file coming and going moves its mtime and means
 * nothing.
 */
async function packageDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walked = new Set<string>();
  const stamp = (info: Stats): [number, number, number] => [
    info.mode,
    info.size,
    Math.floor(info.mtimeMs),
  ];
  let links: Array<{ path: string; label: string; outside: boolean }> = [];
  const entries = await packageRoots(root);
  const scope = await linkScope(root, entries);
  const visit = async ({ path, label, info }: TreeEntry): Promise<void> => {
    if (info.isDirectory()) {
      hash.update(JSON.stringify([label]));
      return;
    }
    const text = info.isSymbolicLink() ? await readlink(path) : '';
    hash.update(JSON.stringify([label, ...stamp(info), text]));
    const bound = info.isSymbolicLink() ? scope(path, text) : undefined;
    if (bound !== undefined) links.push({ path, label, outside: bound.outside });
  };
  for (const entry of entries) {
    hash.update(JSON.stringify(entry.slice(root.length)));
    await walkTree(entry, visit, { skip: skipResidue });
  }
  // A directory inside a package root is in the walk already.
  const scanned = await Promise.all(entries.map((entry) => realpath(entry)));
  // Each round resolves the links the last one found, many at once and hashed in walk order.
  while (links.length > 0) {
    const round = links;
    links = [];
    const targets: LinkTarget[] = [];
    for (let index = 0; index < round.length; index += LINK_BATCH)
      targets.push(
        ...(await Promise.all(
          round.slice(index, index + LINK_BATCH).map(({ path }) => resolveLink(path))
        ))
      );
    for (const [index, { path, label, outside }] of round.entries()) {
      const target = targets[index];
      if (target === undefined) continue;
      if (target.kind !== 'resolved') {
        hash.update(JSON.stringify(['->', label, target.kind]));
        continue;
      }
      if (!target.info.isDirectory()) {
        hash.update(JSON.stringify(['->', label, outside, ...stamp(target.info)]));
        continue;
      }
      hash.update(JSON.stringify(['->', label, outside]));
      const directory = await realpath(path);
      if (walked.has(directory) || withinRoots(directory, scanned)) continue;
      walked.add(directory);
      await walkTree(directory, visit, { skip: skipResidue, prefix: `${label}->` });
    }
  }
  return hash.digest('hex');
}

/** Records a build's package, right after the build. */
export async function signPackage(root: string): Promise<PackageSignature> {
  const at = Date.now();
  return { digest: await packageDigest(root), at };
}

/**
 * Up to a few entries changed since the signature, so a refusal can say what moved.
 * File times carry sub-millisecond precision and `at` does not, so both compare as
 * whole milliseconds: a file written in the millisecond the signature was taken is
 * not later than it.
 */
async function movedSince(root: string, at: number): Promise<string[]> {
  const moved: string[] = [];
  const entries = await packageRoots(root);
  const scope = await linkScope(root, entries);
  for (const entry of entries) {
    await walkTree(
      entry,
      async ({ path, label, info }) => {
        if (info.isDirectory() || moved.length >= 5) return;
        if (Math.floor(info.mtimeMs) > at) moved.push(label);
        else if (info.isSymbolicLink() && scope(path, await readlink(path)) !== undefined) {
          const target = await stat(path).catch(() => undefined);
          if (target !== undefined && Math.floor(target.mtimeMs) > at)
            moved.push(`${label} (its target)`);
        }
      },
      { skip: skipResidue, prefix: relative(join(root, 'engine'), entry) }
    );
  }
  return moved;
}

/**
 * Refuses a package that differs from its signature. A slot with no signature has
 * no package this can speak for: its build state decides by itself.
 *
 * @throws {PackageChangedError} When the package moved since the build that signed it
 */
export async function assertPackageUnchanged(slot: SlotRecord): Promise<void> {
  const signed = slot.packageSignature;
  if (signed === undefined) return;
  let current: string;
  try {
    current = await packageDigest(slot.root);
  } catch (error) {
    // An entry vanishing under the walk is a package still moving.
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    current = '';
  }
  if (current === signed.digest) return;
  const moved = await movedSince(slot.root, signed.at).catch(() => [] as string[]);
  throw new PackageChangedError(
    `Slot ${slot.id}'s package changed after the build that made it${
      moved.length === 0 ? '' : `: ${moved.join(', ')}`
    }`
  );
}

/** The phase each job's package was last checked for. */
const verifiedPhases = new Map<string, string>();

/** Says a phase starts from a package its job's previous step just signed. */
export function markPackageVerified(job: string, phase: string): void {
  verifiedPhases.set(job, phase);
}

/**
 * {@link assertPackageUnchanged}, once per phase: a step's CLIs each ask to be
 * authorized, and this walks a whole package.
 */
export async function verifyPackageOncePerPhase(
  slot: SlotRecord,
  job: string,
  phase: string
): Promise<void> {
  if (verifiedPhases.get(job) === phase) return;
  await assertPackageUnchanged(slot);
  verifiedPhases.set(job, phase);
}
