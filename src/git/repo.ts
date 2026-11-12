// SPDX-License-Identifier: EUPL-1.2
/** Repositories as a whole: creating and copying them, revisions, configuration, worktrees. */
import { dirname, resolve } from 'node:path';

import { ensureDir, exists } from '../kernel/fs.js';
import { git, gitBytes, gitFailure, gitResult, nulFields } from './run.js';

/**
 * Whether `directory` is itself a repository: a checkout's top level or a
 * bare repository. A subdirectory of a checkout is not.
 *
 * @param directory - The directory
 */
export async function isRepository(directory: string): Promise<boolean> {
  if (!(await exists(directory))) return false;
  return (await gitResult(['rev-parse', '--git-dir'], { cwd: directory })).exitCode === 0;
}

/** How {@link initRepository} creates a repository. */
export interface InitOptions {
  bare?: boolean;
  /** Default `sha1`. */
  objectFormat?: 'sha1' | 'sha256';
  /** The unborn branch HEAD names. Default `main`. */
  branch?: string;
}

/**
 * Creates an empty repository, and the directory if needed.
 *
 * @param directory - Where
 * @param options - See {@link InitOptions}
 */
export async function initRepository(directory: string, options: InitOptions = {}): Promise<void> {
  await ensureDir(directory);
  await git(
    [
      'init',
      '--quiet',
      ...(options.bare === true ? ['--bare'] : []),
      `--object-format=${options.objectFormat ?? 'sha1'}`,
      `--initial-branch=${options.branch ?? 'main'}`,
    ],
    { cwd: directory }
  );
}

/**
 * Clones a local repository. With `shared`, the clone borrows the source's
 * objects instead of copying them (`git clone --shared`), so it costs
 * almost nothing but must not outlive the source.
 *
 * @param source - The repository to clone
 * @param target - The new repository's directory; must not exist or be empty
 * @param options - `shared`, and `bare` for a clone without a worktree
 */
export async function cloneRepository(
  source: string,
  target: string,
  options: { shared?: boolean; bare?: boolean } = {}
): Promise<void> {
  await ensureDir(dirname(target));
  await git(
    [
      'clone',
      '--quiet',
      ...(options.shared === true ? ['--shared'] : []),
      ...(options.bare === true ? ['--bare'] : []),
      '--',
      source,
      target,
    ],
    { cwd: dirname(target) }
  );
}

/**
 * Fetches one commit and what it needs from another repository, without tags.
 * Point a ref at it afterwards ({@link updateRef}) or it may be collected.
 *
 * @param cwd - The receiving repository
 * @param source - A path or URL of the repository holding `commit`
 * @param commit - The full commit id
 * @param options - `depth` limits history (1: the commit alone)
 */
export async function fetchCommit(
  cwd: string,
  source: string,
  commit: string,
  options: { depth?: number } = {}
): Promise<void> {
  await git(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      ...(options.depth === undefined ? [] : [`--depth=${options.depth}`]),
      '--',
      source,
      commit,
    ],
    { cwd }
  );
}

/**
 * Resolves a revision to a full object id.
 *
 * @param cwd - The repository
 * @param revision - Any revision (`HEAD`, a ref, an id, `rev:path`)
 * @param type - Peel to this type (`HEAD` → its tree with `tree`); not for a `rev:path`
 * @returns The id, or undefined when the revision does not resolve (an unborn
 *   HEAD, a missing ref, a path absent at that revision)
 */
export async function resolveRevision(
  cwd: string,
  revision: string,
  type?: 'commit' | 'tree' | 'blob'
): Promise<string | undefined> {
  const spec = type === undefined ? revision : `${revision}^{${type}}`;
  const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', spec];
  const result = await gitResult(args, { cwd });
  if (result.exitCode === 0) return result.stdout.toString('utf8').trim();
  if (result.exitCode === 1) return undefined;
  throw gitFailure(args, result, cwd);
}

