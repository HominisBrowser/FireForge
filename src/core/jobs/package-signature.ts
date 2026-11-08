// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import type { PackageSignature, SlotRecord } from './slot-types.js';
import { type TreeEntry, walkTree } from './tool-files.js';

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

/**
 * A stat of everything the build made to be run. A directory counts by its name
 * alone, since a lock file coming and going moves its mtime and means nothing.
 */
async function packageDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async ({ path, label, info }: TreeEntry): Promise<void> => {
    if (info.isDirectory()) hash.update(JSON.stringify([label]));
    else
      hash.update(
        JSON.stringify([
          label,
          info.mode,
          info.size,
          Math.floor(info.mtimeMs),
          info.isSymbolicLink() ? await readlink(path) : '',
        ])
      );
  };
  for (const entry of await packageRoots(root)) {
    hash.update(JSON.stringify(entry.slice(root.length)));
    await walkTree(entry, visit, { skip: skipResidue });
  }
  return hash.digest('hex');
}

/** Records a build's package, right after the build. */
export async function signPackage(root: string): Promise<PackageSignature> {
  const at = Date.now();
  return { digest: await packageDigest(root), at };
}

/** Up to a few entries changed since the signature, so a refusal can say what moved. */
async function movedSince(root: string, at: number): Promise<string[]> {
  const moved: string[] = [];
  for (const entry of await packageRoots(root)) {
    await walkTree(
      entry,
      ({ label, info }) => {
        if (!info.isDirectory() && info.mtimeMs > at && moved.length < 5) moved.push(label);
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
