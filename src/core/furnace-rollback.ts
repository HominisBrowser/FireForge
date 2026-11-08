// SPDX-License-Identifier: EUPL-1.2
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import { assert } from '../utils/assert.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import {
  type AuthoredImage,
  authoredImage,
  authoredImageMatches,
  authoredStagingFile,
  type AuthoredTarget,
  authoredTargetForFile,
  observeAuthoredMutations,
  withAuthoredPathLock,
} from './authored/write-lock.js';
import { routedAuthoringPath } from './authored/writer.js';

const authoringAliases = new WeakMap<RollbackJournal, Map<string, string>>();

interface FileSnapshot extends AuthoredImage {
  compareBeforeRestore?: boolean;
  postimage?: AuthoredImage;
}

export interface RollbackJournal {
  files: Map<string, FileSnapshot>;
  createdDirs: Set<string>;
  /** Empty directories removed by a transaction; recreated only while absent. */
  removedEmptyDirs?: Map<string, number>;
  /** Paths that were skipped during snapshotDir because they are symlinks. */
  skippedSymlinks: Set<string>;
  /** Standalone writers require compare-before-restore for legacy paths as well. */
  conditionalLegacy?: boolean;
}

/** Creates an empty rollback journal for tracking touched files and created directories. */
export function createRollbackJournal(): RollbackJournal {
  return {
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  };
}

/** Removes only an empty real directory and journals its mode for rollback. */
export async function removeEmptyDirectory(journal: RollbackJournal, path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new FurnaceError(`Refusing to remove a non-directory orphan: ${path}`);
  await rmdir(path);
  (journal.removedEmptyDirs ??= new Map()).set(path, metadata.mode & 0o777);
}

/** Attribute cooperative publications to this operation without absorbing later peer writes. */
export function trackRollbackMutations<T>(
  journal: () => RollbackJournal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return observeAuthoredMutations(
    {
      before: (images) => {
        for (const [path, image] of images) {
          const snapshot = journal()?.files.get(path);
          if (!snapshot || !authoredImageMatches(image, snapshot.postimage ?? snapshot))
            throw new FurnaceError(`authored-rollback-preimage-moved: ${path}`);
        }
      },
      after: (images) => {
        for (const [path, image] of images) {
          const snapshot = journal()?.files.get(path);
          if (snapshot) snapshot.postimage = image;
        }
      },
    },
    operation
  );
}

/** Records a directory that should be removed if the operation later rolls back. */
export function recordCreatedDir(journal: RollbackJournal, dirPath: string): void {
  journal.createdDirs.add(dirPath);
}

/**
 * Recursively snapshots every file under a directory tree so a later rollback
 * can restore deleted files. Skips symlinks to avoid following them out of the
 * tree. The directory itself is not recorded as "created", so callers that
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
export async function snapshotFile(
  journal: RollbackJournal,
  filePath: string,
  options: { compareBeforeRestore?: boolean } = {}
): Promise<void> {
  // Journal keys are the paths rollback will later write back to, and the
  // restore runs from whatever cwd the process happens to be in by then. A
  // relative key would therefore restore somewhere other than where the
  // snapshot was taken, silently, and only on the failure path where nobody
  // is watching. Every caller composes an absolute path already, and this
  // keeps it that way.
  assert(isAbsolute(filePath), () => `snapshot path is absolute (got "${filePath}")`);

  const original = filePath;
  const routed = await routedAuthoringPath(filePath);
  if (routed !== filePath && (await pathExists(routed))) filePath = routed;
  const authored = await authoredTargetForFile(filePath);
  if (authored) filePath = authored.file;
  if (filePath !== original) {
    let aliases = authoringAliases.get(journal);
    if (!aliases) {
      aliases = new Map();
      authoringAliases.set(journal, aliases);
    }
    aliases.set(original, filePath);
  }
  if (journal.files.has(filePath)) {
    return;
  }

  if (!(await pathExists(filePath))) {
    journal.files.set(filePath, { existed: false, ...options });
    return;
  }

  const [content, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  journal.files.set(filePath, {
    existed: true,
    content,
    mode: fileStat.mode,
    ...options,
  });
}

/**
 * Asserts that a file about to be mutated was already snapshotted into the
 * journal that will undo the mutation.
 *
 * The snapshot list and the mutation list are separately maintained in every
 * caller that writes conditionally, and they drift: a new conditional write
 * whose matching snapshot condition was not updated produces a file the
 * rollback cannot restore, and nothing notices until a real failure. This
 * checks the pairing at the point of the write, where the two lists are
 * supposed to agree.
 *
 * @param journal - The journal that will restore this file
 * @param filePath - Absolute path about to be written
 * @param context - What is about to write it, for the failure message
 * @throws {@link InternalInvariantError} when the file was never snapshotted.
 */
