// SPDX-License-Identifier: EUPL-1.2
import { GitError, GitNotFoundError } from '../errors/git.js';
import { exec, executableExists } from '../utils/process.js';

/** Default timeout for `git add -A` on large trees (10 minutes). */
export const GIT_ADD_TIMEOUT_MS = 10 * 60_000;

/** Timeout for chunked `git add` per top-level directory (20 minutes). */
export const GIT_ADD_CHUNK_TIMEOUT_MS = 20 * 60_000;

/**
 * Structured git status entry derived from `git status --porcelain=v1 -z`.
 */
export interface GitStatusEntry {
  /** Two-character XY status as reported by porcelain output. */
  status: string;
  /** Index status character. */
  indexStatus: string;
  /** Worktree status character. */
  worktreeStatus: string;
  /** Canonical current path for the entry. */
  file: string;
  /** Original path for rename/copy entries. */
  originalPath?: string | undefined;
  /** True when the entry is an untracked path. */
  isUntracked: boolean;
  /** True when the entry represents a rename or copy. */
  isRenameOrCopy: boolean;
  /** True when the entry represents a deletion in either index or worktree. */
  isDeleted: boolean;
}

/**
 * Ensures git is available in the system.
 * @throws GitNotFoundError if git is not installed
 */
export async function ensureGit(): Promise<void> {
  if (!(await executableExists('git'))) {
    throw new GitNotFoundError();
  }
}

/**
 * Runs a git command in the specified directory.
 * @param args - Git command arguments
 * @param cwd - Working directory
 * @returns Command output
 */
export async function git(
  args: string[],
  cwd: string,
  options?: { timeout?: number; env?: Record<string, string> }
): Promise<string> {
  const execOptions: Parameters<typeof exec>[2] = { cwd };
  if (options?.timeout !== undefined) {
    execOptions.timeout = options.timeout;
  }
  if (options?.env !== undefined) {
    execOptions.env = options.env;
  }
  const result = await exec('git', args, execOptions);

  if (result.exitCode !== 0) {
    throw new GitError(result.stderr.trim() || 'Git command failed', args.join(' '));
  }

  return result.stdout;
}

/**
 * Configures git performance settings for large trees.
 * Enables index preloading, untracked cache, and the manyFiles feature
 * flag which significantly reduces `git add` / `git status` time on
 * repositories with hundreds of thousands of files.
 */
export async function configureGitPerformance(repoDir: string): Promise<void> {
  await git(['config', 'core.preloadindex', 'true'], repoDir);
  await git(['config', 'core.untrackedCache', 'true'], repoDir);
  // Explicitly disable fsmonitor to avoid daemon issues on freshly-created repos
  await git(['config', 'core.fsmonitor', 'false'], repoDir);
  await git(['config', 'feature.manyFiles', 'true'], repoDir);
}
