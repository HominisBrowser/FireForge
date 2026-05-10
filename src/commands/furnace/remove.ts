// SPDX-License-Identifier: EUPL-1.2
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { confirm } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { removeCustomFtlJarMnEntry } from '../../core/furnace-apply-ftl.js';
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
import { resolveFtlDir, xpcshellTestParentDir } from '../../core/furnace-constants.js';
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
import { dropChecksumsByPrefix } from './remove-state.js';

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
): Promise<{ partialFailures: string[] }> {
  const partialFailures: string[] = [];

  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch (error: unknown) {
    const msg = `Could not load config for test cleanup — ${toError(error).message}. Remove test files manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
    return { partialFailures };
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

  if (!(await pathExists(testDir))) return { partialFailures };

  // Step 1: Delete the test file itself
  try {
    const testFilePath = join(testDir, testFileName);
    if (await pathExists(testFilePath)) {
      await snapshotFile(journal, testFilePath);
      await unlink(testFilePath);
      info(`Deleted test file: ${testFileName}`);
    }
  } catch (error: unknown) {
    const msg = `Could not delete test file ${testFileName} — ${toError(error).message}. Remove it manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
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
    const msg = `Could not update browser.toml — ${toError(error).message}. Remove the test entry manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
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
    const msg = `Could not clean up test directory — ${toError(error).message}. Remove it manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
  }

  return { partialFailures };
}

/**
 * Removes the MochiKit test scaffold a `furnace create --with-tests
 * --test-style mochikit` produced for the component (matches the rename
 * counterpart in `rename.ts`). The test file is `test_<name>.html` under
 * `engine/toolkit/content/tests/widgets/` and the registration is the
 * `["test_<name>.html"]` entry in the same directory's `chrome.toml`.
 *
 * 2026-04-25 eval Finding 13: the prior cleanup only handled the
 * browser-chrome mochitest layout under `browser/base/content/test/
 * <binary>/`, which left mochikit-style scaffolds and their toml entries
 * orphaned after `furnace remove`. The post-rename name passed in here
 * is the canonical one written to disk by deploy/rename, so the file
 * basenames match without needing to re-derive from the old name.
 *
 * Best-effort: each step warns on failure rather than throwing so the
 * rest of the remove transaction proceeds. The journal still snapshots
 * touched files so the outer rollback can restore them on a later
 * failure in the same operation.
 */
async function cleanupCustomMochikitTestFiles(
  name: string,
  projectRoot: string,
  journal: RollbackJournal
): Promise<{ partialFailures: string[] }> {
  const partialFailures: string[] = [];

  const paths = getProjectPaths(projectRoot);
  const widgetsTestDir = join(paths.engine, 'toolkit/content/tests/widgets');
  if (!(await pathExists(widgetsTestDir))) {
    return { partialFailures };
  }

  const testFileName = `test_${name}.html`;
  const testFilePath = join(widgetsTestDir, testFileName);
  try {
    if (await pathExists(testFilePath)) {
      await snapshotFile(journal, testFilePath);
      await unlink(testFilePath);
      info(`Deleted mochikit test file: toolkit/content/tests/widgets/${testFileName}`);
    }
  } catch (error: unknown) {
    const msg = `Could not delete mochikit test file ${testFileName} — ${toError(error).message}. Remove it manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
  }

  const chromeTomlPath = join(widgetsTestDir, 'chrome.toml');
  try {
    if (await pathExists(chromeTomlPath)) {
      const toml = await readText(chromeTomlPath);
      const headerLine = `["${testFileName}"]`;
      if (toml.includes(headerLine)) {
        await snapshotFile(journal, chromeTomlPath);
        await writeText(chromeTomlPath, removeTomlSection(toml, testFileName));
      }
    }
  } catch (error: unknown) {
    const msg = `Could not update widgets chrome.toml — ${toError(error).message}. Remove the test entry manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
  }

  return { partialFailures };
}

/**
 * Removes generated xpcshell test scaffolds associated with a custom
 * component. 2026-04-24 eval Finding 5: `furnace remove` handled
 * browser mochitests via `cleanupCustomTestFiles` but never touched the
 * xpcshell scaffold tree, so an operator who ran
 * `furnace create --with-tests --xpcshell` followed by `furnace remove`
 * was left with orphan `xpcshell.toml` + `test_<name>_packaged.js`
 * files still referencing the removed component. This cleanup pass
 * mirrors the mochitest one — snapshot before removal, warn-and-
 * continue semantics, explicit summary when partial failures occur.
 */
