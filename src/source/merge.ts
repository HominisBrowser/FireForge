// SPDX-License-Identifier: EUPL-1.2
/**
 * The merge driver for owned files. Two branches that each first-touch one
 * upstream file add it on both sides with no common ancestor in the
 * project's history, so git sees an add/add conflict over the whole file.
 * `<sourceRoot>/.gitattributes` routes owned files through this driver,
 * which merges them against the pristine blob the override record names.
 *
 * Git hands a driver an empty ancestor both for a path missing from the
 * ancestor and for a committed empty file, so the driver asks which commit
 * git took the ancestor from (the `%S` label, Git 2.44 and later) and uses
 * the pristine blob only when that commit lacks the path. When no single
 * commit is named (several merge bases, `git am -3`, a stash, an older Git)
 * the driver merges the empty ancestor as given, which is git's own add/add
 * conflict.
 */
import { join, relative } from 'node:path';

import {
  getConfig,
  git,
  listTree,
  mergeFile,
  readBlobs,
  resolveRevision,
  setConfig,
} from '../git/index.js';
import { toError } from '../kernel/errors.js';
import { readBytes, toPosixPath, writeFile } from '../kernel/fs.js';
import { parseJson } from '../kernel/json.js';
import { warn } from '../kernel/log.js';
import type { SourceProject } from '../project/index.js';
import { readPristineBlobs } from './objects.js';
import { overrideRecordSchema, type Pristine } from './records.js';
import { layoutOf, recordFile } from './tree.js';

/** The driver's name in `.gitattributes` and git configuration. */
export const MERGE_DRIVER = 'fireforge';

/** The oldest Git that passes the ancestor label `%S` to a merge driver. */
const LABEL_GIT = [2, 44] as const;

const ABBREVIATED_ID = '[0-9a-f]{4,64}';

/** The labels conflict markers carry. */
export interface MergeLabels {
  readonly ours: string;
  readonly base: string;
  readonly theirs: string;
}

/** The outcome of a three-way content merge. */
export type ContentMerge =
  | { readonly clean: true; readonly content: Buffer }
  /** `markers` holds the text merge with conflict markers; absent for binary content. */
  | { readonly clean: false; readonly reason: 'content' | 'binary'; readonly markers?: Buffer };

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Three-way merges content. A side equal to the base yields the other side;
 * text merges line by line; competing binary edits conflict without markers.
 *
 * @param cwd - A repository whose configuration applies to `git merge-file`
 * @param sides - The base and the two sides
 * @param labels - Names for the conflict markers
 */
export async function mergeContent(
  cwd: string,
  sides: { base: Buffer; ours: Buffer; theirs: Buffer },
  labels: MergeLabels
): Promise<ContentMerge> {
  const { base, ours, theirs } = sides;
  if (ours.equals(theirs) || theirs.equals(base)) return { clean: true, content: ours };
  if (ours.equals(base)) return { clean: true, content: theirs };
  if (![base, ours, theirs].every(isText)) return { clean: false, reason: 'binary' };
  const merged = await mergeFile(cwd, sides, labels);
  return merged.conflicts === 0
    ? { clean: true, content: merged.content }
    : { clean: false, reason: 'content', markers: merged.content };
}

/**
 * Whether the git on PATH passes the ancestor label to merge drivers.
 *
 * @param cwd - Any directory git can run in
 */
async function gitPassesAncestorLabel(cwd: string): Promise<boolean> {
  const version = /(\d+)\.(\d+)/.exec(await git(['--version'], { cwd }));
  const [major, minor] = [Number(version?.[1] ?? 0), Number(version?.[2] ?? 0)];
  return major > LABEL_GIT[0] || (major === LABEL_GIT[0] && minor >= LABEL_GIT[1]);
}

/**
 * The shell program git runs as the driver. It finds FireForge where the
 * project installs it (`<project>/node_modules/.bin/fireforge`, in this
 * worktree or else in the main one), else on PATH, so moving or upgrading
 * the tool never leaves a stale path behind.
 * Whatever goes wrong in FireForge, the merge still ends as a conflict with
 * both sides in it: when the driver fails without writing a result, git's
 * own text merge writes the conflict markers instead.
 */
