// SPDX-License-Identifier: EUPL-1.2
/** What `download --force` checks and does around swapping engine/ for its replacement. */
import { rename } from 'node:fs/promises';

import { loadState } from '../core/config.js';
import { getHead, isGitRepository, isMissingHeadError } from '../core/git.js';
import { getWorkingTreeStatus } from '../core/git-status.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { toError } from '../utils/errors.js';
import { pathExists, pathExistsStrict, removeDir } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';

/**
 * Collects the set of patch-touched files from the manifest.
 * Returns an empty set when the patches directory or manifest is absent.
 */
export async function getPatchTouchedFiles(patchesDir: string): Promise<Set<string>> {
  if (!(await pathExists(patchesDir))) return new Set();

  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest || manifest.patches.length === 0) return new Set();

  const files = new Set<string>();
  for (const patch of manifest.patches) {
    for (const file of patch.filesAffected) {
      files.add(file);
    }
  }
  return files;
}

/**
 * Describes what a forced replacement would discard from an existing
 * engine: changed paths against HEAD (tracked edits, applied patches, new
 * untracked files; ignored paths such as the objdir are not work), and a
 * HEAD that moved off the recorded base commit. Returns `undefined` when
 * nothing would be lost, including an engine that is not a git repository
 * or has no commit yet: that is the broken tree `--force` exists to replace.
 */
export async function describeForcedReplacementLoss(
  engineDir: string,
  patchesDir: string,
  baseCommit: string | undefined
): Promise<string | undefined> {
  if (!(await isGitRepository(engineDir))) return undefined;
  let head: string;
  try {
    head = await getHead(engineDir);
  } catch (error: unknown) {
    if (isMissingHeadError(error)) return undefined;
    throw error;
  }

  const entries = await getWorkingTreeStatus(engineDir);
  const headMoved = baseCommit !== undefined && head !== baseCommit;
  if (entries.length === 0 && !headMoved) return undefined;

  const parts: string[] = [];
  if (entries.length > 0) {
    const patchFiles = [...(await getPatchTouchedFiles(patchesDir))];
    const claimed = entries.filter((entry) =>
      entry.file.endsWith('/')
        ? patchFiles.some((file) => file.startsWith(entry.file))
        : patchFiles.includes(entry.file)
    ).length;
    const unclaimed = entries.length - claimed;
    parts.push(
      `engine/ has ${entries.length} changed path(s) against HEAD: ` +
        `${claimed} match the patch queue, ${unclaimed} do not` +
        (unclaimed > 0 ? ' (unexported work that exists nowhere else).' : '.')
    );
  }
  if (headMoved) {
    parts.push(
      `engine/ HEAD ${head.slice(0, 12)} is not the recorded base commit ${baseCommit.slice(0, 12)}, so commits made in engine/ are discarded too.`
    );
  }
  parts.push('--force replaces the whole directory.');
  return parts.join(' ');
}

/**
 * What a forced replacement was confirmed against: engine/'s HEAD, its
 * working-tree status, and the recorded base commit. The download runs
 * without the engine-session lock, so the activation compares this again
 * under the lock and refuses when a peer changed engine/ in between, rather
 * than discarding work nobody confirmed losing.
 */
export async function forcedReplacementFingerprint(
  engineDir: string,
  projectRoot: string
): Promise<string> {
  const { baseCommit } = await loadState(projectRoot);
  if (!(await pathExistsStrict(engineDir))) return JSON.stringify({ engine: 'absent', baseCommit });
  if (!(await isGitRepository(engineDir))) return JSON.stringify({ engine: 'not-git', baseCommit });
  let head: string;
  try {
    head = await getHead(engineDir);
  } catch (error: unknown) {
    if (isMissingHeadError(error)) return JSON.stringify({ engine: 'no-head', baseCommit });
    throw error;
  }
  const entries = (await getWorkingTreeStatus(engineDir))
    .map((entry) => `${entry.status} ${entry.file}`)
    .sort();
  return JSON.stringify({ engine: 'git', head, entries, baseCommit });
}

/**
 * Moves engine/ aside to `backupDir` and the replacement into its place,
 * moving the backup back when the second rename fails.
 */
export async function activateReplacementEngine(args: {
  engineDir: string;
  replacementDir: string;
  backupDir: string;
}): Promise<void> {
  const { engineDir, replacementDir, backupDir } = args;
  await rename(engineDir, backupDir);
  try {
    await rename(replacementDir, engineDir);
  } catch (error: unknown) {
    try {
      await rename(backupDir, engineDir);
    } catch (restoreError: unknown) {
      const cause = toError(restoreError);
      warn(
        `Could not restore previous engine after replacement activation failed. Previous engine backup remains at ${backupDir}. Remove ${engineDir} if it exists, then move the backup back to engine/.`
      );
      verbose(`Engine restore failure detail: ${cause.message}`);
      if (cause.stack) {
        verbose(cause.stack);
      }
    }
    throw error;
  }
}

/**
 * Puts the backed-up engine/ back after an activated replacement failed,
 * telling the operator where the backup is when that is not possible.
 */
export async function restorePreviousEngine(args: {
  engineDir: string;
  backupDir: string;
  reason: unknown;
}): Promise<void> {
  const { engineDir, backupDir, reason } = args;
  const cause = toError(reason);
  verbose(`Restoring previous engine after failed forced download: ${cause.message}`);
  try {
    await removeDir(engineDir);
    await rename(backupDir, engineDir);
    warn('Restored the previous engine/ after the forced replacement failed.');
  } catch (restoreError: unknown) {
    const restoreCause = toError(restoreError);
    warn(
      `Could not restore the previous engine automatically. Previous engine backup remains at ${backupDir}. Remove the failed engine/ and move that backup back to engine/ before retrying.`
    );
    verbose(`Engine restore failure detail: ${restoreCause.message}`);
    if (restoreCause.stack) {
      verbose(restoreCause.stack);
    }
  }
}