async function cleanupCustomXpcshellTestFiles(
  name: string,
  projectRoot: string,
  journal: RollbackJournal
): Promise<{ partialFailures: string[] }> {
  const partialFailures: string[] = [];

  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch (error: unknown) {
    const msg = `Could not load config for xpcshell test cleanup — ${toError(error).message}. Remove xpcshell test files manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
    return { partialFailures };
  }

  const paths = getProjectPaths(projectRoot);
  const xpcshellRoot = join(paths.engine, xpcshellTestParentDir(forgeConfig.binaryName));
  const componentXpcshellDir = join(xpcshellRoot, name);

  if (!(await pathExists(componentXpcshellDir))) return { partialFailures };

  try {
    await snapshotDir(journal, componentXpcshellDir);
    await removeDir(componentXpcshellDir);
    info(
      `Deleted xpcshell test scaffold directory: ${componentXpcshellDir.replace(paths.engine + '/', 'engine/')}`
    );
  } catch (error: unknown) {
    const msg = `Could not delete xpcshell test scaffold — ${toError(error).message}. Remove it manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
  }

  // If the xpcshell parent directory is now empty (no other components
  // had scaffolds), drop it too so `furnace validate` stays quiet about
  // the empty per-binary tree. Warn-and-continue on any failure.
  try {
    if (await pathExists(xpcshellRoot)) {
      const remaining = await readdir(xpcshellRoot);
      if (remaining.length === 0) {
        await snapshotDir(journal, xpcshellRoot);
        await removeDir(xpcshellRoot);
        info(
          `Deleted empty xpcshell parent directory: ${xpcshellRoot.replace(paths.engine + '/', 'engine/')}`
        );
      }
    }
  } catch (error: unknown) {
    const msg = `Could not clean up xpcshell parent directory — ${toError(error).message}. Remove it manually if needed.`;
    warn(msg);
    partialFailures.push(msg);
  }

  return { partialFailures };
}

async function loadFreshRemoveTarget(
  projectRoot: string,
  name: string,
  engineDir: string
): Promise<{
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>;
  ftlDir: string;
  state: FurnaceState;
  type: ComponentType;
}> {
  const config = await loadFurnaceConfig(projectRoot);
  const state = await loadFurnaceState(projectRoot);
  const type = findComponentType(config, name);
  if (!type) {
    throw new FurnaceError(
      `Component "${name}" not found in furnace.json. Run "fireforge furnace list" to see registered components.`,
      name
    );
  }
  await requireGitEngineForRemove(type, name, engineDir);
  return { config, ftlDir: resolveFtlDir(config.ftlBasePath), state, type };
}

async function cleanupAllCustomTestFiles(
  name: string,
  projectRoot: string,
  journal: RollbackJournal
): Promise<string[]> {
  const result = await cleanupCustomTestFiles(name, projectRoot, journal);
  const failures = [...result.partialFailures];
  failures.push(
    ...(await cleanupCustomXpcshellTestFiles(name, projectRoot, journal)).partialFailures
  );
  failures.push(
    ...(await cleanupCustomMochikitTestFiles(name, projectRoot, journal)).partialFailures
  );
  return failures;
}

/**
 * Confirms the remove operation interactively when TTY is available, or
 * enforces the `--yes` contract in non-interactive mode. Returns `false`
 * when the user cancelled and the caller should exit silently.
 */
async function confirmFurnaceRemove(
  name: string,
  type: ComponentType,
  options: FurnaceRemoveOptions,
  isInteractive: boolean
): Promise<boolean> {
  if (!isInteractive && !options.yes) {
    throw new FurnaceError(
      `Cannot remove "${name}" in non-interactive mode without --yes flag.`,
      name
    );
  }

  if (!options.yes && isInteractive) {
    const confirmed = await confirm({
      message: `Remove ${type} component "${name}"?`,
    });

    if (isCancel(confirmed) || !confirmed) {
      cancel('Remove cancelled');
      return false;
    }
  }

  return true;
}

/**
 * Enforces the engine-as-git precondition for both override and custom
 * removals. Runs BEFORE the lock is acquired or a journal is registered so
 * the failure path does not involve any rollback infrastructure.
 */
