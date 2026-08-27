// SPDX-License-Identifier: EUPL-1.2
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ExecTimeoutError } from '../errors/base.js';
import {
  GitError,
  GitIndexingTimeoutError,
  GitIndexLockError,
  PatchApplyError,
} from '../errors/git.js';
import { elapsedSince } from '../utils/elapsed.js';
import { toError } from '../utils/errors.js';
import { pathExists, pathExistsStrict, removeFile } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { ensureFirefoxIgnorefileCompatibility } from './firefox-ignorefile.js';
import {
  chunkPathspecs,
  configureGitLineEndings,
  configureGitPerformance,
  ensureGit,
  git,
  GIT_ADD_CHUNK_TIMEOUT_ENV_VAR,
  GIT_ADD_CHUNK_TIMEOUT_MS,
  GIT_ADD_TIMEOUT_MS,
} from './git-base.js';
import { getWorkingTreeStatus } from './git-status.js';

// ── Functions that remain in this file ──

/**
 * Checks if a directory is a git repository.
 * @param dir - Directory to check
 * @returns True if the directory is a git repository
 */
export async function isGitRepository(dir: string): Promise<boolean> {
  const gitDir = join(dir, '.git');
  return pathExistsStrict(gitDir);
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

interface SourceScanSummary {
  directories: string[];
  topLevelFiles: string[];
}

/**
 * Returns true when the error looks like a process killed by the spawn
 * timeout (SIGTERM → exit code 143) OR an AbortError raised by
 * `AbortSignal.timeout` — Node's `child_process` layer rejects with an
 * AbortError when the signal fires, so both shapes have to be recognised.
 */
function isTimeoutError(error: unknown): boolean {
  // `exec` now rejects with a typed ExecTimeoutError when its `timeout`
  // option fires (the raw AbortError check below is kept for defence in
  // depth against other abort paths).
  if (error instanceof ExecTimeoutError) return true;
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
 * Returns true when {@link relativePath} is ignored by `.gitignore` (or any
 * other exclusion mechanism git considers, e.g. `.git/info/exclude`,
 * core.excludesFile). Used by the chunked staging fallback to skip entries
 * that would otherwise fail `git add -- <path>` with the fatal "The
 * following paths are ignored by one of your .gitignore files" error — a
 * state the monolithic `git add -A` path silently handles. A Firefox
 * checkout's top-level `.vscode/` is the common case: without this, the
 * chunked invocation aborts the whole fallback and turns a recoverable
 * monolithic timeout into a hard setup failure.
 *
 * `git check-ignore -q -- <path>` exits 0 when the path is ignored, 1 when
 * it is not, and >=128 on real failures. Anything other than 0/1 is treated
 * as "unknown" and conservatively returns false, so the chunk runs and any
 * real underlying failure surfaces normally.
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
 * Stages every file by walking top-level directories one at a time. This
 * avoids a single monolithic `git add -A` that may time out on very large
 * (~300 K file) trees like Firefox.
 *
 * A chunked pass that hits its own timeout raises a typed
 * {@link GitIndexingTimeoutError} rather than an opaque `AbortError: The
 * operation was aborted`; the typed error carries the environment-variable
 * override so the operator can extend the budget and re-run.
 */
async function stageAllFilesChunked(
  dir: string,
  scan: SourceScanSummary,
  options: { onProgress?: (message: string) => void } = {}
): Promise<void> {
  const { directories, topLevelFiles: topLevelCandidates } = scan;

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

  let stagedDirectories = 0;
  for (const dirName of directories) {
    stagedDirectories++;
    if (await isPathIgnored(dir, dirName)) {
      options.onProgress?.(
        `Skipping gitignored directory ${stagedDirectories}/${directories.length}: ${dirName}/`
      );
      continue;
    }
    options.onProgress?.(
      `Staging directory ${stagedDirectories}/${directories.length}: ${dirName}/...`
    );
    await runChunk(['add', '--', dirName], dirName);
  }

  // Stage any top-level files (excluding gitignored ones — `git add`
  // on an explicit ignored path errors out, which would otherwise
  // abort the chunked fallback after the monolithic path has already
  // timed out).
  const topLevelFiles: string[] = [];
  for (const name of topLevelCandidates) {
    if (await isPathIgnored(dir, name)) {
      options.onProgress?.(`Skipping gitignored top-level file: ${name}`);
      continue;
    }
    topLevelFiles.push(name);
  }
  if (topLevelFiles.length > 0) {
    options.onProgress?.(`Staging ${topLevelFiles.length} top-level file(s)...`);
    await runChunk(['add', '--', ...topLevelFiles], 'top-level files');
  }
}

/**
 * Interval between heartbeat progress messages during the monolithic
 * `git add -A`. On a fresh ~600 MB Firefox tree the monolithic add runs
 * 60–120 seconds, during which git emits nothing to stdout/stderr. Without a
 * heartbeat the CLI spinner stays pinned on "Indexing Firefox source …" for
 * the full window and looks hung, which invites a SIGINT mid-way.
 */
const GIT_ADD_HEARTBEAT_MS = 15_000;
const GIT_COMMIT_HEARTBEAT_MS = 15_000;

async function scanTopLevelSource(dir: string): Promise<SourceScanSummary> {
  const entries = await readdir(dir, { withFileTypes: true });
  return {
    directories: entries
      .filter((entry) => entry.isDirectory() && entry.name !== '.git')
      .map((entry) => entry.name)
      .sort(),
    topLevelFiles: entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
  };
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
  const reportProgress = options.onProgress;
  reportProgress?.('Scanning Firefox source tree before indexing...');
  const scan = await scanTopLevelSource(dir);
  reportProgress?.(
    `Source scan complete: ${scan.directories.length} top-level director${scan.directories.length === 1 ? 'y' : 'ies'}, ${scan.topLevelFiles.length} top-level file${scan.topLevelFiles.length === 1 ? '' : 's'}`
  );

  // The heartbeat tracks a PER-PHASE start timestamp and labels each tick
  // with the phase. A single start time set at function entry reports
  // cumulative elapsed for the whole `stageAllFiles` invocation, so after a
  // monolithic timeout the chunked-phase ticks name numbers that already
  // include the entire monolithic budget, with no way to tell from the log
  // where one attempt ended and the next began.
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
      reportProgress?.('Git phase: starting git add -A source indexing.');
      reportProgress?.(
        `Starting monolithic git add -A for ${scan.directories.length} director${scan.directories.length === 1 ? 'y' : 'ies'} and ${scan.topLevelFiles.length} top-level file${scan.topLevelFiles.length === 1 ? '' : 's'}...`
      );
      await git(['add', '-A'], dir, { timeout, env: GIT_ADD_ENV });
      reportProgress?.('Git phase complete: git add -A source indexing finished.');
      return;
    } catch (error: unknown) {
      if (!isTimeoutError(error)) {
        throw await maybeWrapIndexLockError(dir, error);
      }
      // Emit a loud, one-line banner so non-TTY log scrapers and TTY
      // operators both see that the monolithic attempt lost and the chunked
      // pass is starting. Without it the fallback transition is invisible
      // and the heartbeat simply goes quiet for minutes.
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
      await stageAllFilesChunked(dir, scan, options);
      reportProgress?.('Git phase complete: chunked source indexing finished.');
    } catch (error: unknown) {
      if (error instanceof GitIndexingTimeoutError) throw error;
      throw error;
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function createInitialSourceCommit(
  dir: string,
  reportProgress: (message: string) => void
): Promise<void> {
  const startedAt = Date.now();
  reportProgress('Git phase: creating initial source commit.');
  reportProgress(`Creating initial Firefox source commit (${elapsedSince(startedAt)} elapsed)...`);
  const heartbeat = setInterval(() => {
    reportProgress(
      `Creating initial Firefox source commit (${elapsedSince(startedAt)} elapsed)...`
    );
  }, GIT_COMMIT_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    await git(['commit', '-m', 'Initial Firefox source'], dir);
  } finally {
    clearInterval(heartbeat);
  }
  reportProgress(
    `Git phase complete: initial source commit created (${elapsedSince(startedAt)} elapsed).`
  );
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
  reportProgress('Git phase: initializing source git repository.');
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
  await configureGitLineEndings(dir);

  // Add a local-only origin remote so that Firefox's mach bootstrap and
  // build scripts (which shell out to `git remote get-url origin`) don't
  // fail.  Nothing is ever fetched from or pushed to this remote.
  reportProgress('Configuring origin remote for build compatibility...');
  await git(['remote', 'add', 'origin', 'https://github.com/mozilla-firefox/firefox'], dir);
  reportProgress('Git phase complete: source git repository metadata initialized.');

  reportProgress('Normalizing Firefox ignore files for Git-backed mach lint compatibility...');
  await ensureFirefoxIgnorefileCompatibility(dir);

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
  try {
    await createInitialSourceCommit(dir, reportProgress);
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
  await configureGitLineEndings(dir);

  // Clean up any stale index lock left by the killed process
  await cleanupIndexLock(dir);

  // Ensure origin remote exists (may have been added before the interrupt)
  await ensureOriginRemote(dir);

  reportProgress('Normalizing Firefox ignore files for Git-backed mach lint compatibility...');
  await ensureFirefoxIgnorefileCompatibility(dir);

  // Stage all files
  reportProgress('Indexing Firefox source (resuming)...');
  await assertNoGitIndexLock(dir);
  try {
    await stageAllFiles(dir, { onProgress: reportProgress });
  } catch (error: unknown) {
    throw await maybeWrapIndexLockError(dir, error);
  }

  // Create initial commit
  try {
    await createInitialSourceCommit(dir, reportProgress);
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
 * Applies a patch idempotently using reverse-forward pattern. First tries to
 * reverse the patch (in case it is already applied), then applies it forward.
 *
 * @param patchPath - Path to the patch file
 * @param repoDir - Repository directory
 * @param options.reject - Fall back to `git apply --reject`
 * @param options.protectedFiles - Files that must NOT be reset to HEAD by the
 *   recovery step. Callers applying a patch QUEUE pass the files already
 *   touched by previously applied patches in the same run: two overlapping
 *   patches (an `--allow-overlap` queue) share files, and a blanket
 *   `checkout HEAD` would wipe the earlier patch's changes from the shared
 *   file before applying the later one, leaving the engine in a hybrid state
 *   the summary never describes.
 */
export async function applyPatchIdempotent(
  patchPath: string,
  repoDir: string,
  options: { reject?: boolean; protectedFiles?: ReadonlySet<string> } = {}
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
      .filter((f): f is string => !!f)
      .filter((f) => !(options.protectedFiles?.has(f) ?? false));

    if (touchedFiles.length > 0) {
      await restoreFilesToHead(repoDir, patchPath, touchedFiles);
    }
  }

  // Apply forward
  await applyPatch(patchPath, repoDir, options);
}

/**
 * Restores `files` to their HEAD state, deleting files the patch would CREATE
 * (present on disk from a partial apply but absent in HEAD — for those,
 * `git checkout HEAD --` fails, and ignoring that failure leaves stray files
 * that make the subsequent forward apply die with "already exists" and no
 * hint why).
 *
 * Every git invocation is chunked via {@link chunkPathspecs} so a very large
 * patch cannot hit `E2BIG`, and every exit code is checked — a silent failed
 * restore is the confusing state this recovery step exists to prevent.
 */
async function restoreFilesToHead(
  repoDir: string,
  patchPath: string,
  files: string[]
): Promise<void> {
  // Partition into tracked-in-HEAD (restore via checkout) and absent-in-HEAD
  // (patch-created leftovers: delete from the worktree).
  const trackedInHead = new Set<string>();
  for (const chunk of chunkPathspecs(files)) {
    const lsTree = await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...chunk], {
      cwd: repoDir,
    });
    if (lsTree.exitCode !== 0) {
      throw new PatchApplyError(
        patchPath,
        new Error(`git ls-tree failed while preparing recovery: ${lsTree.stderr.trim()}`)
      );
    }
    for (const line of lsTree.stdout.split('\n')) {
      if (line.length > 0) trackedInHead.add(line);
    }
  }

  const toCheckout = files.filter((f) => trackedInHead.has(f));
  const toDelete = files.filter((f) => !trackedInHead.has(f));

  for (const chunk of chunkPathspecs(toCheckout)) {
    const checkout = await exec('git', ['checkout', 'HEAD', '--', ...chunk], { cwd: repoDir });
    if (checkout.exitCode !== 0) {
      throw new PatchApplyError(
        patchPath,
        new Error(
          `Could not restore patch-touched files to HEAD before applying: ${checkout.stderr.trim()}`
        )
      );
    }
  }

  for (const file of toDelete) {
    const target = join(repoDir, file);
    if (await pathExists(target)) {
      await removeFile(target);
      verbose(`Removed stray patch-created file before apply: ${file}`);
    }
  }
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
