// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
}

/** Creates an empty rollback journal for tracking touched files and created directories. */
export function createRollbackJournal(): RollbackJournal {
  return {
    files: new Map(),
    createdDirs: new Set(),
  };
}

/** Records a directory that should be removed if the operation later rolls back. */
export function recordCreatedDir(journal: RollbackJournal, dirPath: string): void {
  journal.createdDirs.add(dirPath);
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
  await writeFile(filePath, snapshot.content ?? new Uint8Array());

  if (snapshot.mode !== undefined) {
    await chmod(filePath, snapshot.mode);
  }
}

/** Restores all snapshotted files and removes directories created during the operation. */
export async function restoreRollbackJournal(journal: RollbackJournal): Promise<void> {
  const fileEntries = [...journal.files.entries()].sort(
    ([left], [right]) => right.length - left.length
  );
  for (const [filePath, snapshot] of fileEntries) {
    await restoreFile(filePath, snapshot);
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
