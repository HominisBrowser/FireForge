// SPDX-License-Identifier: EUPL-1.2
/** Objects: reading and writing blobs, listing and building trees, committing them. */
import { join } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { makeTempDir, pathInfo, remove, writeFile } from '../kernel/fs.js';
import { objectFormat, resolveRevision } from './repo.js';
import { git, gitBytes, listPaths, withPrivateIndex } from './run.js';

/** Git ended its answer before every requested object was accounted for. */
function truncatedBatch(cwd: string, spec: string): FireForgeError {
  return new FireForgeError(
    'git-truncated-output',
    `git cat-file ended its output before answering for ${spec} in ${cwd}.`,
    { exitCode: ExitCode.GIT_ERROR }
  );
}

/** Blob specs per `cat-file --batch` process, which bounds one read's memory. */
const BLOB_BATCH = 500;

/**
 * Reads many blobs through one `git cat-file --batch` per batch.
 *
 * @param cwd - The repository
 * @param specs - Blob ids or `revision:path` specs
 * @returns Content by spec; a spec that names no blob is absent
 */
export async function readBlobs(
  cwd: string,
  specs: readonly string[]
): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  const unique = [...new Set(specs)];
  if (unique.some((spec) => spec.includes('\n'))) {
    throw new FireForgeError('git-invalid-spec', 'A blob spec cannot contain a line break.', {
      exitCode: ExitCode.GIT_ERROR,
    });
  }
  for (let start = 0; start < unique.length; start += BLOB_BATCH) {
    const batch = unique.slice(start, start + BLOB_BATCH);
    const output = await gitBytes(['cat-file', '--batch'], { cwd, input: `${batch.join('\n')}\n` });
    let offset = 0;
    for (const spec of batch) {
      const end = output.indexOf(0x0a, offset);
      if (end === -1) throw truncatedBatch(cwd, spec);
      // `<id> <type> <size>`, or `<spec> missing` / `<spec> ambiguous` with no body.
      const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(output.toString('utf8', offset, end));
      offset = end + 1;
      if (!match) continue;
      const size = Number(match[2]);
      if (offset + size > output.length) throw truncatedBatch(cwd, spec);
      if (match[1] === 'blob') blobs.set(spec, Buffer.from(output.subarray(offset, offset + size)));
      offset += size + 1;
    }
  }
  return blobs;
}

/**
 * Stores bytes as blobs, exactly as given (no filters, no line-ending conversion).
 *
 * @param cwd - The repository
 * @param contents - The blobs' bytes
 * @returns Their ids, in input order
 */
export async function writeBlobs(cwd: string, contents: readonly Uint8Array[]): Promise<string[]> {
  if (contents.length === 0) return [];
  const directory = await makeTempDir('fireforge-blobs-');
  try {
    const files = contents.map((_, index) => join(directory, String(index)));
    for (const [index, file] of files.entries()) {
      await writeFile(file, contents[index] ?? new Uint8Array(), { durable: false });
    }
    const output = await git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      cwd,
      input: `${files.join('\n')}\n`,
    });
    return output.trim().split('\n');
  } finally {
    await remove(directory);
  }
}

/** One entry of a tree listing. */
export interface TreeEntry {
  /** `100644`, `100755`, `120000` (symlink), `040000` (tree), `160000` (submodule). */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  path: string;
}

/**
 * Lists a tree's entries, by default recursively (files only).
 *
 * @param cwd - The repository
 * @param treeish - A tree, commit or ref
 * @param options - `paths` limits the listing; `recursive: false` lists one level
 */
