// SPDX-License-Identifier: EUPL-1.2
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { GitError } from '../errors/git.js';
import { removeFile } from '../utils/fs.js';
import { exec } from '../utils/process.js';
import type { GitStatusEntry } from './git-base.js';
import { chunkPathspecs, ensureGit, git } from './git-base.js';

/**
 * Restores a tracked path from HEAD, including staged changes.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 */
export async function restoreTrackedPath(repoDir: string, filePath: string): Promise<void> {
  await git(['restore', '--source', 'HEAD', '--staged', '--worktree', '--', filePath], repoDir);
}

/**
 * Removes a path that is present only in the index/worktree and not in HEAD.
 * @param repoDir - Repository directory
 * @param filePath - Path to remove
 */
async function removeAddedPath(repoDir: string, filePath: string): Promise<void> {
  await git(['reset', 'HEAD', '--', filePath], repoDir);
  await removeFile(join(repoDir, filePath));
}

/**
 * Discards a status entry according to its git state.
 * @param repoDir - Repository directory
 * @param entry - Parsed git status entry
 */
export async function discardStatusEntry(repoDir: string, entry: GitStatusEntry): Promise<void> {
  if (entry.isUntracked) {
    await removeFile(join(repoDir, entry.file));
    return;
  }

  if (entry.isRenameOrCopy && entry.originalPath) {
    await restoreTrackedPath(repoDir, entry.originalPath);
    if (await fileExistsInHead(repoDir, entry.file)) {
      await restoreTrackedPath(repoDir, entry.file);
    } else {
      await removeAddedPath(repoDir, entry.file);
    }
    return;
  }

  if (!(await fileExistsInHead(repoDir, entry.file))) {
    await removeAddedPath(repoDir, entry.file);
    return;
  }

  await restoreTrackedPath(repoDir, entry.file);
}

/**
 * Stages specific files in the repository.
 * @param repoDir - Repository directory
 * @param files - File paths to stage (relative to repo)
 */
export async function stageFiles(repoDir: string, files: string[]): Promise<void> {
  await git(['add', '--', ...files], repoDir);
}

/**
 * Unstages specific files from the index.
 * @param repoDir - Repository directory
 * @param files - File paths to unstage (relative to repo)
 */
export async function unstageFiles(repoDir: string, files: string[]): Promise<void> {
  await git(['reset', 'HEAD', '--', ...files], repoDir);
}

/**
 * Checks if a file exists in the HEAD commit.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns true if file exists in HEAD
 */
export async function fileExistsInHead(repoDir: string, filePath: string): Promise<boolean> {
  return (await git(['ls-tree', 'HEAD', '--', filePath], repoDir)).trim().length > 0;
}

/**
 * Batched equivalent of {@link fileExistsInHead}: returns the subset of
 * `files` that are tracked in HEAD, using a single `git ls-tree` per ARG_MAX
 * chunk instead of one spawn per file. This is the cold-run hot path — a
 * Firefox-sized checkout has hundreds of affected files.
 *
 * `-r` lists nested blobs by full repo-relative path; `--name-only -z` makes
 * the output a trivial NUL-split with no quoting to undo. Membership in the
 * returned Set is exactly `await fileExistsInHead(repoDir, file)` for any
 * non-directory `file`. Throws (via {@link git}) when HEAD itself is
 * unresolvable, matching the per-file helper's failure mode.
 *
 * @param repoDir - Repository directory
 * @param files - Repo-relative paths to classify
 * @returns The subset of `files` present in HEAD
 */
export async function listTrackedInHead(repoDir: string, files: string[]): Promise<Set<string>> {
  const tracked = new Set<string>();
  if (files.length === 0) return tracked;
  const wanted = new Set(files);
  for (const chunk of chunkPathspecs(files)) {
    const output = await git(
      ['ls-tree', '-r', 'HEAD', '--name-only', '-z', '--', ...chunk],
      repoDir
    );
    for (const name of output.split('\0')) {
      // `ls-tree -r` can surface entries beyond the literal inputs only when an
      // input is itself a directory in HEAD; intersect with `wanted` so the
      // result is always a subset of the requested files, never a superset.
      if (name.length > 0 && wanted.has(name)) tracked.add(name);
    }
  }
  return tracked;
}

