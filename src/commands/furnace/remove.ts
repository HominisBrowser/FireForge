// SPDX-License-Identifier: EUPL-1.2
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { confirm } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  extractComponentChecksums,
  getOverrideEngineTargetPath,
  isOverrideCopyCandidate,
  restoreOverrideFileToBaseline,
} from '../../core/furnace-apply-helpers.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { resolveFtlDir } from '../../core/furnace-constants.js';
import { recordFurnaceRollbackFailure, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
  type RollbackJournal,
  snapshotDir,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { isGitRepository } from '../../core/git.js';
import { deregisterTestManifest } from '../../core/manifest-register.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceRemoveOptions } from '../../types/commands/index.js';
import type { FurnaceState } from '../../types/furnace.js';
import type { ComponentType, OverrideComponentConfig } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { pathExists, readText, removeDir, removeFile, writeText } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, outro, warn } from '../../utils/logger.js';

/**
 * Removes an entire TOML section (header + body lines) for a given test file.
 * Matches from `["filename"]` up to the next section header `[` or end-of-file,
 * consuming the section's metadata keys and surrounding blank lines. This is
 * more robust than a single-line regex that only removes the header.
 */
function removeTomlSection(toml: string, testFileName: string): string {
  const lines = toml.split('\n');
  const header = `["${testFileName}"]`;
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]?.trim() === header) {
      // Skip the header line
      i++;
      // Skip all body lines until the next section header or EOF
      while (i < lines.length && !/^\s*\[/.test(lines[i] ?? '')) {
        i++;
      }
      // Collapse any double blank line left behind
      while (result.length > 0 && result[result.length - 1]?.trim() === '') {
        result.pop();
      }
      // Re-add a single blank separator if the next line is another section
      if (i < lines.length && result.length > 0) {
        result.push('');
      }
    } else {
      result.push(lines[i] ?? '');
      i++;
    }
  }

  // Trim trailing blank lines and ensure single trailing newline
  while (result.length > 0 && result[result.length - 1]?.trim() === '') {
    result.pop();
  }
  return result.join('\n') + '\n';
}

/**
 * Finds which section a component belongs to in the furnace config.
 * @returns The component type, or undefined if not found
 */
function findComponentType(
  config: { stock: string[]; overrides: Record<string, unknown>; custom: Record<string, unknown> },
  name: string
): ComponentType | undefined {
  if (config.stock.includes(name)) return 'stock';
  if (name in config.overrides) return 'override';
  if (name in config.custom) return 'custom';
  return undefined;
}

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
 * Removes generated browser mochitest files associated with a custom component.
 * @param name - Custom component tag name
 * @param projectRoot - Root directory of the project
 * @param journal - Rollback journal that snapshots files before deletion
 *
 * The function preserves its original warn-and-continue contract: any failure
 * during cleanup is reported via warn() rather than thrown. Snapshots taken
 * before a failed step are still recorded so a later rollback (triggered by
 * an error elsewhere in the command) can restore whatever was deleted before
 * the failure.
 */
async function cleanupCustomTestFiles(
  name: string,
  projectRoot: string,
  journal: RollbackJournal
): Promise<void> {
  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch (error: unknown) {
    warn(
      `Could not load config for test cleanup — ${toError(error).message}. Remove test files manually if needed.`
    );
    return;
  }

  const paths = getProjectPaths(projectRoot);
  const binaryName = forgeConfig.binaryName;
  const strippedName = name.startsWith('moz-') ? name.slice(4) : name;
  const withoutBinaryPrefix = strippedName.startsWith(binaryName + '-')
    ? strippedName.slice(binaryName.length + 1)
    : strippedName;
  const underscored = withoutBinaryPrefix.replace(/-/g, '_');
  const testFileName = `browser_${binaryName}_${underscored}.js`;
  const testDir = join(paths.engine, 'browser/base/content/test', binaryName);

  if (!(await pathExists(testDir))) return;

  // Step 1: Delete the test file itself
  try {
    const testFilePath = join(testDir, testFileName);
    if (await pathExists(testFilePath)) {
      await snapshotFile(journal, testFilePath);
      await unlink(testFilePath);
      info(`Deleted test file: ${testFileName}`);
    }
  } catch (error: unknown) {
    warn(
      `Could not delete test file ${testFileName} — ${toError(error).message}. Remove it manually if needed.`
    );
  }

  // Step 2: Remove the test entry from browser.toml
  try {
    const tomlPath = join(testDir, 'browser.toml');
    if (await pathExists(tomlPath)) {
      const toml = await readText(tomlPath);
      const entryPattern = `["${testFileName}"]`;
      if (toml.includes(entryPattern)) {
        await snapshotFile(journal, tomlPath);
        const updated = removeTomlSection(toml, testFileName);
        await writeText(tomlPath, updated);
      }
    }
  } catch (error: unknown) {
    warn(
      `Could not update browser.toml — ${toError(error).message}. Remove the test entry manually if needed.`
    );
  }

  // Step 3: Clean up empty test directory and deregister from moz.build
  try {
    const remaining = await readdir(testDir);
    const hasTests = remaining.some((f) => f.startsWith('browser_') && f.endsWith('.js'));
    if (!hasTests) {
      await snapshotDir(journal, testDir);
      await removeDir(testDir);
      info(`Deleted empty test directory: browser/base/content/test/${binaryName}/`);
      const mozBuildPath = join(paths.engine, 'browser/base/moz.build');
      await snapshotFile(journal, mozBuildPath);
      if (await deregisterTestManifest(paths.engine, binaryName)) {
        info('Deregistered test manifest from browser/base/moz.build');
      }
    }
  } catch (error: unknown) {
    warn(
      `Could not clean up test directory — ${toError(error).message}. Remove it manually if needed.`
    );
  }
}