const DRIVER_SCRIPT = [
  'd=${1:-.}',
  'shift',
  'f=$d/node_modules/.bin/fireforge',
  '[ -x "$f" ] || f=$(git rev-parse --path-format=absolute --git-common-dir)/../$d/node_modules/.bin/fireforge',
  '[ -x "$f" ] || f=fireforge',
  'cp "$2" "$2.fireforge-ours" || exit 1',
  '"$f" merge-driver run "$@"',
  's=$?',
  'if [ $s -ne 0 ] && cmp -s "$2" "$2.fireforge-ours"; then git merge-file -L ours -L base -L theirs "$2" "$1" "$3"; fi',
  'rm -f "$2.fireforge-ours"',
  '[ $s -eq 0 ]',
].join('; ');

/**
 * The driver command line this FireForge configures for a project.
 *
 * @param project - A source-mode project
 */
export function mergeDriverCommand(project: SourceProject): string {
  const { worktree } = layoutOf(project);
  const dir = toPosixPath(relative(worktree, project.root)) || '.';
  const quoted = `'${dir.replaceAll("'", `'\\''`)}'`;
  return `sh -c '${DRIVER_SCRIPT}' fireforge-merge-driver ${quoted} %O %A %B %P %S`;
}

/** What {@link installMergeDriver} did. */
export interface DriverInstall {
  /** The driver command line as configured. */
  readonly driver: string;
  /** False when the driver was already configured so. */
  readonly changed: boolean;
  /** Whether this git passes the ancestor label; without it first touches conflict. */
  readonly labelSupported: boolean;
}

/**
 * Configures the merge driver in the repository's own configuration, shared
 * by all its worktrees, replacing any other command configured for it.
 *
 * @param project - A source-mode project
 */
export async function installMergeDriver(project: SourceProject): Promise<DriverInstall> {
  const { worktree } = layoutOf(project);
  const key = `merge.${MERGE_DRIVER}.driver`;
  const labelSupported = await gitPassesAncestorLabel(worktree);
  const driver = mergeDriverCommand(project);
  if ((await getConfig(worktree, key)) === driver) {
    return { driver, changed: false, labelSupported };
  }
  await setConfig(worktree, `merge.${MERGE_DRIVER}.name`, 'FireForge owned source');
  await setConfig(worktree, key, driver);
  return { driver, changed: true, labelSupported };
}

/** The commit `name` resolves to, or undefined. */
async function commitOf(worktree: string, name: string): Promise<string | undefined> {
  return resolveRevision(worktree, name, 'commit').catch(() => undefined);
}

/** The single parent of a commit; a root or merge commit has none. */
async function parentOf(worktree: string, name: string): Promise<string | undefined> {
  const child = await commitOf(worktree, name);
  if (child === undefined) return undefined;
  const parents = (await git(['rev-list', '--parents', '-n', '1', child], { cwd: worktree }))
    .trim()
    .split(' ')
    .slice(1);
  return parents.length === 1 ? parents[0] : undefined;
}

/**
 * The ancestor commit named by git's `%S` label: an abbreviated id for a
 * merge with one merge base, `parent of <id> (<subject>)` for a cherry-pick
 * or rebase step, `<id> (<subject>)` for a revert. Other labels name none.
 */
async function labelledAncestor(worktree: string, label: string): Promise<string | undefined> {
  if (new RegExp(`^${ABBREVIATED_ID}$`).test(label)) return commitOf(worktree, label);
  const picked = new RegExp(`^parent of (${ABBREVIATED_ID}) `).exec(label)?.[1];
  if (picked !== undefined) return parentOf(worktree, picked);
  const reverted = new RegExp(`^(${ABBREVIATED_ID}) \\(`).exec(label)?.[1];
  return reverted === undefined ? undefined : commitOf(worktree, reverted);
}

/**
 * Whether `path` is absent from the commit git's `%S` label names.
 * Undefined when the label names no single commit or the tree cannot be read.
 *
 * @param worktree - The checkout's top directory
 * @param path - Worktree-relative path
 * @param label - Git's `%S`
 */
export async function ancestorAbsent(
  worktree: string,
  path: string,
  label: string
): Promise<boolean | undefined> {
  const commit = await labelledAncestor(worktree, label);
  if (commit === undefined) return undefined;
  try {
    return (await listTree(worktree, commit, { paths: [path], recursive: false })).length === 0;
  } catch {
    return undefined;
  }
}

/** The pristine bytes a first touch of an owned file started from, per the record at HEAD. */
async function firstTouchBase(
  project: SourceProject,
  pristine: Pristine,
  path: string
): Promise<Buffer | undefined> {
  const layout = layoutOf(project);
  if (!path.startsWith(`${layout.source}/`)) return undefined;
  const enginePath = path.slice(layout.source.length + 1);
  const spec = `HEAD:${recordFile(layout, enginePath)}`;
  const raw = (await readBlobs(layout.worktree, [spec])).get(spec);
  if (raw === undefined) return undefined;
  const record = overrideRecordSchema.parse(parseJson(raw.toString('utf8'), { source: spec }), {
    source: spec,
  });
  const [entry] = await listTree(pristine.repo, pristine.commit, {
    paths: [enginePath],
    recursive: false,
  });
  if (
    record.base.commit !== pristine.commit ||
    entry?.oid !== record.base.blob ||
    entry.mode !== record.base.mode
  ) {
    throw new Error(`the override record of ${enginePath} is not at the pinned upstream file`);
  }
  return (await readPristineBlobs(pristine, [entry.oid])).get(entry.oid);
}

/** The files and label git passes a merge driver. */
export interface DriverInput {
  /** `%O`: the ancestor's content. */
  readonly base: string;
  /** `%A`: our content; receives the result. */
  readonly ours: string;
  /** `%B`: their content. */
  readonly theirs: string;
  /** `%P`: the worktree-relative path being merged. */
  readonly path: string;
  /** `%S`: the ancestor's label; absent or unexpanded on Git before 2.44. */
  readonly label?: string;
}

/**
 * Merges one owned file as git's merge driver, leaving the result in the
 * `ours` file.
 *
 * @param project - The source-mode project the file belongs to
 * @param pristine - Resolves the pinned pristine repository, asked only for a first touch
 * @param input - What git passed
 * @returns True for a clean merge, false for a conflict (the driver's exit status)
 */
export async function runMergeDriver(
  project: SourceProject,
  pristine: () => Promise<Pristine>,
  input: DriverInput
): Promise<boolean> {
  const worktree = layoutOf(project).worktree;
  let ancestor = await readBytes(input.base);
  if (ancestor.length === 0) {
    try {
      const label = input.label ?? '';
      if (label === '' || label === '%S') {
        throw new Error('this git does not pass the ancestor label (Git 2.44 or later does)');
      }
      const absent = await ancestorAbsent(worktree, input.path, label);
      if (absent === undefined) throw new Error(`"${label}" names no single ancestor commit`);
      if (absent)
        ancestor = (await firstTouchBase(project, await pristine(), input.path)) ?? ancestor;
    } catch (error: unknown) {
      warn(
        `No pristine ancestor for ${input.path}: ${toError(error).message}. Merging as add/add.`
      );
    }
  }
  const merged = await mergeContent(
    worktree,
    { base: ancestor, ours: await readBytes(input.ours), theirs: await readBytes(input.theirs) },
    { ours: 'ours', base: 'base', theirs: 'theirs' }
  );
  if (merged.clean) await writeFile(input.ours, merged.content, { durable: false });
  else if (merged.markers !== undefined) {
    await writeFile(input.ours, merged.markers, { durable: false });
  }
  return merged.clean;
}

/** The attributes the source root needs: exact bytes, and this driver. */
const SOURCE_ATTRIBUTES = ['* -text', `* merge=${MERGE_DRIVER}`];

/**
 * The source root's `.gitattributes` with every line of
 * {@link SOURCE_ATTRIBUTES} present, or undefined when it already has them.
 *
 * @param current - The file's text, or undefined when absent
 */
export function completedAttributes(current: string | undefined): string | undefined {
  const lines = (current ?? '').split('\n').map((line) => line.trim());
  const missing = SOURCE_ATTRIBUTES.filter((line) => !lines.includes(line));
  if (missing.length === 0) return undefined;
  const text = current ?? '';
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`;
}

/**
 * The absolute path of the source root's `.gitattributes`.
 *
 * @param project - A source-mode project
 */
export function attributesFile(project: SourceProject): string {
  return join(project.paths.source, '.gitattributes');
}