/**
 * Batched equivalent of the per-file `git hash-object` in
 * {@link import('./git-diff.js').generateNewFileDiff}: computes the git blob
 * hash for every path in one spawn per ARG_MAX chunk and returns a
 * `Map<fullPath, fullHash>`.
 *
 * Uses {@link import('../utils/process.js').exec} rather than {@link git}
 * (which throws on a non-zero exit) because `git hash-object f1 f2 …` is
 * all-or-nothing: it aborts at the first unreadable path and emits nothing
 * for the rest. To keep the per-file contract — where one bad path zeroes
 * only its own index line — a chunk that does not return exactly one hash
 * per input falls back to hashing that chunk's paths individually. A path
 * that is still unhashable is left out of the map; the caller applies the
 * `0000000000` zero-hash fallback for any miss. Hashing stays in git rather
 * than in-process so filters and `.gitattributes` are applied per path and
 * the result cannot diverge under `core.autocrlf`/`text` attributes.
 *
 * @param repoDir - Repository directory
 * @param fullPaths - Absolute file paths to hash
 * @returns Map from each input path to its full blob hash (misses omitted)
 */
export async function hashObjectBatch(
  repoDir: string,
  fullPaths: string[]
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (fullPaths.length === 0) return hashes;
  await ensureGit();

  for (const chunk of chunkPathspecs(fullPaths)) {
    const result = await exec('git', ['hash-object', '--', ...chunk], { cwd: repoDir });
    const lines = result.stdout.split('\n').filter((line) => line.length > 0);
    if (result.exitCode === 0 && lines.length === chunk.length) {
      for (const [i, path] of chunk.entries()) {
        hashes.set(path, lines[i] as string);
      }
      continue;
    }

    // Batch aborted partway (a path became unreadable between the caller's stat
    // and here, or otherwise failed). Recover per file so one bad path only
    // loses its own hash, exactly as the pre-batch per-file code behaved.
    for (const path of chunk) {
      const single = await exec('git', ['hash-object', '--', path], { cwd: repoDir });
      const hash = single.stdout.trim();
      if (single.exitCode === 0 && hash.length > 0) hashes.set(path, hash);
    }
  }
  return hashes;
}

/**
 * Gets the content of a file at a specific git ref (HEAD by default).
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @param ref - Git ref to read from (commit hash, branch, tag). Defaults to HEAD.
 * @returns File content or null if file doesn't exist at that ref
 */
export async function getFileContentAtRef(
  repoDir: string,
  filePath: string,
  ref = 'HEAD'
): Promise<string | null> {
  await ensureGit();
  const result = await exec('git', ['show', `${ref}:${filePath}`], { cwd: repoDir });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    // Recognise the "file does not exist at this ref" variants across git versions.
    // The ref name in quotes varies with what was passed (HEAD, a SHA, a tag), so
    // match loosely rather than interpolating ref into a regex.
    if (
      /exists on disk, but not in '[^']*'|path '[^']*' exists, but not '[^']*'|path '[^']*' does not exist in '[^']*'/i.test(
        stderr
      )
    ) {
      return null;
    }
    throw new GitError(stderr || 'Git command failed', `show ${ref}:${filePath}`);
  }
  return result.stdout;
}

/**
 * Checks if a file is binary by looking for NUL bytes in the first 8KB.
 * Uses the same heuristic as git.
 * @param repoDir - Repository directory
 * @param filePath - File path (relative to repo root)
 * @returns true if the file appears to be binary
 */
export async function isBinaryFile(repoDir: string, filePath: string): Promise<boolean> {
  const fullPath = join(repoDir, filePath);
  try {
    const fh = await open(fullPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch (error: unknown) {
    void error;
    return false;
  }
}
