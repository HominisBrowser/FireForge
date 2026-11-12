// SPDX-License-Identifier: EUPL-1.2
/**
 * `git apply` and `git merge-file` as primitives. The policy around them
 * (idempotence, the context ladder, conflict handling) belongs to the
 * caller; this file runs one attempt and reports what git said.
 */
import { join } from 'node:path';

import { makeTempDir, remove, writeFile } from '../kernel/fs.js';
import { unquoteC } from '../kernel/text.js';
import { git, gitFailure, gitResult, withPrivateIndex } from './run.js';

/** How {@link apply} applies a patch. */
export interface ApplyOptions {
  /** Only check whether it applies; change nothing. */
  check?: boolean;
  /** Apply it backwards. */
  reverse?: boolean;
  /** Apply the hunks that fit and leave the rest in `<file>.rej` files. */
  reject?: boolean;
  /** Require only this many lines of context to match around each hunk (`-C<n>`). */
  context?: number;
  /** Whitespace errors: git's `--whitespace` action. Default `nowarn`. */
  whitespace?: 'nowarn' | 'warn' | 'fix' | 'error' | 'error-all';
  /**
   * What the patch changes:
   *  - `worktree` (default): the working tree only.
   *  - `index`: the working tree and the index (`--index`).
   *  - `{ tree }`: nothing in the repository; the patch is applied to that
   *    tree-ish in a private index and the result's tree is returned.
   */
  target?: 'worktree' | 'index' | { tree: string };
}

/** A file git could not patch. */
export interface ApplyConflict {
  path: string;
  /** Git's reason (`patch does not apply`, `already exists in working directory`). */
  reason: string;
  /** The line a failed hunk was expected at, when git names it. */
  line?: number;
}

/** What one `git apply` did. */
export interface ApplyResult {
  applied: boolean;
  /** The resulting tree, for a `{ tree }` target that applied. */
  tree?: string;
  conflicts: ApplyConflict[];
  /** Files that received a `.rej` file (with `reject`). */
  rejected: string[];
  stderr: string;
}

const FAILURE_REASON =
  /^error: (.+?): (already exists in (?:working directory|index)|does not exist in index|does not match index|No such file or directory|patch does not apply|wrong type|has type .+)$/;
/** Messages for input that is not a patch git can read: an answer about the patch, not a git failure. */
const UNREADABLE_PATCH =
  /corrupt patch|patch fragment without header|garbage|unrecognized input|No valid patches/;

/**
 * Reads the files git names in `git apply`'s stderr.
 *
 * @param stderr - What git printed
 */
export function parseApplyOutput(stderr: string): Pick<ApplyResult, 'conflicts' | 'rejected'> {
  const conflicts: ApplyConflict[] = [];
  const rejected: string[] = [];
  for (const line of stderr.split('\n')) {
    const failed = /^error: patch failed: (.+):(\d+)$/.exec(line);
    const reason = FAILURE_REASON.exec(line);
    const reject = /^Applying patch (.+) with \d+ rejects?\.\.\.$/.exec(line);
    if (failed)
      conflicts.push({ path: failed[1] ?? '', reason: 'patch failed', line: Number(failed[2]) });
    else if (reason) conflicts.push({ path: reason[1] ?? '', reason: reason[2] ?? '' });
    if (reject?.[1] !== undefined) {
      const name = reject[1];
      rejected.push(name.startsWith('"') ? unquoteC(name).toString('utf8') : name);
    }
  }
  return { conflicts, rejected };
}

function applyArgs(options: ApplyOptions, cached: boolean): string[] {
  return [
    'apply',
    '--allow-empty',
    `--whitespace=${options.whitespace ?? 'nowarn'}`,
    ...(options.check === true ? ['--check'] : []),
    ...(options.reverse === true ? ['--reverse'] : []),
    ...(options.reject === true ? ['--reject'] : []),
    ...(options.context === undefined ? [] : [`-C${options.context}`]),
    ...(cached ? ['--cached'] : options.target === 'index' ? ['--index'] : []),
    '-',
  ];
}

/**
 * Applies a patch once. Not applying is a result (`applied: false`, with the
 * files git named); only a failure to run git at all throws.
 *
 * @param cwd - The repository
 * @param patch - The patch bytes
 * @param options - See {@link ApplyOptions}
 */
export async function apply(
  cwd: string,
  patch: Uint8Array | string,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  const target = options.target;
  const attempt = async (index?: string): Promise<ApplyResult> => {
    const args = applyArgs(options, index !== undefined);
    const result = await gitResult(args, {
      cwd,
      input: patch,
      ...(index !== undefined && { index }),
    });
    if (result.exitCode >= 128 && !UNREADABLE_PATCH.test(result.stderr)) {
      throw gitFailure(args, result, cwd);
    }
    const applied = result.exitCode === 0;
    const tree =
      applied && index !== undefined && options.check !== true
        ? (await git(['write-tree'], { cwd, index })).trim()
        : undefined;
    return {
      applied,
      ...(tree !== undefined && { tree }),
      ...parseApplyOutput(result.stderr),
      stderr: result.stderr,
    };
  };
  return typeof target === 'object' ? withPrivateIndex(cwd, target.tree, attempt) : attempt();
}

/** The three versions {@link mergeFile} merges. */
export interface MergeInput {
  base: Uint8Array;
  ours: Uint8Array;
  theirs: Uint8Array;
}

/**
 * Three-way merges file content (`git merge-file`). Conflicts are marked in
 * the result with the given labels.
 *
 * @param cwd - The repository whose configuration applies
 * @param input - The common ancestor and the two sides
 * @param labels - Names for the conflict markers
 * @returns The merged bytes and how many conflicts they hold
 */
export async function mergeFile(
  cwd: string,
  input: MergeInput,
  labels: { ours: string; base: string; theirs: string } = {
    ours: 'ours',
    base: 'base',
    theirs: 'theirs',
  }
): Promise<{ content: Buffer; conflicts: number }> {
  const directory = await makeTempDir('fireforge-merge-');
  try {
    const files = {
      ours: join(directory, 'ours'),
      base: join(directory, 'base'),
      theirs: join(directory, 'theirs'),
    };
    for (const side of ['ours', 'base', 'theirs'] as const) {
      await writeFile(files[side], input[side], { durable: false });
    }
    const args = [
      'merge-file',
      '-p',
      '-L',
      labels.ours,
      '-L',
      labels.base,
      '-L',
      labels.theirs,
      files.ours,
      files.base,
      files.theirs,
    ];
    const result = await gitResult(args, { cwd });
    // The exit code is the number of conflicts (at most 127); above that, an error.
    if (result.exitCode > 127) throw gitFailure(args, result, cwd);
    return { content: result.stdout, conflicts: result.exitCode };
  } finally {
    await remove(directory);
  }
}