async function requireGitEngineForRemove(
  type: ComponentType,
  name: string,
  engineDir: string
): Promise<void> {
  if (type !== 'override' && type !== 'custom') return;
  if (!(await isGitRepository(engineDir))) {
    throw new FurnaceError(
      `Cannot remove ${type} component "${name}": engine is not a git repository. Run "fireforge download" to initialise it.`,
      name
    );
  }
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
  const furnacePaths = getFurnacePaths(projectRoot);

  // Find which section the component belongs to
  const type = findComponentType(config, name);

  if (!type) {
    throw new FurnaceError(
      `Component "${name}" not found in furnace.json. Run "fireforge furnace list" to see registered components.`,
      name
    );
  }

  if (!(await confirmFurnaceRemove(name, type, options, isInteractive))) {
    return;
  }

  // Begin transactional mutation: every file deleted or rewritten is first
  // snapshotted in a rollback journal so any failure mid-removal restores the
  // workspace and engine to their pre-command state. The mutation runs under
  // the furnace-wide lock and is registered with the global SIGINT/SIGTERM
  // rollback pathway.
  const paths = getProjectPaths(projectRoot);

  await requireGitEngineForRemove(type, name, paths.engine);

  await runFurnaceMutation(projectRoot, 'remove-rollback', async (ctx) => {
    const journal = createRollbackJournal();
    ctx.registerJournal(journal);

    try {
      const {
        config: freshConfig,
        ftlDir,
        state: freshState,
        type: freshType,
      } = await loadFreshRemoveTarget(projectRoot, name, paths.engine);

      if (freshType === 'override') {
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
      } else if (freshType === 'custom') {
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
          // Drop the locale jar.mn chrome registration that `applyCustomFtlFile`
          // wrote during deploy — otherwise the engine is left with a
          // `locale/.../${name}.ftl` entry pointing at a file we just
          // deleted. 2026-04-21 eval (Finding #1): `furnace remove` left
          // `browser/locales/jar.mn` referencing the missing FTL, which
          // would break the next package-manifest validation.
          await removeCustomFtlJarMnEntry(
            paths.engine,
            `${name}.ftl`,
            ftlDir,
            customConfig,
            journal
          );
        }
      }

      const testCleanupFailures =
        freshType === 'custom' ? await cleanupAllCustomTestFiles(name, projectRoot, journal) : [];

      // Remove entry from furnace.json
      if (freshType === 'stock') {
        freshConfig.stock = freshConfig.stock.filter((s) => s !== name);
      } else if (freshType === 'override') {
        freshConfig.overrides = Object.fromEntries(
          Object.entries(freshConfig.overrides).filter(([key]) => key !== name)
        );
      } else {
        freshConfig.custom = Object.fromEntries(
          Object.entries(freshConfig.custom).filter(([key]) => key !== name)
        );
      }

      await snapshotFile(journal, furnacePaths.furnaceConfig);
      await writeFurnaceConfig(projectRoot, freshConfig);

      // Drop stale per-file checksums inside the same transactional block.
      // Snapshotting the state file into the rollback journal means the
      // entire remove operation is a single atomic unit.
      await snapshotFile(journal, furnacePaths.furnaceState);
      await updateFurnaceState(projectRoot, (state) =>
        dropChecksumsByPrefix(state, `${freshType}/${name}/`)
      );

      // Test-cleanup failures are warn-and-continue by design (test files
      // are secondary artefacts), but the caller deserves a single summary
      // line pointing at the residue so they don't have to re-scan earlier
      // warn output to realise the removal was partial.
      if (testCleanupFailures.length > 0) {
        warn(
          `Component "${name}" removed with ${testCleanupFailures.length} test-cleanup warning(s) above. ` +
            `The component is deregistered, but test files may linger in the engine — review and delete manually if needed.`
        );
      }
    } catch (error: unknown) {
      try {
        await restoreRollbackJournalOrThrow(journal, `Failed to remove component "${name}"`);
      } catch (rollbackError) {
        await recordFurnaceRollbackFailure(
          projectRoot,
          'remove-rollback',
          `component "${name}": ${toError(rollbackError).message}`
        );
        throw rollbackError;
      }
      throw error;
    }
  });

  info(`Removed "${name}" from furnace.json`);
  outro('Component removed');
}
