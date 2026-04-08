// SPDX-License-Identifier: EUPL-1.2
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { GitError, GitIndexLockError, PatchApplyError } from '../errors/git.js';
import { toError } from '../utils/errors.js';
import { pathExists, removeFile } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import {
  configureGitPerformance,
  ensureGit,
  git,
  GIT_ADD_CHUNK_TIMEOUT_MS,
  GIT_ADD_TIMEOUT_MS,
} from './git-base.js';
import { getWorkingTreeStatus } from './git-status.js';

export type { GitStatusEntry } from './git-base.js';

// ── Functions that remain in this file ──

/**
 * Checks if a directory is a git repository.
 * @param dir - Directory to check
 * @returns True if the directory is a git repository
 */
export async function isGitRepository(dir: string): Promise<boolean> {
  const gitDir = join(dir, '.git');
  return pathExists(gitDir);
}

/**
 * Ensures the repository has an "origin" remote.
 *
 * Firefox's mach bootstrap and build scripts shell out to
 * `git remote get-url origin` and emit noisy errors when the remote is
 * absent.  This adds a local-only dummy remote so those scripts stay quiet.
 * Nothing is ever fetched from or pushed to this remote.
 *
 * @param dir - Git working directory
 */
export async function ensureOriginRemote(dir: string): Promise<void> {
  const result = await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  if (result.exitCode !== 0) {
    await git(['remote', 'add', 'origin', 'https://github.com/mozilla-firefox/firefox'], dir);
  }
}

// ── Large-tree staging helpers ──

const GIT_ADD_ENV = { GIT_INDEX_THREADS: '0' };

/**
 * Returns true when the error looks like a process killed by the spawn timeout
 * (SIGTERM → exit code 143).
 */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  return /SIGTERM|timed out|exit code 143/i.test(error.message);
}

/**
 * Removes `.git/index.lock` left behind by a killed git process.
 */
async function cleanupIndexLock(dir: string): Promise<void> {
  const lockPath = join(dir, '.git', 'index.lock');
  if (await pathExists(lockPath)) {
    await removeFile(lockPath);
    verbose('Cleaned up stale .git/index.lock after timeout');
  }
}

/**
 * Stages every file by walking top-level directories one at a time.
 * This avoids a single monolithic `git add -A` that may time out on
 * very large (~300 K file) trees like Firefox.
 */
async function stageAllFilesChunked(
  dir: string,
  options: { onProgress?: (message: string) => void } = {}
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const directories = entries
    .filter((e) => e.isDirectory() && e.name !== '.git')
    .map((e) => e.name)
    .sort();

  for (const dirName of directories) {
    options.onProgress?.(`Staging directory: ${dirName}/...`);
    await git(['add', '--', dirName], dir, {
      timeout: GIT_ADD_CHUNK_TIMEOUT_MS,
      env: GIT_ADD_ENV,
    });
  }

  // Stage any top-level files
  const topLevelFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (topLevelFiles.length > 0) {
    options.onProgress?.('Staging top-level files...');
    await git(['add', '--', ...topLevelFiles], dir, {
      timeout: GIT_ADD_CHUNK_TIMEOUT_MS,
      env: GIT_ADD_ENV,
    });
  }
}

/**
 * Stages all files in the repository.
 * Tries a monolithic `git add -A` first; if that times out, falls back to
 * directory-by-directory staged adds.
 */
