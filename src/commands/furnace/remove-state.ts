// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadFurnaceState } from '../../core/furnace-config.js';
import { type RollbackJournal, snapshotFile } from '../../core/furnace-rollback.js';
import type { FurnaceState } from '../../types/furnace.js';
import { pathExists, removeDir, removeFile } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';

/**
 * Removes every checksum entry owned by the removed component.
 */
export function dropChecksumsByPrefix(state: FurnaceState, prefix: string): FurnaceState {
  const result = { ...state };
  if (state.appliedChecksums) {
    result.appliedChecksums = Object.fromEntries(
      Object.entries(state.appliedChecksums).filter(([k]) => !k.startsWith(prefix))
    );
  }
  if (state.engineChecksums) {
    result.engineChecksums = Object.fromEntries(
      Object.entries(state.engineChecksums).filter(([k]) => !k.startsWith(prefix))
    );
  }
  return result;
}

/**
 * Deletes the files a custom component deployed into its engine targetPath.
 *
 * Per-file, never a recursive `removeDir` of the whole directory: nothing
 * stops two components from sharing a targetPath (or a hand-edited config
 * from pointing at an upstream-shared directory), and the recursive delete
 * permanently destroyed the co-located files on success. The rollback
 * journal only protects the failure path. Deployed files come from the
 * component's state checksums, falling back to the conventional
 * `<name>.{mjs,css,ftl}` set when state carries no record (cleared by a
 * --force download or rebase). The directory itself is removed only when
 * nothing else lives in it afterwards.
 */
export async function removeDeployedCustomFiles(
  projectRoot: string,
  engineDir: string,
  name: string,
  targetPath: string,
  journal: RollbackJournal
): Promise<void> {
  const engineTargetDir = join(engineDir, targetPath);
  if (!(await pathExists(engineTargetDir))) return;

  const state = await loadFurnaceState(projectRoot);
  const checksumPrefix = `custom/${name}/`;
  const recordedFiles = Object.keys(state.appliedChecksums ?? {})
    .filter((key) => key.startsWith(checksumPrefix))
    .map((key) => key.slice(checksumPrefix.length));
  const deployedFiles =
    recordedFiles.length > 0 ? recordedFiles : [`${name}.mjs`, `${name}.css`, `${name}.ftl`];

  let deletedCount = 0;
  for (const file of deployedFiles) {
    const target = join(engineTargetDir, file);
    if (await pathExists(target)) {
      await snapshotFile(journal, target);
      await removeFile(target);
      deletedCount++;
    }
  }
  if (deletedCount > 0) {
    info(`Deleted ${deletedCount} deployed file(s) from engine/${targetPath}/`);
  }
  if ((await readdir(engineTargetDir)).length === 0) {
    await removeDir(engineTargetDir);
    info(`Removed now-empty engine/${targetPath}/`);
  }
}