/**
 * The branch HEAD is on, or undefined when HEAD is detached.
 *
 * @param cwd - The repository
 */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const args = ['symbolic-ref', '--quiet', '--short', 'HEAD'];
  const result = await gitResult(args, { cwd });
  if (result.exitCode === 0) return result.stdout.toString('utf8').trim();
  if (result.exitCode === 1) return undefined;
  throw gitFailure(args, result, cwd);
}

/**
 * The best common ancestor of two commits, or undefined when they share none.
 *
 * @param cwd - The repository
 * @param a - A commit
 * @param b - A commit
 */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const args = ['merge-base', a, b];
  const result = await gitResult(args, { cwd });
  if (result.exitCode === 0) return result.stdout.toString('utf8').trim();
  if (result.exitCode === 1) return undefined;
  throw gitFailure(args, result, cwd);
}

/**
 * Whether `ancestor` is `descendant` or one of its ancestors.
 *
 * @param cwd - The repository
 * @param ancestor - A commit
 * @param descendant - A commit
 */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = await gitResult(args, { cwd });
  if (result.exitCode === 0 || result.exitCode === 1) return result.exitCode === 0;
  throw gitFailure(args, result, cwd);
}

/**
 * The repository's object format, which fixes the length of its ids.
 *
 * @param cwd - The repository
 */
export async function objectFormat(cwd: string): Promise<'sha1' | 'sha256'> {
  const format = (await git(['rev-parse', '--show-object-format'], { cwd })).trim();
  return format === 'sha256' ? 'sha256' : 'sha1';
}

/**
 * The absolute path of the repository's git directory, or with `common` of
 * the directory a linked worktree shares with its main checkout.
 *
 * @param cwd - The repository
 * @param options - `common`
 */
export async function gitDir(cwd: string, options: { common?: boolean } = {}): Promise<string> {
  const which = options.common === true ? '--git-common-dir' : '--git-dir';
  // Git answers with forward slashes on every platform.
  return resolve((await git(['rev-parse', '--path-format=absolute', which], { cwd })).trim());
}

/**
 * Reads a setting from the repository's own configuration file.
 *
 * @param cwd - The repository
 * @param key - The key (`merge.fireforge.driver`)
 * @returns Its value, or undefined when unset
 */
export async function getConfig(cwd: string, key: string): Promise<string | undefined> {
  const args = ['config', '--local', '--get', key];
  const result = await gitResult(args, { cwd });
  if (result.exitCode === 0) return result.stdout.toString('utf8').replace(/\n$/, '');
  if (result.exitCode === 1) return undefined;
  throw gitFailure(args, result, cwd);
}

/**
 * Writes or removes a setting in the repository's own configuration file.
 *
 * @param cwd - The repository
 * @param key - The key
 * @param value - The value, or undefined to remove every value of the key
 */
export async function setConfig(
  cwd: string,
  key: string,
  value: string | undefined
): Promise<void> {
  if (value !== undefined) {
    await git(['config', '--local', key, value], { cwd });
    return;
  }
  const args = ['config', '--local', '--unset-all', key];
  const result = await gitResult(args, { cwd });
  // 5: the key was not set, which is the state asked for.
  if (result.exitCode !== 0 && result.exitCode !== 5) throw gitFailure(args, result, cwd);
}

/** One worktree of a repository. */
export interface Worktree {
  path: string;
  /** The checked-out commit; absent for a bare repository or an unborn branch. */
  head?: string;
  /** The full ref of the checked-out branch; absent when detached. */
  branch?: string;
  bare: boolean;
  locked: boolean;
  /** Its directory is gone; `git worktree prune` would remove it. */
  prunable: boolean;
}

/**
 * The repository's worktrees, the main one first.
 *
 * @param cwd - The repository or any of its worktrees
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const fields = nulFields(await gitBytes(['worktree', 'list', '--porcelain', '-z'], { cwd }));
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const field of fields) {
    const [key = '', value = ''] = field.split(/ (.*)/s);
    if (key === 'worktree') {
      current = { path: resolve(value), bare: false, locked: false, prunable: false };
      worktrees.push(current);
    } else if (current === undefined) continue;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  return worktrees;
}