export async function stageAllFiles(
  dir: string,
  options: { onProgress?: (message: string) => void; timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? GIT_ADD_TIMEOUT_MS;

  try {
    await git(['add', '-A'], dir, { timeout, env: GIT_ADD_ENV });
    return;
  } catch (error: unknown) {
    if (!isTimeoutError(error)) {
      throw await maybeWrapIndexLockError(dir, error);
    }
    options.onProgress?.('Monolithic git add timed out; falling back to chunked staging...');
  }

  // The killed process may have left an index lock
  await cleanupIndexLock(dir);

  await stageAllFilesChunked(dir, options);
}

/**
 * Initializes a new git repository with an orphan branch.
 * @param dir - Directory to initialize
 * @param branchName - Name for the initial branch
 */
export async function initRepository(
  dir: string,
  branchName: string = 'main',
  options: { onProgress?: (message: string) => void } = {}
): Promise<void> {
  await ensureGit();
  const reportProgress = options.onProgress ?? (() => {});

  // Initialize repository
  reportProgress('Creating git repository...');
  await git(['init'], dir);

  // Create orphan branch
  reportProgress(`Creating ${branchName} baseline branch...`);
  await git(['checkout', '--orphan', branchName], dir);

  // Configure git for the repository
  reportProgress('Configuring git identity...');
  await git(['config', 'user.email', 'fireforge@localhost'], dir);
  await git(['config', 'user.name', 'FireForge'], dir);

  // Enable performance settings for large trees
  reportProgress('Configuring git performance settings...');
  await configureGitPerformance(dir);

  // Add a local-only origin remote so that Firefox's mach bootstrap and
  // build scripts (which shell out to `git remote get-url origin`) don't
  // fail.  Nothing is ever fetched from or pushed to this remote.
  reportProgress('Configuring origin remote for build compatibility...');
  await git(['remote', 'add', 'origin', 'https://github.com/mozilla-firefox/firefox'], dir);

  // Add all files
  reportProgress(
    'Indexing Firefox source with git add -A (this can take several minutes on large trees)...'
  );
  await assertNoGitIndexLock(dir);
  try {
    await stageAllFiles(dir, { onProgress: reportProgress });
  } catch (error: unknown) {
    throw await maybeWrapIndexLockError(dir, error);
  }

  // Create initial commit
  reportProgress('Creating initial Firefox source commit...');
  try {
    await git(['commit', '-m', 'Initial Firefox source'], dir);
  } catch (error: unknown) {
    throw await maybeWrapIndexLockError(dir, error);
  }
}

/**
 * Resumes a partially initialized git repository (e.g. after a killed
 * `git add -A` left an unborn HEAD).  Re-applies performance settings,
 * cleans up stale locks, stages all files, and creates the initial commit.
 */
export async function resumeRepository(
  dir: string,
  options: { onProgress?: (message: string) => void } = {}
): Promise<void> {
  await ensureGit();
  const reportProgress = options.onProgress ?? (() => {});

  if (!(await isGitRepository(dir))) {
    throw new GitError('Not a git repository', 'resume');
  }

  reportProgress('Resuming interrupted repository initialization...');

  // Ensure performance settings are in place (may not have been set)
  reportProgress('Configuring git performance settings...');
  await configureGitPerformance(dir);

  // Clean up any stale index lock left by the killed process
  await cleanupIndexLock(dir);

  // Ensure origin remote exists (may have been added before the interrupt)
  await ensureOriginRemote(dir);

  // Stage all files
  reportProgress('Indexing Firefox source (resuming)...');
  await assertNoGitIndexLock(dir);
  try {
    await stageAllFiles(dir, { onProgress: reportProgress });
  } catch (error: unknown) {
    throw await maybeWrapIndexLockError(dir, error);
  }

  // Create initial commit
  reportProgress('Creating initial Firefox source commit...');
  try {
    await git(['commit', '-m', 'Initial Firefox source'], dir);
  } catch (error: unknown) {
    throw await maybeWrapIndexLockError(dir, error);
  }
}

async function assertNoGitIndexLock(dir: string): Promise<void> {
  const lockPath = join(dir, '.git', 'index.lock');
  if (!(await pathExists(lockPath))) {
    return;
  }

  throw new GitIndexLockError(lockPath, await getLockAgeMs(lockPath));
}

async function getLockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    const stats = await stat(lockPath);
    return Math.max(0, Date.now() - stats.mtimeMs);
  } catch (error: unknown) {
    void error;
    return undefined;
  }
}

async function maybeWrapIndexLockError(dir: string, error: unknown): Promise<Error> {
  const lockPath = join(dir, '.git', 'index.lock');

  if (
    error instanceof GitError &&
    /index\.lock/i.test(error.message) &&
    /(unable to create|another git process seems to be running|file exists)/i.test(error.message)
  ) {
    return new GitIndexLockError(lockPath);
  }

  if (
    error instanceof GitError &&
    /(unable to create|locked|lock file)/i.test(error.message) &&
    (await pathExists(lockPath))
  ) {
    return new GitIndexLockError(lockPath, await getLockAgeMs(lockPath));
  }

  return toError(error);
}

/**
 * Applies a patch file using git apply.
 * @param patchPath - Path to the patch file
 * @param repoDir - Repository directory
 * @param options - Application options
 */