export function assertSnapshotted(
  journal: RollbackJournal,
  filePath: string,
  context: string
): void {
  assert(
    journal.files.has(authoringAliases.get(journal)?.get(filePath) ?? filePath),
    () => `${context} snapshotted "${filePath}" before mutating it`
  );
}

async function restoreFile(
  filePath: string,
  snapshot: FileSnapshot,
  authoredRoot?: string
): Promise<void> {
  if (!snapshot.existed) {
    await rm(filePath, { force: true });
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });

  // Publish restored bytes with an atomic rename. Authored files stage in
  // ignored runtime storage; legacy paths retain a sibling temp file. A
  // direct writeFile would race with any in-flight write by the body (e.g. a
  // signal-handler-driven rollback landing on top of a still-running
  // `writeFile('corrupted')`), producing interleaved byte sequences like
  // `"pristined"` where the first 8 bytes come from the rollback write and
  // the trailing byte from the body write. rename(2) is atomic within a
  // filesystem, so either write wins outright and the target is never left
  // in a hybrid state.
  const tempPath = authoredRoot
    ? await authoredStagingFile(authoredRoot)
    : `${filePath}.rollback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

interface RestoreGroup {
  target?: AuthoredTarget;
  entries: Array<[string, FileSnapshot]>;
}

async function restoreGroups(entries: Array<[string, FileSnapshot]>): Promise<RestoreGroup[]> {
  const groups = new Map<string, RestoreGroup>();
  for (const entry of entries) {
    const target = await authoredTargetForFile(entry[0]);
    const key = target
      ? `${target.root}\0${target.path.normalize('NFC').toLocaleLowerCase('en-US')}`
      : entry[0];
    let group = groups.get(key);
    if (!group) {
      group = { entries: [], ...(target ? { target } : {}) };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

async function restoreGroup(group: RestoreGroup, conditionalLegacy = false): Promise<void> {
  const restore = async (): Promise<void> => {
    for (const [path, snapshot] of group.entries) {
      if (group.target || conditionalLegacy || snapshot.compareBeforeRestore)
        if (!authoredImageMatches(await authoredImage(path), snapshot.postimage ?? snapshot))
          throw new FurnaceError(`authored-rollback-drift: ${path}; preserving a later edit`);
    }
    for (const [path, snapshot] of group.entries) {
      await restoreFile(path, snapshot, group.target?.root);
      if (group.target || conditionalLegacy)
        snapshot.postimage = {
          existed: snapshot.existed,
          ...(snapshot.content ? { content: snapshot.content } : {}),
          ...(snapshot.mode !== undefined ? { mode: snapshot.mode } : {}),
        };
    }
  };
  if (group.target) await withAuthoredPathLock(group.target.root, group.target.path, restore);
  else await restore();
}

/** Restores all snapshotted files and removes directories created during the operation. */
export async function restoreRollbackJournal(journal: RollbackJournal): Promise<void> {
  const fileEntries = [...journal.files.entries()].sort(
    ([left], [right]) => right.length - left.length
  );
  const groups = await restoreGroups(fileEntries);

  // Restore independent groups in parallel with bounded concurrency. A source
  // and its declaration share one lock and one preflight before either changes.
  const errors: Array<{ path: string; error: string }> = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < groups.length) {
      const current = index++;
      const group = groups[current];
      if (!group) break;
      try {
        await restoreGroup(group, journal.conditionalLegacy);
      } catch (error: unknown) {
        errors.push({
          path: group.entries.map(([path]) => path).join(', '),
          error: toError(error).message,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(RESTORE_CONCURRENCY, groups.length) }, () =>
    worker()
  );
  await Promise.all(workers);

  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.path}: ${e.error}`).join('; ');
    throw new FurnaceError(`Rollback failed to restore ${errors.length} file(s): ${summary}`);
  }

  // Directory removal is only safe once every file is back where it belongs:
  // a created directory may hold a restored file, and removing it recursively
  // would undo the restore we just performed. The throw above is what
  // normally enforces this. The assertion names it so a future early-return
  // or error-swallowing edit cannot quietly reach the rm loop with failures
  // outstanding.
  assert(errors.length === 0, 'all journal files restored before created directories are removed');

  for (const [path, mode] of journal.removedEmptyDirs ?? []) {
    try {
      await mkdir(path, { mode });
      await chmod(path, mode);
    } catch (error) {
      // Never chmod or replace a directory created by a later writer.
      throw new FurnaceError(
        `Cannot restore removed empty directory ${path}: ${toError(error).message}`
      );
    }
  }

  const createdDirs = [...journal.createdDirs].sort((left, right) => right.length - left.length);
  for (const dirPath of createdDirs) {
    if (await authoredTargetForFile(dirPath)) {
      try {
        await rmdir(dirPath);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(getNodeErrorCode(error) ?? '')) throw error;
      }
    } else await rm(dirPath, { recursive: true, force: true });
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
