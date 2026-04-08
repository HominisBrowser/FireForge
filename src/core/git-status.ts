// SPDX-License-Identifier: EUPL-1.2
import { exec } from '../utils/process.js';
import type { GitStatusEntry } from './git-base.js';
import { ensureGit } from './git-base.js';

/**
 * Parses NUL-delimited porcelain status output.
 * @param output - Raw git status output
 * @returns Parsed entries
 */
/** @internal Exported for testing */
export function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const records = output.split('\0').filter((record) => record.length > 0);
  const entries: GitStatusEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4) continue;

    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const status = `${indexStatus}${worktreeStatus}`;
    const pathField = record.slice(3);
    const isRenameOrCopy = indexStatus === 'R' || indexStatus === 'C';
    const originalPath = isRenameOrCopy ? records[i + 1] : undefined;

    if (isRenameOrCopy) {
      i++;
    }

    entries.push({
      status,
      indexStatus,
      worktreeStatus,
      file: pathField,
      ...(originalPath !== undefined ? { originalPath } : {}),
      isUntracked: indexStatus === '?' && worktreeStatus === '?',
      isRenameOrCopy,
      isDeleted: indexStatus === 'D' || worktreeStatus === 'D',
    });
  }

  return entries;
}

/**
 * Gets structured working tree status entries.
 * @param repoDir - Repository directory
 * @returns Parsed git status entries
 */
export async function getWorkingTreeStatus(repoDir: string): Promise<GitStatusEntry[]> {
  await ensureGit();

  const result = await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: repoDir });
  return parsePorcelainStatus(result.stdout);
}

/**
 * Expands collapsed untracked directory entries into individual file entries.
 * Git status may report "?? dir/" instead of listing each file underneath.
 * @param repoDir - Repository directory
 * @param entries - Parsed status entries
 * @returns Status entries with untracked directories expanded to individual files
 */
export async function expandUntrackedDirectoryEntries(
  repoDir: string,
  entries: GitStatusEntry[]
): Promise<GitStatusEntry[]> {
  const expanded: GitStatusEntry[] = [];

  for (const entry of entries) {
    if (!entry.isUntracked || !entry.file.endsWith('/')) {
      expanded.push(entry);
      continue;
    }

    const individualFiles = await getUntrackedFilesInDir(repoDir, entry.file);
    for (const file of individualFiles) {
      expanded.push({
        status: '??',
        indexStatus: '?',
        worktreeStatus: '?',
        file,
        isUntracked: true,
        isRenameOrCopy: false,
        isDeleted: false,
      });
    }
  }

  return expanded;
}

/**
 * Gets the list of modified files.
 * @param repoDir - Repository directory
 * @returns List of modified file paths
 */
export async function getModifiedFiles(repoDir: string): Promise<string[]> {
  const entries = await getWorkingTreeStatus(repoDir);
  return entries.map((entry) => entry.file);
}

/**
 * Gets all untracked files (including files inside untracked directories).
 * @param repoDir - Repository directory
 * @returns List of untracked file paths
 */
export async function getUntrackedFiles(repoDir: string): Promise<string[]> {
  await ensureGit();

  // Use git ls-files to get all untracked files, which properly expands directories
  const result = await exec('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoDir,
  });

  return result.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Gets untracked files within a specific directory.
 * Uses path-scoped git ls-files for efficiency in large repos.
 * @param repoDir - Repository directory
 * @param dir - Directory path (relative to repo root)
 * @returns List of untracked file paths relative to repo root
 */
export async function getUntrackedFilesInDir(repoDir: string, dir: string): Promise<string[]> {
  await ensureGit();
  const result = await exec('git', ['ls-files', '--others', '--exclude-standard', '--', dir], {
    cwd: repoDir,
  });
  return result.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Gets modified (tracked) files within a specific directory.
 * Uses path-scoped git diff for efficiency in large repos.
 * @param repoDir - Repository directory
 * @param dir - Directory path (relative to repo root)
 * @returns List of modified file paths relative to repo root
 */
export async function getModifiedFilesInDir(repoDir: string, dir: string): Promise<string[]> {
  await ensureGit();
  const result = await exec('git', ['diff', '--name-only', 'HEAD', '--', dir], { cwd: repoDir });
  return result.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Checks if any of the specified files have uncommitted changes.
 * @param repoDir - Repository directory
 * @param files - File paths to check (relative to repo root)
 * @returns List of dirty file paths
 */
export async function getDirtyFiles(repoDir: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  await ensureGit();

  // Check both staged and unstaged changes for the given files
  const result = await exec('git', ['diff', '--name-only', 'HEAD', '--', ...files], {
    cwd: repoDir,
  });
  const tracked = result.stdout.split('\n').filter((line) => line.trim().length > 0);

  // Also check for untracked files
  const untrackedResult = await exec(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', ...files],
    { cwd: repoDir }
  );
  const untracked = untrackedResult.stdout.split('\n').filter((line) => line.trim().length > 0);

  return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Lists all files in a directory (tracked and untracked, respecting .gitignore).
 * Combines git ls-files for tracked files and --others for untracked files.
 * @param repoDir - Repository directory
 * @param dir - Directory path (relative to repo root)
 * @returns List of file paths relative to repo root
 */
export async function listAllFilesInDir(repoDir: string, dir: string): Promise<string[]> {
  await ensureGit();

  const tracked = await exec('git', ['ls-files', '--', dir], { cwd: repoDir });
  const trackedFiles = tracked.stdout.split('\n').filter((line) => line.trim().length > 0);

  const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard', '--', dir], {
    cwd: repoDir,
  });
  const untrackedFiles = untracked.stdout.split('\n').filter((line) => line.trim().length > 0);

  return [...new Set([...trackedFiles, ...untrackedFiles])].sort();
}
