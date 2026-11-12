// SPDX-License-Identifier: EUPL-1.2
/** The working tree: its status, which files git tracks or ignores, and putting paths back. */
import { chunkPaths, git, gitBytes, gitFailure, gitResult, listPaths, nulFields } from './run.js';

/** One `git status` entry. */
export interface StatusEntry {
  path: string;
  /** Index column of `git status --porcelain`: ` ` `M` `A` `D` `T` `U`, or `?` for untracked. */
  index: string;
  /** Worktree column, same letters. */
  worktree: string;
}

/**
 * The working tree's changes against HEAD, rename detection off, untracked
 * files listed one by one rather than as directories.
 *
 * @param cwd - The repository
 * @param options - `paths` limits the report; `untracked: false` leaves untracked files out
 */
export async function status(
  cwd: string,
  options: { paths?: readonly string[]; untracked?: boolean } = {}
): Promise<StatusEntry[]> {
  const args = [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    `--untracked-files=${options.untracked === false ? 'no' : 'all'}`,
  ];
  const records = await listPaths(args, options.paths, { cwd });
  const entries = new Map<string, StatusEntry>();
  for (const record of records) {
    if (record.length < 4) continue;
    const entry = { path: record.slice(3), index: record.charAt(0), worktree: record.charAt(1) };
    entries.set(entry.path, entry);
  }
  return [...entries.values()];
}

/** Which files {@link listFiles} lists. */
export type FileSet = 'tracked' | 'untracked' | 'ignored';

const FILE_SET_ARGS: Readonly<Record<FileSet, readonly string[]>> = {
  tracked: ['--cached'],
  untracked: ['--others', '--exclude-standard'],
  ignored: ['--others', '--ignored', '--exclude-standard'],
};

/**
 * Lists files under `paths` (or the whole repository): tracked in the index,
 * untracked and not ignored, or untracked and ignored.
 *
 * @param cwd - The repository
 * @param options - `which` (default `tracked`) and `paths`
 */
export async function listFiles(
  cwd: string,
  options: { which?: FileSet; paths?: readonly string[] } = {}
): Promise<string[]> {
  const args = ['ls-files', '-z', ...FILE_SET_ARGS[options.which ?? 'tracked']];
  return (await listPaths(args, options.paths, { cwd })).sort();
}

/**
 * Whether git tracks exactly this file (a directory is not tracked).
 *
 * @param cwd - The repository
 * @param path - Repository-relative path
 */
export async function isTracked(cwd: string, path: string): Promise<boolean> {
  return nulFields(await gitBytes(['ls-files', '-z', '--cached', '--', path], { cwd })).includes(
    path
  );
}

/**
 * The paths among `paths` that git's ignore rules match. A tracked file is
 * never ignored.
 *
 * @param cwd - The repository
 * @param paths - Repository-relative paths
 */
export async function checkIgnore(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const args = ['check-ignore', '-z', '--stdin'];
  const result = await gitResult(args, {
    cwd,
    input: paths.map((path) => `${path}\0`).join(''),
    // check-ignore reads paths, not pathspecs, and refuses pathspec magic.
    env: { GIT_LITERAL_PATHSPECS: undefined },
  });
  // 1: none of them is ignored.
  if (result.exitCode !== 0 && result.exitCode !== 1) throw gitFailure(args, result, cwd);
  return new Set(nulFields(result.stdout));
}

/**
 * Git attributes of each path: `set`, `unset`, `unspecified` or the value.
 *
 * @param cwd - The repository
 * @param paths - Repository-relative paths
 * @param names - Attribute names (`text`, `eol`, `filter`, `merge`)
 */
export async function checkAttributes(
  cwd: string,
  paths: readonly string[],
  names: readonly string[]
): Promise<Map<string, Readonly<Record<string, string>>>> {
  const attributes = new Map<string, Record<string, string>>();
  if (paths.length === 0 || names.length === 0) return attributes;
  const fields = nulFields(
    await gitBytes(['check-attr', '-z', '--stdin', ...names], {
      cwd,
      input: paths.map((path) => `${path}\0`).join(''),
    })
  );
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] ?? '';
    const row = attributes.get(path) ?? {};
    row[fields[index + 1] ?? ''] = fields[index + 2] ?? '';
    attributes.set(path, row);
  }
  return attributes;
}

/**
 * Puts paths (files or directories) back as they are in `source`, in the
 * index and the working tree. A tracked path that `source` lacks is removed
 * from both. Untracked files are left alone; {@link cleanPaths} removes them.
 *
 * @param cwd - The repository
 * @param paths - Repository-relative paths
 * @param options - `source` (default `HEAD`)
 */
export async function restorePaths(
  cwd: string,
  paths: readonly string[],
  options: { source?: string } = {}
): Promise<void> {
  if (paths.length === 0) return;
  const source = options.source ?? 'HEAD';
  // `restore` refuses a pathspec that matches nothing, so name what exists.
  const known = new Set([
    ...(await listPaths(['ls-tree', '-r', '-z', '--name-only', '--full-tree', source], paths, {
      cwd,
    })),
    ...(await listPaths(['ls-files', '-z', '--cached'], paths, { cwd })),
  ]);
  if (known.size === 0) return;
  await git(
    [
      'restore',
      `--source=${source}`,
      '--staged',
      '--worktree',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ],
    { cwd, input: [...known].map((path) => `${path}\0`).join('') }
  );
}

/**
 * Deletes untracked files and directories under `paths` (or everywhere).
 *
 * @param cwd - The repository
 * @param options - `paths`; `ignored` deletes ignored files too
 */
export async function cleanPaths(
  cwd: string,
  options: { paths?: readonly string[]; ignored?: boolean } = {}
): Promise<void> {
  const args = ['clean', '-f', '-d', '-q', ...(options.ignored === true ? ['-x'] : [])];
  if (options.paths === undefined) {
    await git(args, { cwd });
    return;
  }
  for (const chunk of chunkPaths(options.paths)) await git([...args, '--', ...chunk], { cwd });
}

/**
 * Moves the current branch (or detached HEAD) to `commit` and makes the
 * index match it. `hard` also makes the working tree's tracked files match;
 * otherwise the working tree is untouched.
 *
 * @param cwd - The repository
 * @param commit - Default `HEAD`
 * @param mode - Default `hard`
 */
export async function reset(
  cwd: string,
  commit = 'HEAD',
  mode: 'hard' | 'mixed' = 'hard'
): Promise<void> {
  await git(['reset', '--quiet', `--${mode}`, commit, '--'], { cwd });
}
