// SPDX-License-Identifier: EUPL-1.2
/**
 * Git objects for the owned changes. Patch bodies are produced by the one
 * diff generator (`git/diff.ts`) from two trees in one repository: the
 * upstream side of every owned path and the owned side. Both live in a
 * private bare repository under the project's state directory, so neither
 * the checkout's repository nor the read-only pristine repository receives
 * an object. The store is a cache; deleting it loses nothing.
 */
import { join } from 'node:path';

import { formatPatch, parsePatch } from '../diff/index.js';
import {
  diffTrees,
  git,
  initRepository,
  objectFormat,
  readBlobs,
  writeBlobs,
  writeTree,
} from '../git/index.js';
import { defined, invariant } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import type { Pristine } from './records.js';
import type { SourceEntry, SourceTree } from './tree.js';

/** A repository's object format. */
export type ObjectFormat = 'sha1' | 'sha256';

/**
 * The git blob id of some bytes, as `git hash-object` computes it.
 *
 * @param bytes - The content
 * @param format - The repository's object format
 */
export function blobId(bytes: Uint8Array, format: ObjectFormat): string {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return hash(Buffer.concat([header, bytes]), format);
}

/**
 * Reads pristine blobs by id.
 *
 * @param pristine - The pristine repository
 * @param blobs - Blob ids
 * @throws An internal error when the repository lacks one
 */
export async function readPristineBlobs(
  pristine: Pristine,
  blobs: readonly string[]
): Promise<Map<string, Buffer>> {
  const found = await readBlobs(pristine.repo, blobs);
  for (const blob of blobs) {
    invariant(found.has(blob), () => `the pristine repository holds blob ${blob}`);
  }
  return found;
}

/**
 * The private object store of a project, created on first use with the
 * pristine repository's object format.
 *
 * @param tree - The source tree whose project and pristine repository to use
 */
async function objectStore(tree: Pick<SourceTree, 'project' | 'pristine'>): Promise<string> {
  const store = join(tree.project.paths.stateDir, 'source', 'objects.git');
  if (!(await exists(join(store, 'HEAD')))) {
    await initRepository(store, {
      bare: true,
      objectFormat: await objectFormat(tree.pristine.repo),
    });
  }
  return store;
}

/**
 * Stores files from disk as blobs, byte for byte.
 *
 * @param store - The repository
 * @param files - Absolute paths
 * @returns Their blob ids, in input order
 */
async function storeFiles(store: string, files: readonly string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const output = await git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
    cwd: store,
    input: `${files.join('\n')}\n`,
  });
  return output.trim().split('\n');
}

/** The two sides of the owned changes as trees in the object store. */
export interface DeltaTrees {
  readonly store: string;
  /** Every owned upstream path at its pristine blob. */
  readonly before: string;
  /** Every owned file at its owned bytes. */
  readonly after: string;
}

/**
 * Writes the upstream and owned sides of entries as two trees.
 *
 * @param tree - The source tree
 * @param entries - The entries to include
 */
export async function writeDeltaTrees(
  tree: SourceTree,
  entries: readonly SourceEntry[]
): Promise<DeltaTrees> {
  const store = await objectStore(tree);
  const upstream = entries.flatMap((entry) =>
    entry.upstream === undefined ? [] : [{ path: entry.path, ...entry.upstream }]
  );
  const contents = await readPristineBlobs(
    tree.pristine,
    upstream.map((entry) => entry.blob)
  );
  const stored = await writeBlobs(
    store,
    upstream.map((entry) =>
      defined(contents.get(entry.blob), () => `the pristine blob of ${entry.path} was read`)
    )
  );
  upstream.forEach((entry, index) => {
    invariant(stored[index] === entry.blob, () => `blob of ${entry.path} stores under its id`);
  });
  const owned = entries.flatMap((entry) =>
    entry.file === undefined ? [] : [{ path: entry.path, ...entry.file }]
  );
  const ids = await storeFiles(
    store,
    owned.map((entry) => entry.absolute)
  );
  const before = await writeTree(
    store,
    upstream.map((entry) => ({ path: entry.path, oid: entry.blob, mode: entry.mode }))
  );
  const after = await writeTree(
    store,
    owned.map((entry, index) => ({ path: entry.path, oid: ids[index] ?? '', mode: entry.mode }))
  );
  return { store, before, after };
}

/**
 * The patch section of every changed path between the two trees, keyed by
 * path, in git's path order. An entry whose owned bytes equal upstream has
 * no section.
 *
 * @param trees - See {@link writeDeltaTrees}
 */
export async function diffSections(trees: DeltaTrees): Promise<Map<string, Buffer>> {
  const patch = parsePatch(await diffTrees(trees.store, trees.before, trees.after));
  return new Map(
    patch.files.map((file) => [file.path, formatPatch({ ...patch, preamble: [], files: [file] })])
  );
}
