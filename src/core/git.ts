// SPDX-License-Identifier: EUPL-1.2
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  GitError,
  GitIndexingTimeoutError,
  GitIndexLockError,
  PatchApplyError,
} from '../errors/git.js';
import { toError } from '../utils/errors.js';
import { pathExists, removeFile } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import {
  configureGitPerformance,
  ensureGit,
  git,
  GIT_ADD_CHUNK_TIMEOUT_ENV_VAR,
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
 * (SIGTERM → exit code 143) OR an AbortError raised by
 * `AbortSignal.timeout`. The AbortSignal path is the one observed during
 * the 2026-04-24 eval (Finding 10): Node's `child_process` layer
 * rejects with an AbortError when the signal fires, so the timeout
 * detection here needs to recognise that shape too.
 */
function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (!(error instanceof GitError)) return false;
  if (/SIGTERM|timed out|exit code 143/i.test(error.message)) return true;
  if (error.cause instanceof Error && error.cause.name === 'AbortError') return true;
  return false;
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
 * Returns true when {@link relativePath} is ignored by `.gitignore` (or
 * any other exclusion mechanism git considers, e.g. `.git/info/exclude`,
 * core.excludesFile). Used by the chunked staging fallback to skip
 * entries that would otherwise fail `git add -- <path>` with the fatal
 * "The following paths are ignored by one of your .gitignore files"
 * error — a state the monolithic `git add -A` path silently handles.
 *
 * Implementation: `git check-ignore -q -- <path>` exits 0 when the path
 * is ignored, 1 when it isn't, and >=128 on real failures. Treat
 * anything other than 0/1 as "unknown" and conservatively return false
 * so the chunk runs and any real underlying failure surfaces normally.
 *
 * 2026-04-26 eval Finding 4: a Firefox checkout's top-level `.vscode/`
 * is gitignored by the source tree's own `.gitignore`. Pre-fix, the
 * chunked `git add -- .vscode` invocation aborted the entire fallback
 * and turned a recoverable monolithic timeout into a hard setup
 * failure that required `fireforge download --force`.
 */
async function isPathIgnored(dir: string, relativePath: string): Promise<boolean> {
  const result = await exec('git', ['check-ignore', '-q', '--', relativePath], { cwd: dir });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  // Any other shape is "we don't know" — let the caller proceed and
  // surface the real error if `git add` rejects the path.
  return false;
}

/**
 * Stages every file by walking top-level directories one at a time.
 * This avoids a single monolithic `git add -A` that may time out on
 * very large (~300 K file) trees like Firefox.
 *
 * 2026-04-24 eval Finding 10: a chunked pass that hits its own timeout
 * now raises a typed {@link GitIndexingTimeoutError} rather than the
 * opaque `AbortError: The operation was aborted` the caller otherwise
 * saw. The typed error carries the environment-variable override so the
 * operator can extend the budget and re-run.
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

  async function runChunk(args: string[], label: string): Promise<void> {
    try {
      await git(args, dir, {
        timeout: GIT_ADD_CHUNK_TIMEOUT_MS,
        env: GIT_ADD_ENV,
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new GitIndexingTimeoutError(
          'chunked',
          GIT_ADD_CHUNK_TIMEOUT_MS,
          GIT_ADD_CHUNK_TIMEOUT_ENV_VAR,
          error instanceof Error ? error : undefined
        );
      }
      verbose(`Chunked staging failed on ${label}: ${toError(error).message}`);
      throw error;
    }
  }

  for (const dirName of directories) {
    if (await isPathIgnored(dir, dirName)) {
      options.onProgress?.(`Skipping gitignored: ${dirName}/`);
      continue;
    }
    options.onProgress?.(`Staging directory: ${dirName}/...`);
    await runChunk(['add', '--', dirName], dirName);
  }

  // Stage any top-level files (excluding gitignored ones — `git add`
  // on an explicit ignored path errors out, which would otherwise
  // abort the chunked fallback after the monolithic path has already
  // timed out).
  const topLevelCandidates = entries.filter((e) => e.isFile()).map((e) => e.name);
  const topLevelFiles: string[] = [];
  for (const name of topLevelCandidates) {
    if (await isPathIgnored(dir, name)) {
      options.onProgress?.(`Skipping gitignored: ${name}`);
      continue;
    }
    topLevelFiles.push(name);
  }
  if (topLevelFiles.length > 0) {
    options.onProgress?.('Staging top-level files...');
    await runChunk(['add', '--', ...topLevelFiles], 'top-level files');
  }
}

/**
 * Interval between heartbeat progress messages during the monolithic
 * `git add -A`. On a fresh ~600 MB Firefox tree the monolithic add runs
 * 60–120 seconds, during which git emits nothing to stdout/stderr. Without
 * a heartbeat the CLI spinner stays pinned on "Indexing Firefox source …"
 * for the full window, looks hung, and in the eval scenario operators
 * SIGINT'd mid-way assuming the process had stalled.
 */
const GIT_ADD_HEARTBEAT_MS = 15_000;

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
  const reportProgress = options.onProgress;

  // 2026-04-26 eval Finding 5: the pre-fix heartbeat used a single
  // `heartbeatStartedAt` set at function entry and reported cumulative
  // elapsed for the whole `stageAllFiles` invocation. After a
  // monolithic timeout, the chunked-phase ticks therefore named
  // numbers that already included the entire monolithic budget plus
  // any host-sleep time, with no way for an operator watching the log
  // to tell where the monolithic attempt ended and the chunked pass
  // began. The heartbeat now tracks a per-phase start timestamp and
  // labels each tick with the phase, so the chunked pass reports its
  // own elapsed window and the monolithic→chunked handoff is visible.
  let phase: 'monolithic' | 'chunked' = 'monolithic';
  let phaseStartedAt = Date.now();

  const heartbeatTimer = reportProgress
    ? setInterval(() => {
        const elapsedS = Math.round((Date.now() - phaseStartedAt) / 1000);
        const label = phase === 'monolithic' ? 'monolithic' : 'chunked staging';
        reportProgress(`Indexing Firefox source (${label}, ${elapsedS}s elapsed)`);
      }, GIT_ADD_HEARTBEAT_MS)
    : null;
  heartbeatTimer?.unref();

  try {
    try {
      await git(['add', '-A'], dir, { timeout, env: GIT_ADD_ENV });
      return;
    } catch (error: unknown) {
      if (!isTimeoutError(error)) {
        throw await maybeWrapIndexLockError(dir, error);
      }
      // 2026-04-24 eval Finding 10: the fallback transition used to be
      // an implementation detail invisible to operators watching the
      // spinner. Emit a loud, one-line banner so non-TTY log scrapers
      // and TTY operators both see that the monolithic attempt lost and
      // the chunked pass is starting. This was the missing signal in
      // the eval log where the heartbeat went quiet for ~600s between
      // the monolithic timeout and the chunked-pass failure.
      options.onProgress?.(
        `Monolithic git add reached the ${Math.round(timeout / 1000)}s timeout; falling back to chunked staging. This pass may take several more minutes on a large tree.`
      );
    }

    // The killed process may have left an index lock
    await cleanupIndexLock(dir);

    // Reset elapsed accounting for the chunked phase so its heartbeat
    // names a believable per-phase number rather than rolling the
    // monolithic budget forward.
    phase = 'chunked';
    phaseStartedAt = Date.now();

    try {
      await stageAllFilesChunked(dir, options);
    } catch (error: unknown) {
      if (error instanceof GitIndexingTimeoutError) throw error;
      throw error;
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
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
