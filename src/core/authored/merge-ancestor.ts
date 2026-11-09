// SPDX-License-Identifier: EUPL-1.2
/**
 * Which commit Git took a merge driver's ancestor from. Git hands a driver an empty ancestor file
 * both for a path missing from the ancestor and for a committed empty file, so the driver needs the
 * commit to tell them apart. Every answer here names one commit or none; none keeps Git's conflict.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sourceGitStatus } from './git.js';

const ABBREVIATED_ID = '[0-9a-f]{4,64}';

async function resolveCommit(projectRoot: string, name: string): Promise<string | undefined> {
  const result = await sourceGitStatus(projectRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${name}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.toString('utf8').trim() : undefined;
}

/** The single parent of `name`; a root or merge commit has no single one. */
async function parentOf(projectRoot: string, name: string): Promise<string | undefined> {
  const child = await resolveCommit(projectRoot, name);
  if (child === undefined) return undefined;
  const listed = await sourceGitStatus(projectRoot, ['rev-list', '--parents', '-n', '1', child]);
  if (listed.code !== 0) return undefined;
  const parents = listed.stdout.toString('utf8').trim().split(' ').slice(1);
  // A merge commit picked with `-m` has its ancestor on a parent nothing here names.
  return parents.length === 1 ? parents[0] : undefined;
}

/** The merge base of HEAD and `other`, when there is exactly one. */
async function mergeBaseWith(projectRoot: string, other: string): Promise<string | undefined> {
  const result = await sourceGitStatus(projectRoot, ['merge-base', '--all', 'HEAD', other]);
  if (result.code !== 0) return undefined;
  const bases = result.stdout.toString('utf8').split('\n').filter(Boolean);
  return bases.length === 1 ? bases[0] : undefined;
}

/**
 * The ancestor commit named by Git's `%S` label: an abbreviated id for a merge with one merge base,
 * `parent of <id> (<subject>)` for a cherry-pick or rebase step, `<id> (<subject>)` for a revert.
 * Other labels (several merge bases, `git am -3`, stash) and an unexpanded `%S` name none.
 */
async function labelledAncestor(
  projectRoot: string,
  label: string | undefined
): Promise<string | undefined> {
  if (label === undefined) return undefined;
  if (new RegExp(`^${ABBREVIATED_ID}$`, 'u').test(label)) return resolveCommit(projectRoot, label);
  const picked = new RegExp(`^parent of (${ABBREVIATED_ID}) `, 'u').exec(label)?.[1];
  if (picked !== undefined) return parentOf(projectRoot, picked);
  const reverted = new RegExp(`^(${ABBREVIATED_ID}) \\(`, 'u').exec(label)?.[1];
  return reverted === undefined ? undefined : resolveCommit(projectRoot, reverted);
}

/** One per-worktree state file, through `--git-path` so linked worktrees resolve their own. */
async function readStateFile(projectRoot: string, name: string): Promise<string | undefined> {
  const located = await sourceGitStatus(projectRoot, ['rev-parse', '--git-path', name]);
  if (located.code !== 0) return undefined;
  const path = resolve(projectRoot, located.stdout.toString('utf8').trim());
  return readFile(path, 'utf8').catch(() => undefined);
}

/** The first or last command line of a todo list, ignoring comments and blank lines. */
function todoCommand(
  raw: string,
  which: 'first' | 'last'
): { verb: string; id: string } | undefined {
  const commands = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const line = which === 'first' ? commands[0] : commands.at(-1);
  const match = line && new RegExp(`^(\\w+)\\s+(${ABBREVIATED_ID})\\b`, 'u').exec(line);
  return match?.[1] && match[2] ? { verb: match[1], id: match[2] } : undefined;
}

const PICKING_VERBS = new Set([
  'pick',
  'p',
  'reword',
  'r',
  'edit',
  'e',
  'fixup',
  'f',
  'squash',
  's',
]);

/**
 * The ancestor commit read from the operation in progress, for a Git that does not pass `%S`:
 * - `git merge` names each merged head in a `GITHEAD_<id>` variable; one head with one merge base;
 * - a rebase step is the last command in `rebase-merge/done`, or `rebase-apply`'s original commit;
 * - a cherry-pick or revert of several commits is the first command in `sequencer/todo`;
 * - `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD` where an operation has written them.
 * A single-commit cherry-pick or revert leaves no such state while its merge runs, and names none.
 */
async function operationAncestor(projectRoot: string): Promise<string | undefined> {
  const heads = Object.keys(process.env)
    .filter((key) => /^GITHEAD_[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(key))
    .map((key) => key.slice('GITHEAD_'.length));
  if (heads.length > 0)
    return heads.length === 1 ? mergeBaseWith(projectRoot, heads[0] ?? '') : undefined;
  const mergeHeads = (await readStateFile(projectRoot, 'MERGE_HEAD'))?.split('\n').filter(Boolean);
  if (mergeHeads !== undefined && mergeHeads.length > 0)
    return mergeHeads.length === 1 ? mergeBaseWith(projectRoot, mergeHeads[0] ?? '') : undefined;
  const done = await readStateFile(projectRoot, 'rebase-merge/done');
  if (done !== undefined) {
    const step = todoCommand(done, 'last');
    return step && PICKING_VERBS.has(step.verb) ? parentOf(projectRoot, step.id) : undefined;
  }
  if ((await readStateFile(projectRoot, 'rebase-apply/rebasing')) !== undefined) {
    const original = (await readStateFile(projectRoot, 'rebase-apply/original-commit'))?.trim();
    return original ? parentOf(projectRoot, original) : undefined;
  }
  const todo = await readStateFile(projectRoot, 'sequencer/todo');
  if (todo !== undefined) {
    const step = todoCommand(todo, 'first');
    if (step?.verb === 'revert') return resolveCommit(projectRoot, step.id);
    return step && PICKING_VERBS.has(step.verb) ? parentOf(projectRoot, step.id) : undefined;
  }
  const picked = (await readStateFile(projectRoot, 'CHERRY_PICK_HEAD'))?.trim();
  if (picked) return parentOf(projectRoot, picked);
  const reverted = (await readStateFile(projectRoot, 'REVERT_HEAD'))?.trim();
  return reverted ? resolveCommit(projectRoot, reverted) : undefined;
}

/**
 * Whether `path` is absent from the commit Git took the ancestor from: the `%S` label when it names
 * one, else the operation in progress. Undefined when no single commit is identified, or when the
 * tree cannot be listed; only a listing that succeeds and names nothing proves the path absent.
 */
export async function ancestorAbsent(
  projectRoot: string,
  path: string,
  label: string | undefined
): Promise<boolean | undefined> {
  const commit =
    (await labelledAncestor(projectRoot, label)) ?? (await operationAncestor(projectRoot));
  if (commit === undefined) return undefined;
  const entry = await sourceGitStatus(projectRoot, ['ls-tree', '--full-tree', commit, '--', path]);
  if (entry.code !== 0) return undefined;
  return entry.stdout.length === 0;
}
