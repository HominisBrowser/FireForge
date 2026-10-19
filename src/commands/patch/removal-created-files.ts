// SPDX-License-Identifier: EUPL-1.2
/**
 * What `patch delete` and `patch retire` do to the files the removed patch
 * claims, shared so both commands say and do the same.
 *
 * A file the patch modifies stays in the engine with its edits, unmanaged.
 * A file the patch creates is different: once the patch is gone nothing
 * owns it, so a created file still on disk turns into an unmanaged file the
 * engine-clean gate reports. The summary names each such file (in the dry
 * run and at the prompt), and `--delete-created` removes them as part of
 * the confirmed operation.
 */

import { join } from 'node:path';

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import type { PatchQueueContext } from '../../core/patch-lint.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { pathExists, removeFile } from '../../utils/fs.js';

/** The summary lines for a removal's claimed files, and what to delete. */
export interface ClaimedFilePlan {
  /** One summary line per claimed file, plus a header. */
  summary: string[];
  /** Created files still on disk that the removal will delete. */
  deleteOnCommit: string[];
}

/**
 * Plans the claimed-file half of a removal.
 *
 * @param ctx - Queue context built before the removal
 * @param target - The patch about to leave the queue
 * @param engineDir - Engine directory
 * @param deleteCreated - Whether `--delete-created` was passed
 */
export async function planClaimedFiles(
  ctx: PatchQueueContext,
  target: PatchMetadata,
  engineDir: string,
  deleteCreated: boolean
): Promise<ClaimedFilePlan> {
  const created = ctx.entries.find((entry) => entry.filename === target.filename)?.createdFiles;
  const summary = [`files currently claimed by this patch (${target.filesAffected.length}):`];
  const deleteOnCommit: string[] = [];
  let lingering = 0;
  for (const file of target.filesAffected) {
    if (created?.has(file) !== true) {
      summary.push(`  ${file}  → will become unmanaged`);
      continue;
    }
    if (!(await pathExists(join(engineDir, file)))) {
      summary.push(`  ${file}  → created by this patch; already gone`);
      continue;
    }
    if (deleteCreated) {
      deleteOnCommit.push(file);
      summary.push(`  ${file}  → created by this patch; will be deleted (--delete-created)`);
    } else {
      lingering++;
      summary.push(`  ${file}  → created by this patch and still on disk: will become unmanaged`);
    }
  }
  if (lingering > 0) {
    summary.push(
      `${lingering} created file(s) are still on disk. Delete them first, or pass ` +
        '--delete-created to remove them with the patch; otherwise status reports them as unmanaged.'
    );
  }
  return { summary, deleteOnCommit };
}

/**
 * Deletes the created files a confirmed removal planned to delete.
 *
 * @param engineDir - Engine directory
 * @param files - Engine-relative paths from {@link planClaimedFiles}
 */
export async function deleteCreatedFiles(
  engineDir: string,
  files: readonly string[]
): Promise<void> {
  for (const file of files) {
    await removeFile(join(engineDir, file));
  }
}

/**
 * Runs a removal's locked commit, inside the engine-session lock as well
 * when it will delete engine files, so no engine-mutating peer runs while
 * created files disappear under it.
 *
 * @param projectRoot - Project root directory
 * @param command - Command name for lock attribution
 * @param plan - The claimed-file plan
 * @param waitLockSeconds - Wait budget for the engine lock
 * @param operation - The patch-directory-locked commit
 */
export async function withCreatedFileLock(
  projectRoot: string,
  command: string,
  plan: ClaimedFilePlan,
  waitLockSeconds: number | undefined,
  operation: () => Promise<void>
): Promise<void> {
  if (plan.deleteOnCommit.length === 0) {
    await operation();
    return;
  }
  await withEngineSessionLock(projectRoot, command, operation, {
    ...(waitLockSeconds !== undefined ? { waitLockSeconds } : {}),
  });
}
