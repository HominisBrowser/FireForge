// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';

interface FileSnapshot {
  existed: boolean;
  content?: Uint8Array;
  mode?: number;
}

export interface RollbackJournal {
  files: Map<string, FileSnapshot>;
  createdDirs: Set<string>;
  /** Paths that were skipped during snapshotDir because they are symlinks. */
  skippedSymlinks: Set<string>;
}

/** Creates an empty rollback journal for tracking touched files and created directories. */
export function createRollbackJournal(): RollbackJournal {
  return {
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  };
}

/** Records a directory that should be removed if the operation later rolls back. */
export function recordCreatedDir(journal: RollbackJournal, dirPath: string): void {
  journal.createdDirs.add(dirPath);
}

/**
 * Recursively snapshots every file under a directory tree so a later rollback
 * can restore deleted files. Skips symlinks to avoid following them out of the
 * tree. The directory itself is not recorded as "created" — callers that
 * intend to delete and restore the directory should record it explicitly.
 *
 * Safe to call on a missing path: it returns without recording anything.
 */
export async function snapshotDir(journal: RollbackJournal, dirPath: string): Promise<void> {
  if (!(await pathExists(dirPath))) {
    return;
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      journal.skippedSymlinks.add(join(dirPath, entry.name));
      continue;
    }
    const childPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await snapshotDir(journal, childPath);
    } else if (entry.isFile()) {
      await snapshotFile(journal, childPath);
    }
  }
}

/** Snapshots a file once so rollback can restore its previous contents or absence. */
export async function snapshotFile(journal: RollbackJournal, filePath: string): Promise<void> {
  if (journal.files.has(filePath)) {
    return;
  }

  if (!(await pathExists(filePath))) {
    journal.files.set(filePath, { existed: false });
    return;
  }

  const [content, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  journal.files.set(filePath, {
    existed: true,
    content,
    mode: fileStat.mode,
  });
}

async function restoreFile(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(filePath, { force: true });
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });

  // Write to a sibling temp file and atomically rename it over the target.
  // A direct writeFile would race with any in-flight write by the body (e.g. a
  // signal-handler-driven rollback landing on top of a still-running
  // `writeFile('corrupted')` from the body), producing interleaved byte
  // sequences like `"pristined"` where the first 8 bytes come from the
  // rollback write and the trailing byte from the body write. rename(2) is
  // atomic within a filesystem, so either the body's write or the rollback's
  // rename wins outright and the target is never left in a hybrid state.
  const tempPath = `${filePath}.rollback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tempPath, snapshot.content ?? new Uint8Array());
    if (snapshot.mode !== undefined) {
      await chmod(tempPath, snapshot.mode);
    }
    await rename(tempPath, filePath);
  } catch (error: unknown) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Maximum number of concurrent file restorations during rollback. */
const RESTORE_CONCURRENCY = 8;

/** Restores all snapshotted files and removes directories created during the operation. */
export async function restoreRollbackJournal(journal: RollbackJournal): Promise<void> {
  const fileEntries = [...journal.files.entries()].sort(
    ([left], [right]) => right.length - left.length
  );

  // Restore files in parallel with bounded concurrency. Each restoreFile uses
  // atomic rename, so concurrent restorations to different paths are safe.
  const errors: Array<{ path: string; error: string }> = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < fileEntries.length) {
      const current = index++;
      const entry = fileEntries[current];
      if (!entry) break;
      const [filePath, snapshot] = entry;
      try {
        await restoreFile(filePath, snapshot);
      } catch (error: unknown) {
        errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(RESTORE_CONCURRENCY, fileEntries.length) }, () =>
    worker()
  );
  await Promise.all(workers);

  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.path}: ${e.error}`).join('; ');
    throw new FurnaceError(`Rollback failed to restore ${errors.length} file(s): ${summary}`);
  }

  const createdDirs = [...journal.createdDirs].sort((left, right) => right.length - left.length);
  for (const dirPath of createdDirs) {
    await rm(dirPath, { recursive: true, force: true });
  }
}

/** Restores a rollback journal and wraps rollback failures in a FurnaceError. */
export async function restoreRollbackJournalOrThrow(
  journal: RollbackJournal,
  context: string
): Promise<void> {
  try {
    await restoreRollbackJournal(journal);
  } catch (error: unknown) {
    const message = toError(error).message;
    throw new FurnaceError(`${context}; automatic rollback failed: ${message}`);
  }
}
