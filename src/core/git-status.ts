// SPDX-License-Identifier: EUPL-1.2
import { warn } from '../utils/logger.js';
import type { GitStatusEntry } from './git-base.js';
import { git } from './git-base.js';

/**
 * True when a porcelain status column carries a rename or copy, i.e. the
 * record is followed by a second NUL-terminated field holding the original
 * path.
 * @param column - A single status column character
 * @returns Whether the column is `R` or `C`
 */
function isRenameOrCopyColumn(column: string): boolean {
  return column === 'R' || column === 'C';
}

/**
 * Parses NUL-delimited porcelain status output.
 *
 * A rename or copy occupies two NUL records (`XY new\0old\0`), and the `R`/`C`
 * may sit in either column: git >= 2.18 detects renames in the worktree too
 * (`status.renames`), emitting ` R new\0old\0` for an unstaged rename and
 * `RM`/`R ` for a staged one. Only consuming the second record for an index
 * `R`/`C` turned the worktree form's `old` field into a bogus extra entry
 * whose status was whatever its first two path characters happened to be.
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
    const isRenameOrCopy =
      isRenameOrCopyColumn(indexStatus) || isRenameOrCopyColumn(worktreeStatus);
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
  return parsePorcelainStatus(await git(['status', '--porcelain=v1', '-z'], repoDir));
}

/** Default per-directory cap for untracked-directory expansion. */
const DEFAULT_MAX_UNTRACKED_FILES_PER_DIR = 5000;

/**
 * Resolves the per-directory expansion cap, honoring the same
 * FIREFORGE_MAX_UNTRACKED_FILES override the status command documents.
 */
export function resolveMaxUntrackedFilesPerDir(): number {
  const raw = process.env['FIREFORGE_MAX_UNTRACKED_FILES'];
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_UNTRACKED_FILES_PER_DIR;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(
      `Ignoring FIREFORGE_MAX_UNTRACKED_FILES="${raw}" — expected a positive integer. Falling back to ${DEFAULT_MAX_UNTRACKED_FILES_PER_DIR}.`
    );
    return DEFAULT_MAX_UNTRACKED_FILES_PER_DIR;
  }
  return parsed;
}

/**
 * Expands collapsed untracked directory entries into individual file entries.
 * Git status may report "?? dir/" instead of listing each file underneath.
 *
 * Expansion is capped per directory (FIREFORGE_MAX_UNTRACKED_FILES, default
 * 5000) with a warning on overflow. Without the cap, `reset --dry-run` after
 * an interrupted download (unborn HEAD, the entire ~300k file tree
 * untracked) enumerates and prints every file.
 *
 * @param repoDir - Repository directory
 * @param entries - Parsed status entries
 * @returns Status entries with untracked directories expanded to individual
 *   files
 */
export async function expandUntrackedDirectoryEntries(
  repoDir: string,
  entries: GitStatusEntry[]
): Promise<GitStatusEntry[]> {
  const expanded: GitStatusEntry[] = [];
  const maxPerDir = resolveMaxUntrackedFilesPerDir();

  for (const entry of entries) {
    if (!entry.isUntracked || !entry.file.endsWith('/')) {
      expanded.push(entry);
      continue;
    }

    const individualFiles = await getUntrackedFilesInDir(repoDir, entry.file);
    if (individualFiles.length > maxPerDir) {
      warn(
        `Untracked directory ${entry.file} contains ${individualFiles.length} files — only the first ${maxPerDir} are listed. Add a .gitignore entry or clean the directory.`
      );
    }
    for (const file of individualFiles.slice(0, maxPerDir)) {
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
 * Gets all untracked files (including files inside untracked directories).
 * @param repoDir - Repository directory
 * @returns List of untracked file paths
 */
export async function getUntrackedFiles(repoDir: string): Promise<string[]> {
  // Use git ls-files to get all untracked files, which properly expands directories
  const output = await git(['ls-files', '--others', '--exclude-standard'], repoDir);
  return output.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Gets untracked files within a specific directory.
 * Uses path-scoped git ls-files for efficiency in large repos.
 * @param repoDir - Repository directory
 * @param dir - Directory path (relative to repo root)
 * @returns List of untracked file paths relative to repo root
 */
export async function getUntrackedFilesInDir(repoDir: string, dir: string): Promise<string[]> {
  const output = await git(['ls-files', '--others', '--exclude-standard', '--', dir], repoDir);
  return output.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Gets modified (tracked) files within a specific directory.
 * Uses path-scoped git diff for efficiency in large repos.
 * @param repoDir - Repository directory
 * @param dir - Directory path (relative to repo root)
 * @returns List of modified file paths relative to repo root
 */
export async function getModifiedFilesInDir(repoDir: string, dir: string): Promise<string[]> {
  const output = await git(['diff', '--name-only', 'HEAD', '--', dir], repoDir);
  return output.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Checks if any of the specified files have uncommitted changes.
 * @param repoDir - Repository directory
 * @param files - File paths to check (relative to repo root)
 * @returns List of dirty file paths
 */
export async function getDirtyFiles(repoDir: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  // Check both staged and unstaged changes for the given files
  const trackedOutput = await git(['diff', '--name-only', 'HEAD', '--', ...files], repoDir);
  const tracked = trackedOutput.split('\n').filter((line) => line.trim().length > 0);

  // Also check for untracked files
  const untrackedOutput = await git(
    ['ls-files', '--others', '--exclude-standard', '--', ...files],
    repoDir
  );
  const untracked = untrackedOutput.split('\n').filter((line) => line.trim().length > 0);

  return [...new Set([...tracked, ...untracked])].sort();
}
