// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';

/** One entry of a tree: `label` is its path from the root, with `/` separators. */
export interface TreeEntry {
  path: string;
  label: string;
  info: Stats;
}

/**
 * Every entry under a directory in a stable order, symbolic links unfollowed.
 * The single traversal behind each tree hash, signature and size measure here.
 */
export async function walkTree(
  directory: string,
  visit: (entry: TreeEntry) => Promise<void> | void,
  options: { skip?: (name: string) => boolean; prefix?: string } = {}
): Promise<void> {
  const names = (await readdir(directory))
    .filter((name) => !options.skip?.(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const infos = await Promise.all(names.map((name) => lstat(join(directory, name))));
  for (const [index, name] of names.entries()) {
    const path = join(directory, name);
    const label = options.prefix === undefined ? name : `${options.prefix}/${name}`;
    const info = infos[index];
    if (info === undefined) continue;
    await visit({ path, label, info });
    if (info.isDirectory()) await walkTree(path, visit, { ...options, prefix: label });
  }
}

/** Whether a path is one of these roots or inside one. */
export function withinRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

const fileDigests = new Map<string, { stamp: string; digest: string }>();

/**
 * A file's SHA-256, read again in this process only when its size or times moved.
 * The change time is in the stamp, and nothing can put that back, so this catches
 * what a tree's stat signature does not: a rewrite that restored its mtime. Keyed
 * by inode, so a tool's hard links, which Git's exec path is mostly made of, are
 * read once. A long-lived process asks about the same tools for every job.
 */
export async function fileDigest(path: string, info?: Stats): Promise<string> {
  const known = info ?? (await lstat(path));
  const key = `${String(known.dev)}:${String(known.ino)}`;
  const stamp = `${String(known.size)}:${String(known.mtimeMs)}:${String(known.ctimeMs)}`;
  const recorded = fileDigests.get(key);
  if (recorded?.stamp === stamp) return recorded.digest;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const digest = hash.digest('hex');
  fileDigests.set(key, { stamp, digest });
  return digest;
}

/** What a final gate does before it measures: from here on every file is really read. */
export function forgetFileDigests(): void {
  fileDigests.clear();
}

/**
 * Binds every byte and executable bit under a tool root, from its own root
 * outward, so the same tools hash the same wherever they are installed. Write
 * bits stay out: freezing a tree does not change what it is. A link has to stay
 * inside the root or `aliases`, and hashes as where it points relative to the
 * root. `externalLinks` records a link leaving them instead of refusing it, for a
 * tree the host owns and uses in place.
 */
export async function toolTreeDigest(
  root: string,
  options: { optional?: boolean; aliases?: readonly string[]; externalLinks?: boolean } = {}
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch (error) {
    if (options.optional === true && getNodeErrorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
  const hash = createHash('sha256');
  const aliases = [
    canonical,
    ...(await Promise.all((options.aliases ?? []).map((path) => realpath(path)))),
  ];
  const seen = new Set<string>([canonical]);
  const visit = async ({ path, label, info }: TreeEntry): Promise<void> => {
    hash.update(JSON.stringify([label, info.mode & 0o555]));
    if (info.isSymbolicLink()) {
      const target = await realpath(path).catch((error: unknown) => {
        if (options.externalLinks === true && getNodeErrorCode(error) === 'ENOENT')
          return undefined;
        throw error;
      });
      if (target === undefined || !withinRoots(target, aliases)) {
        if (options.externalLinks !== true)
          throw new Error(`Tool asset alias escapes declared root: ${label}`);
        hash.update(await readlink(path));
        return;
      }
      hash.update(relative(canonical, target));
      const stat = await lstat(target);
      if (stat.isFile()) hash.update(await fileDigest(target, stat));
      else if (stat.isDirectory() && !seen.has(target)) {
        seen.add(target);
        await walkTree(target, visit, { skip: skipGit, prefix: `${label}/@target` });
      }
    } else if (info.isFile()) hash.update(await fileDigest(path, info));
    else if (!info.isDirectory()) throw new Error(`Unsupported tool asset kind: ${resolve(path)}`);
  };
  const top = await lstat(canonical);
  hash.update(JSON.stringify(['', top.mode & 0o555]));
  if (top.isDirectory()) await walkTree(canonical, visit, { skip: skipGit });
  else if (top.isFile()) hash.update(await fileDigest(canonical, top));
  else throw new Error(`Unsupported tool asset kind: ${canonical}`);
  return hash.digest('hex');
}

const skipGit = (name: string): boolean => name === '.git';

/**
 * What a stat pass can tell about a tree without reading it: every entry's name,
 * kind, size, mode and modification time. Reading a frozen tool tree takes
 * minutes and this takes seconds, so jobs compare this and only a qualification
 * or a final gate reads the bytes. `followLinks` also covers what a link reaches,
 * for a digest that reads through links: a linked workspace package can change
 * with nothing under the root moving.
 */
export async function treeStatSignature(
  roots: readonly string[],
  options: { followLinks?: boolean } = {}
): Promise<string> {
  const hash = createHash('sha256');
  const seen = new Set<string>();
  const visitTree = async (directory: string, prefix?: string): Promise<void> => {
    await walkTree(
      directory,
      async ({ path, label, info }) => {
        const link = info.isSymbolicLink() ? await readlink(path) : '';
        hash.update(JSON.stringify([label, info.mode, info.size, Math.floor(info.mtimeMs), link]));
        if (link !== '' && options.followLinks === true) await visitLink(path, label);
      },
      { skip: skipGit, ...(prefix === undefined ? {} : { prefix }) }
    );
  };
  const visitLink = async (path: string, label: string): Promise<void> => {
    const target = await realpath(path).catch(() => undefined);
    if (target === undefined || seen.has(target)) return;
    seen.add(target);
    const info = await stat(target);
    hash.update(
      JSON.stringify([`${label}/@target`, info.mode, info.size, Math.floor(info.mtimeMs)])
    );
    if (info.isDirectory()) await visitTree(target, `${label}/@target`);
  };
  for (const root of [...roots].sort()) {
    const canonical = await realpath(root);
    seen.add(canonical);
    const top = await lstat(canonical);
    hash.update(JSON.stringify([root, top.mode & 0o777, top.size, Math.floor(top.mtimeMs)]));
    if (top.isDirectory()) await visitTree(canonical);
  }
  return hash.digest('hex');
}

/** A regular file's bytes and identity, as every slot check compares them. */
export interface RegularFile {
  bytes: Buffer;
  mode: '100644' | '100755';
  sha256: string;
}

/**
 * Reads a path that has to be a regular file.
 *
 * @throws When it is anything else, naming `label`
 */
export async function readRegularFile(path: string, label: string): Promise<RegularFile> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`${label}: not a regular file`);
  const bytes = await readFile(path);
  return {
    bytes,
    mode: (info.mode & 0o111) !== 0 ? '100755' : '100644',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
