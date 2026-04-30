// SPDX-License-Identifier: EUPL-1.2
import { GitError, GitNotFoundError } from '../errors/git.js';
import { exec, executableExists } from '../utils/process.js';

/**
 * Environment variable that overrides the monolithic `git add -A` timeout
 * (milliseconds). 2026-04-24 eval Finding 10: operators on slow or loaded
 * filesystems legitimately exceeded the 10-minute default during a
 * 140.10.0esr baseline indexing pass; making the cap overridable lets
 * them retry without recompiling.
 */
export const GIT_ADD_TIMEOUT_ENV_VAR = 'FIREFORGE_GIT_ADD_TIMEOUT_MS';

/**
 * Environment variable that overrides the per-chunk `git add -- <dir>`
 * timeout (milliseconds). Paired with {@link GIT_ADD_TIMEOUT_ENV_VAR} so
 * both the monolithic attempt and the chunked fallback can be extended.
 */
export const GIT_ADD_CHUNK_TIMEOUT_ENV_VAR = 'FIREFORGE_GIT_ADD_CHUNK_TIMEOUT_MS';

/** Default timeout for `git add -A` on large trees (10 minutes). */
const DEFAULT_GIT_ADD_TIMEOUT_MS = 10 * 60_000;

/** Default timeout for chunked `git add` per top-level directory (30 minutes). */
const DEFAULT_GIT_ADD_CHUNK_TIMEOUT_MS = 30 * 60_000;

function resolveTimeoutFromEnv(envVar: string, fallbackMs: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.length === 0) return fallbackMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

/**
 * Resolved timeout for monolithic `git add -A`. Prefers
 * {@link GIT_ADD_TIMEOUT_ENV_VAR} when present (and a positive
 * integer) so operators on slow hosts can extend the default without
 * rebuilding FireForge.
 */
export const GIT_ADD_TIMEOUT_MS: number = resolveTimeoutFromEnv(
  GIT_ADD_TIMEOUT_ENV_VAR,
  DEFAULT_GIT_ADD_TIMEOUT_MS
);

/**
 * Resolved timeout for each chunk of the chunked fallback path. Grew
 * from 20 to 30 minutes in 0.18.1 because the fallback is already the
 * last line of defence before aborting — erring on the side of "complete
 * the indexing" over "fail fast" matches the real-world recovery
 * workflow.
 */
export const GIT_ADD_CHUNK_TIMEOUT_MS: number = resolveTimeoutFromEnv(
  GIT_ADD_CHUNK_TIMEOUT_ENV_VAR,
  DEFAULT_GIT_ADD_CHUNK_TIMEOUT_MS
);

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