export async function applyPatch(
  patchPath: string,
  repoDir: string,
  options: { reject?: boolean } = {}
): Promise<void> {
  await ensureGit();

  if (!options.reject) {
    const checkArgs = ['apply', '--check', '--', patchPath];
    const result = await exec('git', checkArgs, { cwd: repoDir });

    if (result.exitCode !== 0) {
      throw new PatchApplyError(patchPath, new Error(result.stderr));
    }
  }

  // Actually apply the patch
  const applyArgs = ['apply'];
  if (options.reject) {
    applyArgs.push('--reject');
  }
  applyArgs.push('--', patchPath);

  const applyResult = await exec('git', applyArgs, { cwd: repoDir });

  if (applyResult.exitCode !== 0) {
    throw new PatchApplyError(patchPath, new Error(applyResult.stderr));
  }
}

/**
 * Applies a patch idempotently using reverse-forward pattern.
 * First tries to reverse the patch (in case it's already applied),
 * then applies it forward.
 * @param patchPath - Path to the patch file
 * @param repoDir - Repository directory
 * @param options - Application options
 */
export async function applyPatchIdempotent(
  patchPath: string,
  repoDir: string,
  options: { reject?: boolean } = {}
): Promise<void> {
  await ensureGit();

  // Try to reverse the patch (ignore errors if not applied)
  const reverseResult = await exec('git', ['apply', '--reverse', '--', patchPath], {
    cwd: repoDir,
  });

  // If reverse failed (patch wasn't applied), restore only the files the
  // patch would have touched so that unrelated local edits are preserved.
  if (reverseResult.exitCode !== 0) {
    // Extract the set of files referenced in the patch
    const listResult = await exec('git', ['apply', '--numstat', '--', patchPath], { cwd: repoDir });
    const touchedFiles = listResult.stdout
      .split('\n')
      .map((line) => line.split('\t')[2])
      .filter((f): f is string => !!f);

    if (touchedFiles.length > 0) {
      // Restore only the files the patch touches
      await exec('git', ['checkout', 'HEAD', '--', ...touchedFiles], { cwd: repoDir });
    }
  }

  // Apply forward
  await applyPatch(patchPath, repoDir, options);
}

/**
 * Reverses a previously applied patch.
 * @param patchPath - Path to the patch file
 * @param repoDir - Repository directory
 */
export async function reversePatch(patchPath: string, repoDir: string): Promise<void> {
  await ensureGit();
  const result = await exec('git', ['apply', '--reverse', '--', patchPath], { cwd: repoDir });
  if (result.exitCode !== 0) {
    throw new PatchApplyError(patchPath, new Error(result.stderr));
  }
}

/**
 * Checks if the repository has uncommitted changes.
 * @param repoDir - Repository directory
 * @returns True if there are uncommitted changes
 */
export async function hasChanges(repoDir: string): Promise<boolean> {
  await ensureGit();

  const entries = await getWorkingTreeStatus(repoDir);
  return entries.length > 0;
}

/**
 * Checks whether an error indicates the repository has no HEAD (e.g. unborn branch).
 * @param error - The error to check
 * @returns True if the error is a missing-HEAD error
 */
export function isMissingHeadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(ambiguous argument 'HEAD'|unknown revision or path not in the working tree)/i.test(
      error.message
    )
  );
}

/**
 * Gets the current HEAD commit hash.
 * @param repoDir - Repository directory
 * @returns Commit hash
 */
export async function getHead(repoDir: string): Promise<string> {
  await ensureGit();

  const output = await git(['rev-parse', 'HEAD'], repoDir);
  return output.trim();
}

/**
 * Gets the current branch name.
 * @param repoDir - Repository directory
 * @returns Branch name
 */
export async function getCurrentBranch(repoDir: string): Promise<string> {
  await ensureGit();

  const output = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  return output.trim();
}

/**
 * Resets all changes in the repository.
 * @param repoDir - Repository directory
 */
export async function resetChanges(repoDir: string): Promise<void> {
  await ensureGit();

  try {
    await git(['reset', '--hard', 'HEAD'], repoDir);
  } catch (error: unknown) {
    throw await maybeWrapIndexLockError(repoDir, error);
  }
  await git(['clean', '-fd'], repoDir);
}

/**
 * Creates a commit with all current changes.
 * @param repoDir - Repository directory
 * @param message - Commit message
 */
export async function commit(repoDir: string, message: string): Promise<void> {
  await ensureGit();

  await stageAllFiles(repoDir);
  await git(['commit', '-m', message], repoDir);
}

/**
 * Gets the status of files with their status codes.
 * @param repoDir - Repository directory
 * @returns Array of [status, filepath] tuples
 */
export async function getStatusWithCodes(
  repoDir: string
): Promise<Array<{ status: string; file: string }>> {
  const entries = await getWorkingTreeStatus(repoDir);
  return entries.map((entry) => ({
    status: entry.status.trim(),
    file: entry.file,
  }));
}
