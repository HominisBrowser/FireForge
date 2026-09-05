// SPDX-License-Identifier: EUPL-1.2
/**
 * Engine-side and workspace-side mutation bodies for `furnace remove`.
 *
 * Split out of `remove.ts`, where the two `perform*RemovalMutations`
 * functions held the file at the per-file line cap with
 * `furnaceRemoveCommand` at the per-function cap. Extracting them inside the
 * same file would trade a function-length problem for a file-length one.
 *
 * Both run inside the CALLER's rollback journal rather than opening their
 * own, so a failure anywhere in the remove still restores the whole
 * operation as a single unit.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { removeCustomFtlJarMnEntry } from '../../core/furnace-apply-ftl.js';
import {
  getOverrideEngineTargetPath,
  isOverrideCopyCandidate,
  restoreOverrideFileToBaseline,
} from '../../core/furnace-apply-helpers.js';
import { extractComponentChecksums } from '../../core/furnace-checksum-utils.js';
import type { FurnacePaths } from '../../core/furnace-config.js';
import {
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import type { RollbackJournal } from '../../core/furnace-rollback.js';
import { snapshotDir, snapshotFile } from '../../core/furnace-rollback.js';
import { isGitRepository } from '../../core/git.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig, FurnaceState, OverrideComponentConfig } from '../../types/furnace.js';
import { pathExists, removeDir, removeFile } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import { normalizePathSlashes } from '../../utils/paths.js';
import { removeDeployedCustomFiles } from './remove-state.js';

/**
 * Restores every override-deployed file in `engine/` to its pristine HEAD
 * state, inverting what `applyOverrideComponent` would have written. Files that
 * existed in HEAD are restored via `git restore`; files the override
 * introduced (not in HEAD) are deleted outright.
 *
 * The restore set is the **union** of (a) files currently in the override
 * workspace directory and (b) filenames recorded in `previousChecksumKeys`
 * — i.e. files we know we deployed last time, even if the developer has
 * since deleted them from the workspace. Without (b), a workspace deletion
 * leaves an orphaned engine copy that `furnace remove` would never see.
 *
 * Every touched engine file is snapshotted into the rollback journal before
 * mutation so a mid-remove failure still rolls the engine back to its
 * pre-command state.
 */
async function restoreOverrideEngineFiles(
  engineDir: string,
  overrideDir: string,
  overrideConfig: OverrideComponentConfig,
  previousChecksumKeys: string[],
  ftlDir: string,
  journal: RollbackJournal
): Promise<{ restored: number; removed: number }> {
  // Engine-as-git is a hard precondition for restoration: git HEAD is the only
  // honest oracle for "what was there before the override". If the engine is
  // not a git repo we refuse rather than silently leaving files behind — the
  // previous warn-and-continue behaviour is exactly what this fix removes.
  if (!(await isGitRepository(engineDir))) {
    throw new FurnaceError(
      'Cannot restore override files: engine is not a git repository. Run "fireforge download" to initialise it.'
    );
  }

  // Build the union of "files we still see on disk" and "files state.json
  // claims we deployed". The state set is the only authority for files that
  // were deployed and later deleted from the workspace; the workspace set is
  // the only authority for files added since last apply that have not yet
  // been recorded in state. We need both.
  const fileSet = new Set<string>();
  if (await pathExists(overrideDir)) {
    const entries = await readdir(overrideDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isOverrideCopyCandidate(entry.name, overrideConfig.type)) continue;
      fileSet.add(entry.name);
    }
  }
  for (const key of previousChecksumKeys) {
    fileSet.add(key);
  }

  let restored = 0;
  let removed = 0;
  for (const fileName of fileSet) {
    const enginePath = getOverrideEngineTargetPath(engineDir, overrideConfig, fileName, ftlDir);
    const action = await restoreOverrideFileToBaseline(engineDir, enginePath, journal);
    if (action === 'restored') restored += 1;
    else if (action === 'removed') removed += 1;
  }

  return { restored, removed };
}
/**
 * Engine-side and workspace-side removal for an OVERRIDE component.
 *
 * Runs inside the caller's rollback journal rather than opening its own, so
 * a failure anywhere in the remove still restores the whole operation as a
 * single unit.
 */