function dropChecksumsByPrefix(state: FurnaceState, prefix: string): FurnaceState {
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
 * Runs the furnace remove command to remove a component from the workspace.
 * @param projectRoot - Root directory of the project
 * @param name - Component tag name to remove
 * @param options - CLI options
 */
export async function furnaceRemoveCommand(
  projectRoot: string,
  name: string,
  options: FurnaceRemoveOptions = {}
): Promise<void> {
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  intro('Furnace Remove');

  const config = await loadFurnaceConfig(projectRoot);
  const state = await loadFurnaceState(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  // Find which section the component belongs to
  const type = findComponentType(config, name);

  if (!type) {
    throw new FurnaceError(
      `Component "${name}" not found in furnace.json. Run "fireforge furnace list" to see registered components.`,
      name
    );
  }

  // Require --yes in non-interactive mode to prevent silent removals
  if (!isInteractive && !options.yes) {
    throw new FurnaceError(
      `Cannot remove "${name}" in non-interactive mode without --yes flag.`,
      name
    );
  }

  // Confirm removal (skip if --yes)
  if (!options.yes && isInteractive) {
    const confirmed = await confirm({
      message: `Remove ${type} component "${name}"?`,
    });

    if (isCancel(confirmed) || !confirmed) {
      cancel('Remove cancelled');
      return;
    }
  }

  // Begin transactional mutation: every file deleted or rewritten is first
  // snapshotted in a rollback journal so any failure mid-removal restores the
  // workspace and engine to their pre-command state. The mutation runs under
  // the furnace-wide lock and is registered with the global SIGINT/SIGTERM
  // rollback pathway.
  const paths = getProjectPaths(projectRoot);

  await runFurnaceMutation(projectRoot, 'remove-rollback', async (ctx) => {
    const journal = createRollbackJournal();
    ctx.registerJournal(journal);

    try {
      if (type === 'override') {
        const overrideConfig = config.overrides[name];
        const dir = join(furnacePaths.overridesDir, name);

        // Restore deployed engine files BEFORE removing the workspace
        // directory. The restore set is the union of (a) files currently in
        // the workspace and (b) files state.json says we deployed last time
        // — without (b), source-side deletions would orphan engine copies
        // that this command can never see again.
        if (overrideConfig?.basePath) {
          const previousKeys = Object.keys(
            extractComponentChecksums(state.appliedChecksums, 'override', name)
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
      } else if (type === 'custom') {
        const customConfig = config.custom[name];
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
        // Clean up deployed files in engine
        if (customConfig?.targetPath) {
          const engineDir = join(paths.engine, customConfig.targetPath);
          if (await pathExists(engineDir)) {
            await snapshotDir(journal, engineDir);
            await removeDir(engineDir);
            info(`Deleted deployed files from engine/${customConfig.targetPath}/`);
          }
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
            info(`Deleted localized file engine/${ftlRel}`);
          }
        }
      }

      if (type === 'custom') {
        await cleanupCustomTestFiles(name, projectRoot, journal);
      }

      // Remove entry from furnace.json
      if (type === 'stock') {
        config.stock = config.stock.filter((s) => s !== name);
      } else if (type === 'override') {
        config.overrides = Object.fromEntries(
          Object.entries(config.overrides).filter(([key]) => key !== name)
        );
      } else {
        config.custom = Object.fromEntries(
          Object.entries(config.custom).filter(([key]) => key !== name)
        );
      }

      await snapshotFile(journal, furnacePaths.furnaceConfig);
      await writeFurnaceConfig(projectRoot, config);

      // Drop stale per-file checksums inside the same transactional block.
      // Snapshotting the state file into the rollback journal means the
      // entire remove operation is a single atomic unit.
      await snapshotFile(journal, furnacePaths.furnaceState);
      await updateFurnaceState(projectRoot, (state) =>
        dropChecksumsByPrefix(state, `${type}/${name}/`)
      );
    } catch (error: unknown) {
      try {
        await restoreRollbackJournalOrThrow(journal, `Failed to remove component "${name}"`);
      } catch (rollbackError) {
        await recordFurnaceRollbackFailure(
          projectRoot,
          'remove-rollback',
          toError(rollbackError).message
        );
        throw rollbackError;
      }
      throw error;
    }
  });

  info(`Removed "${name}" from furnace.json`);
  outro('Component removed');
}
