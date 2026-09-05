// SPDX-License-Identifier: EUPL-1.2
/**
 * The minimal `readdir(..., { withFileTypes: true })` entry shape the furnace
 * apply path needs, plus the single predicate that decides whether an entry is
 * a copy candidate. Kept in its own leaf module so both `furnace-apply-helpers`
 * and its dry-run mirror can share one definition without importing each other.
 */

/** Structural subset of `Dirent` used by the furnace apply/dry-run walkers. */
export interface DirectoryEntry {
  isFile(): boolean;
  isSymbolicLink?(): boolean;
  name: string;
}

/**
 * True for a plain-file directory entry — symlinks and directories are
 * never copy candidates.
 *
 * @param entry - Directory entry to classify
 * @returns True when the entry is a regular file
 */
export function isRegularFile(entry: DirectoryEntry): boolean {
  if (!entry.isFile()) return false;
  if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) return false;
  return true;
}
