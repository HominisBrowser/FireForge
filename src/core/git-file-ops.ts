// SPDX-License-Identifier: EUPL-1.2
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { GitError } from '../errors/git.js';
import { removeFile } from '../utils/fs.js';
import { exec } from '../utils/process.js';
import type { GitStatusEntry } from './git-base.js';
import { ensureGit, git } from './git-base.js';

/**
 * Discards changes to a specific file.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 */
export async function discardFile(repoDir: string, filePath: string): Promise<void> {
  await restoreTrackedPath(repoDir, filePath);
}

/**
 * Restores a tracked path from HEAD, including staged changes.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 */
export async function restoreTrackedPath(repoDir: string, filePath: string): Promise<void> {
  await ensureGit();

  await git(['restore', '--source', 'HEAD', '--staged', '--worktree', '--', filePath], repoDir);
}

/**
 * Removes an untracked path from disk.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 */
export async function removeUntrackedPath(repoDir: string, filePath: string): Promise<void> {
  const fullPath = join(repoDir, filePath);
  await removeFile(fullPath);
}

/**
 * Removes a path that is present only in the index/worktree and not in HEAD.
 * @param repoDir - Repository directory
 * @param filePath - Path to remove
 */
export async function removeAddedPath(repoDir: string, filePath: string): Promise<void> {
  await ensureGit();
  await git(['reset', 'HEAD', '--', filePath], repoDir);
  await removeUntrackedPath(repoDir, filePath);
}

/**
 * Discards a status entry according to its git state.
 * @param repoDir - Repository directory
 * @param entry - Parsed git status entry
 */
export async function discardStatusEntry(repoDir: string, entry: GitStatusEntry): Promise<void> {
  if (entry.isUntracked) {
    await removeUntrackedPath(repoDir, entry.file);
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
  await ensureGit();
  await git(['add', '--', ...files], repoDir);
}

/**
 * Unstages specific files from the index.
 * @param repoDir - Repository directory
 * @param files - File paths to unstage (relative to repo)
 */
export async function unstageFiles(repoDir: string, files: string[]): Promise<void> {
  await ensureGit();
  await git(['reset', 'HEAD', '--', ...files], repoDir);
}

/**
 * Checks if a file exists in the HEAD commit.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns true if file exists in HEAD
 */
export async function fileExistsInHead(repoDir: string, filePath: string): Promise<boolean> {
  await ensureGit();
  return (await git(['ls-tree', 'HEAD', '--', filePath], repoDir)).trim().length > 0;
}

/**
 * Gets the content of a file from HEAD commit.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns File content or null if file doesn't exist in HEAD
 */
export async function getFileContentFromHead(
  repoDir: string,
  filePath: string
): Promise<string | null> {
  await ensureGit();
  const result = await exec('git', ['show', `HEAD:${filePath}`], { cwd: repoDir });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (
      /exists on disk, but not in 'HEAD'|path '.*' exists, but not '.*'|path '.*' does not exist in 'HEAD'/i.test(
        stderr
      )
    ) {
      return null;
    }
    throw new GitError(stderr || 'Git command failed', `show HEAD:${filePath}`);
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