export async function listTree(
  cwd: string,
  treeish: string,
  options: { paths?: readonly string[]; recursive?: boolean } = {}
): Promise<TreeEntry[]> {
  const args = ['ls-tree', '-z', '--full-tree', ...(options.recursive === false ? [] : ['-r'])];
  const records = await listPaths([...args, treeish], options.paths, { cwd });
  return records
    .flatMap((record): TreeEntry[] => {
      const [, mode = '', type, oid = '', path = ''] =
        /^(\d+) (blob|tree|commit) ([0-9a-f]+)\t(.*)$/s.exec(record) ?? [];
      return type === 'blob' || type === 'tree' || type === 'commit'
        ? [{ mode, type, oid, path }]
        : [];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One change {@link writeTree} makes. */
export type TreeEdit =
  | { path: string; content: Uint8Array; mode?: '100644' | '100755' | '120000' }
  | { path: string; oid: string; mode: string }
  | { path: string; remove: true };

/**
 * Writes a tree object: `base` (or nothing) with `edits` applied. Content is
 * stored as given. Built in a private index; nothing in the repository's
 * index or working tree moves.
 *
 * @param cwd - The repository
 * @param edits - Files to add, replace or remove
 * @param base - Tree-ish to start from, or undefined for an empty tree
 * @returns The tree's id
 */
export async function writeTree(
  cwd: string,
  edits: readonly TreeEdit[],
  base?: string
): Promise<string> {
  const contents = edits.flatMap((edit) => ('content' in edit ? [edit.content] : []));
  const oids = await writeBlobs(cwd, contents);
  const zero = '0'.repeat((await objectFormat(cwd)) === 'sha256' ? 64 : 40);
  let next = 0;
  const records = edits.map((edit) => {
    if ('remove' in edit) return `0 ${zero}\t${edit.path}\0`;
    if ('oid' in edit) return `${edit.mode} ${edit.oid}\t${edit.path}\0`;
    return `${edit.mode ?? '100644'} ${oids[next++] ?? ''}\t${edit.path}\0`;
  });
  return withPrivateIndex(cwd, base, async (index) => {
    if (records.length > 0) {
      await git(['update-index', '-z', '--index-info'], { cwd, index, input: records.join('') });
    }
    return (await git(['write-tree'], { cwd, index })).trim();
  });
}

/** What {@link captureWorktree} captures. */
export interface CaptureOptions {
  /** Only these paths (files or directories); default everything. */
  paths?: readonly string[];
  /**
   * Tree-ish whose content stands for everything not captured, and against
   * which changes are found. Default `HEAD` (an empty tree when unborn);
   * `null` for an empty tree.
   */
  base?: string | null;
  /** Capture untracked files that ignore rules match, too. */
  includeIgnored?: boolean;
}

/** The files whose working-tree state differs from `base` under `paths`. */
async function changedFiles(
  cwd: string,
  base: string | undefined,
  options: CaptureOptions
): Promise<string[]> {
  const found = new Set<string>();
  const add = (paths: readonly string[]): void => {
    for (const path of paths) found.add(path);
  };
  const scope = options.paths;
  add(
    base === undefined
      ? await listPaths(['ls-files', '-z', '--cached'], scope, { cwd })
      : await listPaths(['diff', '--name-only', '--no-renames', '-z', base], scope, { cwd })
  );
  const others =
    options.includeIgnored === true ? ['--others'] : ['--others', '--exclude-standard'];
  add(await listPaths(['ls-files', '-z', ...others], scope, { cwd }));
  // A file named outright is captured even when ignore rules match it.
  for (const path of scope ?? []) {
    const kind = (await pathInfo(join(cwd, path)))?.kind;
    if (kind === 'file' || kind === 'symlink') found.add(path);
  }
  return [...found];
}

/**
 * Writes a tree of the working tree's current state: `base` with every
 * changed, added and deleted file under `paths` taken from the working
 * tree. Untracked files are included, ignored ones only when asked or named
 * outright. Built in a private index; the repository's index, HEAD and
 * branches do not move.
 *
 * @param cwd - The repository
 * @param options - See {@link CaptureOptions}
 * @returns The tree's id
 */
export async function captureWorktree(cwd: string, options: CaptureOptions = {}): Promise<string> {
  const base =
    options.base === undefined
      ? await resolveRevision(cwd, 'HEAD', 'tree')
      : (options.base ?? undefined);
  const files = await changedFiles(cwd, base, options);
  return withPrivateIndex(cwd, base, async (index) => {
    if (files.length > 0) {
      await git(['update-index', '--add', '--remove', '-z', '--stdin'], {
        cwd,
        index,
        input: files.map((path) => `${path}\0`).join(''),
      });
    }
    return (await git(['write-tree'], { cwd, index })).trim();
  });
}

/** Who and when a commit records. */
export interface CommitOptions {
  message: string;
  parents?: readonly string[];
  /** Author and committer. Default FireForge <fireforge@localhost>. */
  identity?: { name: string; email: string };
  /**
   * Author and committer date, in any form git reads (`2000-01-01T00:00:00Z`).
   * Default now. With a fixed date and identity, the same tree, parents and
   * message give the same commit id on every host.
   */
  date?: string;
}

/**
 * Creates a commit object for a tree. No ref moves; see {@link updateRef}.
 *
 * @param cwd - The repository
 * @param tree - The tree's id
 * @param options - See {@link CommitOptions}
 * @returns The commit's id
 */
export async function commitTree(
  cwd: string,
  tree: string,
  options: CommitOptions
): Promise<string> {
  const { name, email } = options.identity ?? { name: 'FireForge', email: 'fireforge@localhost' };
  const dated =
    options.date === undefined
      ? {}
      : { GIT_AUTHOR_DATE: options.date, GIT_COMMITTER_DATE: options.date };
  const parents = (options.parents ?? []).flatMap((parent) => ['-p', parent]);
  const output = await git(['commit-tree', tree, ...parents, '-m', options.message], {
    cwd,
    env: {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      ...dated,
    },
  });
  return output.trim();
}

/**
 * The id of the empty tree, written so it exists in the repository.
 *
 * @param cwd - The repository
 */
export async function emptyTree(cwd: string): Promise<string> {
  return (await git(['mktree'], { cwd, input: '' })).trim();
}
