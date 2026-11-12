// SPDX-License-Identifier: EUPL-1.2
/**
 * Which git checkout a project sits in. Parallel sessions are separate
 * worktrees of one repository, so "this checkout" is a worktree: its key
 * stays the same across commands, branch switches and `git worktree move`,
 * and differs between worktrees. It is read from the `.git` entry on disk,
 * without running git.
 */
import { dirname, join, resolve } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { pathInfo, readTextIfExists, realPath } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';

/** The git checkout holding a project. */
export interface Checkout {
  /** Top directory of the working tree, or undefined when the project is not in git. */
  readonly worktree: string | undefined;
  /** This worktree's git directory: `.git`, or `.git/worktrees/<name>` for a linked worktree. */
  readonly gitDir: string | undefined;
  /** The repository's git directory, shared by all its worktrees. */
  readonly commonDir: string | undefined;
  /** Whether the working tree was added with `git worktree add`. */
  readonly linked: boolean;
  /**
   * Stable identity of this checkout (16 hex digits): derived from the
   * worktree's git directory, or from the project root outside git. Use it
   * to recognise "the checkout that used this last".
   */
  readonly key: string;
}

function keyOf(path: string): string {
  return hash(path).slice(0, 16);
}

/** The nearest directory at or above `start` holding a `.git` entry. */
async function findWorktree(
  start: string
): Promise<{ root: string; isDirectory: boolean } | undefined> {
  for (let current = resolve(start); ; current = dirname(current)) {
    const info = await pathInfo(join(current, '.git'));
    if (info !== undefined) return { root: current, isDirectory: info.kind === 'directory' };
    if (dirname(current) === current) return undefined;
  }
}

function brokenCheckout(worktree: string, why: string): FireForgeError {
  return new FireForgeError('checkout-broken', `The git checkout at ${worktree} ${why}`, {
    exitCode: ExitCode.GIT_ERROR,
    hint: 'Run "git worktree repair" in the main checkout.',
  });
}

/**
 * Describes the git checkout a project sits in.
 *
 * @param projectRoot - The project directory
 * @throws `checkout-broken` (exit code 4) when a `.git` file points nowhere
 */
export async function readCheckout(projectRoot: string): Promise<Checkout> {
  const found = await findWorktree(projectRoot);
  if (found === undefined) {
    const key = keyOf(await realPath(projectRoot));
    return { worktree: undefined, gitDir: undefined, commonDir: undefined, linked: false, key };
  }
  const dotGit = join(found.root, '.git');
  if (found.isDirectory) {
    const gitDir = await realPath(dotGit);
    return { worktree: found.root, gitDir, commonDir: gitDir, linked: false, key: keyOf(gitDir) };
  }
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readTextIfExists(dotGit)) ?? '')?.[1];
  if (pointer === undefined)
    throw brokenCheckout(found.root, 'has a .git file without a gitdir line');
  const target = resolve(found.root, pointer);
  if ((await pathInfo(target))?.kind !== 'directory') {
    throw brokenCheckout(found.root, `points at ${target}, which does not exist`);
  }
  const gitDir = await realPath(target);
  const common = (await readTextIfExists(join(gitDir, 'commondir')))?.trim();
  const commonDir = common === undefined ? gitDir : await realPath(resolve(gitDir, common));
  return {
    worktree: found.root,
    gitDir,
    commonDir,
    linked: common !== undefined,
    key: keyOf(gitDir),
  };
}