export async function performOverrideRemovalMutations(args: {
  name: string;
  paths: { engine: string };
  furnacePaths: FurnacePaths;
  freshConfig: FurnaceConfig;
  freshState: FurnaceState;
  ftlDir: string;
  journal: RollbackJournal;
}): Promise<void> {
  const { name, paths, furnacePaths, freshConfig, freshState, ftlDir, journal } = args;
  const overrideConfig = freshConfig.overrides[name];
  const dir = join(furnacePaths.overridesDir, name);

  // Restore deployed engine files BEFORE removing the workspace
  // directory. The restore set is the union of (a) files currently in
  // the workspace and (b) files state.json says we deployed last time
  // — without (b), source-side deletions would orphan engine copies
  // that this command can never see again.
  if (overrideConfig?.basePath) {
    const previousKeys = Object.keys(
      extractComponentChecksums(freshState.appliedChecksums, 'override', name)
    );
    const { restored, removed } = await restoreOverrideEngineFiles(
      paths.engine,
      dir,
      overrideConfig,
      previousKeys,
      ftlDir,
      journal
    );
    if (restored > 0) {
      info(
        `Restored ${restored} file${restored === 1 ? '' : 's'} in engine/${overrideConfig.basePath} to Firefox baseline`
      );
    }
    if (removed > 0) {
      info(
        `Removed ${removed} override-introduced file${removed === 1 ? '' : 's'} from engine/${overrideConfig.basePath}`
      );
    }
  }

  if (await pathExists(dir)) {
    await snapshotDir(journal, dir);
    await removeDir(dir);
    info(`Deleted components/overrides/${name}/`);
  }
}
/**
 * Engine-side and workspace-side removal for a CUSTOM component.
 * Sibling of {@link performOverrideRemovalMutations}; see its note.
 */
export async function performCustomRemovalMutations(args: {
  projectRoot: string;
  name: string;
  paths: { engine: string };
  furnacePaths: FurnacePaths;
  freshConfig: FurnaceConfig;
  ftlDir: string;
  journal: RollbackJournal;
}): Promise<void> {
  const { projectRoot, name, paths, furnacePaths, freshConfig, ftlDir, journal } = args;
  const customConfig = freshConfig.custom[name];

  // Custom-component removal mutates engine files (jar.mn,
  // customElements.js, deployed widgets, optional .ftl) and the
  // rollback journal is the only safety net for those edits while
  // the command runs. The git-as-engine precondition is enforced
  // before the lock is acquired (see furnaceRemoveCommand above)
  // so if we reach this point, the engine is a git repository.

  if (customConfig?.register) {
    // customElements.js is the only file removeCustomElementRegistration touches.
    await snapshotFile(journal, join(paths.engine, 'toolkit/content/customElements.js'));
    await removeCustomElementRegistration(paths.engine, name);
    info(`Deregistered ${name} from customElements.js`);
  }

  // jar.mn is the only file removeJarMnEntries touches.
  await snapshotFile(journal, join(paths.engine, 'toolkit/content/jar.mn'));
  await removeJarMnEntries(paths.engine, name);
  info(`Removed ${name} entries from toolkit/content/jar.mn`);

  const dir = join(furnacePaths.customDir, name);
  if (await pathExists(dir)) {
    await snapshotDir(journal, dir);
    await removeDir(dir);
    info(`Deleted components/custom/${name}/`);
  }
  // Clean up deployed files in engine (per-file — see helper doc).
  if (customConfig?.targetPath) {
    await removeDeployedCustomFiles(
      projectRoot,
      paths.engine,
      name,
      customConfig.targetPath,
      journal
    );
  }

  // Localized components deploy a .ftl outside targetPath into the
  // shared Fluent tree; apply writes it, so remove must delete it too
  // or the locale payload is orphaned.
  if (customConfig?.localized) {
    const ftlRel = join(ftlDir, `${name}.ftl`);
    const ftlPath = join(paths.engine, ftlRel);
    if (await pathExists(ftlPath)) {
      await snapshotFile(journal, ftlPath);
      await removeFile(ftlPath);
      // `ftlRel` is a native join, so on Windows an interpolated
      // `engine/${ftlRel}` renders as `engine/toolkit\locales\...` — one
      // message with both separators. Print the engine-relative form.
      info(`Deleted localized file engine/${normalizePathSlashes(ftlRel)}`);
    }
    // Drop the locale jar.mn chrome registration that `applyCustomFtlFile`
    // wrote during deploy — otherwise the engine is left with a
    // `locale/.../${name}.ftl` entry pointing at a file just deleted, which
    // breaks the next package-manifest validation.
    await removeCustomFtlJarMnEntry(paths.engine, `${name}.ftl`, ftlDir, customConfig, journal);
  }
}
