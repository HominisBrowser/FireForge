// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import type { FurnacePaths } from '../../core/furnace-config.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import {
  isComponentSourceFile,
  resolveFtlChromeSubPath,
  resolveFtlDir,
  resolveFtlLocaleJarMnPath,
  tagNameToClassName,
} from '../../core/furnace-constants.js';
import { completeJournalRollback, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  addLocaleFtlJarMnEntry,
  removeCustomElementRegistration,
  removeJarMnEntries,
  removeLocaleFtlJarMnEntry,
} from '../../core/furnace-registration.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  CUSTOM_ELEMENT_TAG_RULES,
} from '../../core/furnace-registration-validate.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  type RollbackJournal,
  snapshotDir,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getStoriesDir } from '../../core/furnace-stories.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import { toError } from '../../utils/errors.js';
import {
  copyFile,
  ensureDir,
  pathExists,
  readText,
  removeDir,
  removeFile,
  writeText,
} from '../../utils/fs.js';
import { info, intro, note, outro, warn } from '../../utils/logger.js';
import { escapeRegex } from '../../utils/regex.js';
import { updateBrowserChromeTestContent } from './rename-browser-test.js';
import {
  rekeyStateChecksums,
  renameComponentFileName,
  updateConfigForCustomRename,
  updateConfigForOverrideRename,
} from './rename-helpers.js';
import { renameXpcshellTestFiles } from './rename-xpcshell.js';
import { browserTestFileName } from './test-file-name.js';

/**
 * Renames test files created by `furnace create --with-tests` in the engine
 * test directory. Best-effort: failures are logged as warnings but do not
 * block the rename.
 */
async function renameTestFiles(
  engineDir: string,
  projectRoot: string,
  oldName: string,
  newName: string,
  journal: RollbackJournal
): Promise<void> {
  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch {
    return; // Cannot determine test paths without config.
  }

  const binaryName = forgeConfig.binaryName;
  const oldTestFileName = browserTestFileName(oldName, binaryName);
  const newTestFileName = browserTestFileName(newName, binaryName);
  const testDir = join(engineDir, 'browser/base/content/test', binaryName);

  if (!(await pathExists(testDir))) return;

  // Rename the test JS file
  const oldTestPath = join(testDir, oldTestFileName);
  const newTestPath = join(testDir, newTestFileName);
  if (await pathExists(oldTestPath)) {
    try {
      await snapshotFile(journal, oldTestPath);
      await snapshotFile(journal, newTestPath);
      const content = await readText(oldTestPath);
      await writeText(
        newTestPath,
        updateBrowserChromeTestContent(content, oldName, newName, binaryName)
      );
      await removeFile(oldTestPath);
      info(`Renamed test file: ${oldTestFileName} → ${newTestFileName}`);
    } catch (error: unknown) {
      warn(`Could not rename test file — ${toError(error).message}. Rename it manually if needed.`);
    }
  }

  // Update browser.toml entry
  const tomlPath = join(testDir, 'browser.toml');
  if (await pathExists(tomlPath)) {
    try {
      const toml = await readText(tomlPath);
      if (toml.includes(`["${oldTestFileName}"]`)) {
        await snapshotFile(journal, tomlPath);
        const updated = toml.replace(`["${oldTestFileName}"]`, `["${newTestFileName}"]`);
        await writeText(tomlPath, updated);
        info(`Updated browser.toml: ${oldTestFileName} → ${newTestFileName}`);
      }
    } catch (error: unknown) {
      warn(
        `Could not update browser.toml — ${toError(error).message}. Update it manually if needed.`
      );
    }
  }
}

/**
 * Removes the deployed custom-widget directory at the old target path so a
 * subsequent `furnace apply` is the single writer of the new name's
 * deployment. Best-effort: logs a warning but never blocks the rename.
 *
 * Without it, a rename registers and deploys the new name correctly but
 * leaves `engine/toolkit/content/widgets/<old>/` in place: subsequent
 * `furnace sync` runs cannot clear the stale widget, and packaging pulls in
 * both copies. The snapshot is taken before the remove so the rollback
 * journal restores the old directory if any later step in
 * `performRenameMutations` fails.
 */
async function removeStaleDeployedComponentDir(
  engineDir: string,
  oldTargetPath: string,
  journal: RollbackJournal
): Promise<void> {
  const oldDeployed = join(engineDir, oldTargetPath);
  if (!(await pathExists(oldDeployed))) return;

  try {
    await snapshotDir(journal, oldDeployed);
    await removeDir(oldDeployed);
    info(`Removed stale deployed widget directory: ${oldTargetPath}`);
  } catch (error: unknown) {
    warn(
      `Could not remove stale deployed widget directory at ${oldTargetPath}: ${toError(error).message}. Remove it manually if needed.`
    );
  }
}

/**
 * Renames the mochikit test scaffold produced by `furnace create
 * --with-tests` when the default test style is used. The scaffold lives at
 * `engine/toolkit/content/tests/widgets/test_<name>.html`, and the
 * accompanying `chrome.toml` entry names the same file. Leaving both
 * unhandled produces a `test_<old>.html` that still imports
 * `chrome://global/content/elements/<old>.mjs` and references
 * `customElements.whenDefined("<old>")`, running against a component that
 * no longer exists under that name, and either failing or (if the old
 * component is still deployed) passing for the wrong reason.
 *
 * Best-effort: individual failures log a warning. The same journal used for
 * the rest of the rename snapshots every touched file so a later failure
 * rolls the pair back together.
 */
async function renameMochikitTestFiles(
  engineDir: string,
  oldName: string,
  newName: string,
  journal: RollbackJournal
): Promise<void> {
  const testDir = join(engineDir, 'toolkit/content/tests/widgets');
  if (!(await pathExists(testDir))) return;

  const oldTestFileName = `test_${oldName}.html`;
  const newTestFileName = `test_${newName}.html`;
  const oldTestPath = join(testDir, oldTestFileName);
  const newTestPath = join(testDir, newTestFileName);

  if (await pathExists(oldTestPath)) {
    try {
      await snapshotFile(journal, oldTestPath);
      const content = await readText(oldTestPath);
      const updatedContent = content
        .replace(
          new RegExp(`chrome://global/content/elements/${escapeRegex(oldName)}\\.mjs`, 'g'),
          `chrome://global/content/elements/${newName}.mjs`
        )
        .replace(
          new RegExp(`customElements\\.whenDefined\\("${escapeRegex(oldName)}"\\)`, 'g'),
          `customElements.whenDefined("${newName}")`
        )
        .replace(new RegExp(`Test the ${escapeRegex(oldName)} `, 'g'), `Test the ${newName} `)
        .replace(
          new RegExp(
            `add_task\\(async function test_${escapeRegex(oldName.replace(/-/g, '_'))}_defined\\(`,
            'g'
          ),
          `add_task(async function test_${newName.replace(/-/g, '_')}_defined(`
        )
        .replace(
          new RegExp(`"${escapeRegex(oldName)} custom element`, 'g'),
          `"${newName} custom element`
        );
      await snapshotFile(journal, newTestPath);
      await writeText(newTestPath, updatedContent);
      await removeFile(oldTestPath);
      info(`Renamed mochikit test: ${oldTestFileName} → ${newTestFileName}`);
    } catch (error: unknown) {
      warn(
        `Could not rename mochikit test file — ${toError(error).message}. Rename it manually if needed.`
      );
    }
  }

  // Update `chrome.toml` entry if present. The file may live in the
  // same widgets/tests directory as the test file itself. Upstream
  // convention places exactly one `chrome.toml` there for all widget
  // scaffolds.
  const chromeTomlPath = join(testDir, 'chrome.toml');
  if (await pathExists(chromeTomlPath)) {
    try {
      const toml = await readText(chromeTomlPath);
      if (toml.includes(`["${oldTestFileName}"]`)) {
        await snapshotFile(journal, chromeTomlPath);
        const updated = toml.replace(`["${oldTestFileName}"]`, `["${newTestFileName}"]`);
        await writeText(chromeTomlPath, updated);
        info(`Updated chrome.toml: ${oldTestFileName} → ${newTestFileName}`);
      }
    } catch (error: unknown) {
      warn(
        `Could not update widgets chrome.toml — ${toError(error).message}. Update it manually if needed.`
      );
    }
  }
}

/**
 * Performs the transactional rename mutation inside a furnace lock.
 */
async function performRenameMutations(args: {
  projectRoot: string;
  oldName: string;
  newName: string;
  newDir: string;
  furnaceConfigPath: string;
  furnacePaths: FurnacePaths;
  engineDir: string;
}): Promise<void> {
  const { projectRoot, oldName, newName } = args;
  const oldClassName = tagNameToClassName(oldName);
  const newClassName = tagNameToClassName(newName);

  await runFurnaceMutation(projectRoot, 'rename-rollback', async (ctx) => {
    const journal = createRollbackJournal();
    ctx.registerJournal(journal);

    let newDir = args.newDir;
    try {
      const config = await loadFurnaceConfig(projectRoot);
      const isCustom = oldName in config.custom;
      const isOverride = oldName in config.overrides;
      if (!isCustom && !isOverride) {
        throw new FurnaceError(
          `Component "${oldName}" not found in furnace.json. Only custom and override components can be renamed.`,
          oldName
        );
      }
      if (
        newName in config.custom ||
        newName in config.overrides ||
        config.stock.includes(newName)
      ) {
        throw new FurnaceError(
          `A component named "${newName}" already exists in furnace.json.`,
          newName
        );
      }

      const componentType = isCustom ? 'custom' : 'override';
      const componentDirLabel = isCustom ? 'custom' : 'overrides';
      const baseDir = isCustom ? args.furnacePaths.customDir : args.furnacePaths.overridesDir;
      const oldDir = join(baseDir, oldName);
      newDir = join(baseDir, newName);
      const oldCustomTargetPath = isCustom ? config.custom[oldName]?.targetPath : undefined;

      if (!(await pathExists(oldDir))) {
        throw new FurnaceError(
          `Component directory not found: components/${componentDirLabel}/${oldName}`,
          oldName
        );
      }
      if (await pathExists(newDir)) {
        throw new FurnaceError(
          `Target directory already exists: components/${componentDirLabel}/${newName}`,
          newName
        );
      }

      await snapshotDir(journal, oldDir);
      await snapshotFile(journal, args.furnaceConfigPath);
      // Journal the state file before step 4 re-keys its checksums, plus
      // the new dir and every new-name destination below (a snapshot of a
      // missing path records {existed: false}, so rollback deletes it).
      // Without these, a failed or SIGINT'd rename stranded the new-name
      // scaffold and kept re-keyed state for a nonexistent component.
      await snapshotFile(journal, getFurnacePaths(projectRoot).furnaceState);

      // 1. Create new directory with renamed files and updated content
      recordCreatedDir(journal, newDir);
      await ensureDir(newDir);
      const entries = await readdir(oldDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const oldFileName = entry.name;
        // Rename only when the filename starts with the component name. The
        // scaffolding convention for both create and override is
        // `${name}.ext`. A plain `replace(oldName, newName)` produces wrong
        // results when the old name occurs more than once (`foo-foo.mjs`
        // renamed `foo` → `bar` becomes `bar-foo.mjs` instead of
        // `bar-bar.mjs`) and when the old name appears inside a file that is
        // not the component scaffold itself. Unrelated files (stray assets,
        // editor backups) are copied verbatim.
        const newFileName = renameComponentFileName(oldFileName, oldName, newName);
        const oldPath = join(oldDir, oldFileName);
        const newPath = join(newDir, newFileName);

        await snapshotFile(journal, newPath);
        if (isComponentSourceFile(oldFileName)) {
          let content = await readText(oldPath);
          // Use word-boundary-aware patterns so substrings in other
          // identifiers (e.g. "moz-panel" inside "moz-panel-group") are
          // not replaced.
          const tagPattern = new RegExp(`(?<![\\w-])${escapeRegex(oldName)}(?![\\w-])`, 'g');
          const classPattern = new RegExp(`\\b${escapeRegex(oldClassName)}\\b`, 'g');
          content = content.replace(tagPattern, newName);
          content = content.replace(classPattern, newClassName);
          await writeText(newPath, content);
        } else {
          await copyFile(oldPath, newPath);
        }
      }

      // 2. Update furnace.json
      if (isCustom) {
        updateConfigForCustomRename(config, oldName, newName);
      } else {
        updateConfigForOverrideRename(config, oldName, newName);
      }
      await writeFurnaceConfig(projectRoot, config);

      // 3. Update engine registrations (custom components only)
      if (isCustom && config.custom[newName]?.register && (await pathExists(args.engineDir))) {
        const ftlDir = resolveFtlDir(config.ftlBasePath);
        const isLocalized = config.custom[newName].localized;
        await updateEngineRegistrations({
          engineDir: args.engineDir,
          oldName,
          newName,
          newDir,
          ftlDir,
          isLocalized,
          journal,
        });
      }

      // 4. Re-key furnace-state.json checksums from old name to new name
      await rekeyStateChecksums(args.projectRoot, componentType, oldName, newName);

      // 5. Remove old directory
      await removeDir(oldDir);

      // 6. Clean up stale Storybook story file for the old name (if it exists
      // from a previous `furnace preview` session). The next preview will
      // regenerate the story under the new name via `syncStories`.
      const oldStoryPath = join(getStoriesDir(args.engineDir), 'furnace', `${oldName}.stories.mjs`);
      if (await pathExists(oldStoryPath)) {
        await snapshotFile(journal, oldStoryPath);
        await removeFile(oldStoryPath);
        info(`Deleted stale story file: ${oldName}.stories.mjs`);
      }

      // 7. Rename test files created by `furnace create --with-tests` (custom only).
      if (isCustom && (await pathExists(args.engineDir))) {
        await renameTestFiles(args.engineDir, projectRoot, oldName, newName, journal);
        // The mochikit scaffold and widgets/chrome.toml live in a different
        // tree than browser.toml-registered browser-chrome tests, so
        // renameTestFiles does not reach them, leaving
        // `engine/toolkit/content/tests/widgets/test_<old>.html` and its
        // `chrome.toml` entry pointing at the old name, which either fails
        // the test run outright or passes for the wrong component.
        await renameMochikitTestFiles(args.engineDir, oldName, newName, journal);
        // xpcshell scaffolds live in yet another tree
        // (`browser/base/content/test/<binary>-xpcshell/<name>/`). Without
        // this call, renaming a component scaffolded with
        // `--with-tests --xpcshell` leaves a directory whose name still
        // references the pre-rename component, plus a test file whose
        // underscored name references the old tag.
        await renameXpcshellTestFiles(args.engineDir, projectRoot, oldName, newName, journal);
        // Clear the stale deployed component directory so the next
        // `furnace apply` is the single writer of the new name's deployment.
        // Without it the old widget stays at
        // `engine/toolkit/content/widgets/<old>/` alongside the
        // newly-deployed `<new>/`, with no signal to `status` / `verify`.
        if (oldCustomTargetPath) {
          await removeStaleDeployedComponentDir(args.engineDir, oldCustomTargetPath, journal);
        }
      }

      info(`Renamed ${componentType} component: ${oldName} → ${newName}`);
    } catch (error: unknown) {
      // Extra best-effort step this site owns: the half-created new
      // directory is not in the journal, so drop it before the shared
      // restore puts the old one back.
      try {
        if (await pathExists(newDir)) {
          await removeDir(newDir);
        }
      } catch {
        // Best effort cleanup
      }
      return await completeJournalRollback(ctx, journal, error, {
        projectRoot,
        operation: 'rename-rollback',
        failureMessage: `Failed to rename component "${oldName}" to "${newName}"`,
        subject: `rename "${oldName}" → "${newName}"`,
      });
    }
  });
}

interface UpdateEngineRegistrationsOptions {
  /** Absolute path to the engine checkout. */
  engineDir: string;
  /** Tag name being renamed away from. */
  oldName: string;
  /** Tag name being renamed to. */
  newName: string;
  /** Workspace directory holding the renamed component's files. */
  newDir: string;
  /** Engine-relative directory localized components deploy their `.ftl` into. */
  ftlDir: string;
  /** Whether the component ships a localized `.ftl` file. */
  isLocalized: boolean;
  /** Rollback journal every write is recorded in. */
  journal: RollbackJournal;
}

/**
 * Re-points the engine-side registrations (customElements.js, jar.mn, and
 * the localized `.ftl` entries) from the old tag name to the new one.
 *
 * @param options - See {@link UpdateEngineRegistrationsOptions}
 */
async function updateEngineRegistrations(options: UpdateEngineRegistrationsOptions): Promise<void> {
  const { engineDir, oldName, newName, newDir, ftlDir, isLocalized, journal } = options;
  const customElementsPath = join(engineDir, 'toolkit/content/customElements.js');
  const jarMnPath = join(engineDir, 'toolkit/content/jar.mn');

  if (await pathExists(customElementsPath)) {
    await snapshotFile(journal, customElementsPath);
    await removeCustomElementRegistration(engineDir, oldName);
    await addCustomElementRegistration(
      engineDir,
      newName,
      `chrome://global/content/elements/${newName}.mjs`
    );
  }

  if (await pathExists(jarMnPath)) {
    await snapshotFile(journal, jarMnPath);
    await removeJarMnEntries(engineDir, oldName);
    const files = (await readdir(newDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.css')))
      .map((e) => e.name);
    if (files.length > 0) {
      await addJarMnEntries(engineDir, newName, files);
    }
  }

  // Rename FTL localization files in the engine locale directory
  const ftlDirPath = join(engineDir, ftlDir);
  const oldFtlPath = join(ftlDirPath, `${oldName}.ftl`);
  const newFtlPath = join(ftlDirPath, `${newName}.ftl`);
  if (await pathExists(oldFtlPath)) {
    await snapshotFile(journal, oldFtlPath);
    await snapshotFile(journal, newFtlPath);
    const ftlContent = await readText(oldFtlPath);
    await writeText(newFtlPath, ftlContent);
    await removeFile(oldFtlPath);
  }

  // Re-wire the locale jar.mn chrome registration when the component is
  // localized. `updateEngineRegistrations` renames the .ftl file on disk but
  // leaves the locale jar.mn pointing at `locale/.../${oldName}.ftl`, so
  // `furnace validate` passes while the engine still carries a stale
  // registration for the now-missing file.
  if (isLocalized) {
    const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
    const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
    if (chromeSubPath !== undefined && localeJarRel !== undefined) {
      const localeJarAbs = join(engineDir, localeJarRel);
      if (await pathExists(localeJarAbs)) {
        await snapshotFile(journal, localeJarAbs);
        await removeLocaleFtlJarMnEntry(engineDir, localeJarRel, oldName, chromeSubPath);
        await addLocaleFtlJarMnEntry(engineDir, localeJarRel, newName, chromeSubPath);
      }
    }
  }
}

/**
 * Renames a custom or override component atomically: updates directory name,
 * file names, file contents, furnace.json, and engine registrations.
 */
export async function furnaceRenameCommand(
  projectRoot: string,
  oldName: string,
  newName: string
): Promise<void> {
  intro('Furnace Rename');

  if (!CUSTOM_ELEMENT_TAG_PATTERN.test(oldName)) {
    throw new InvalidArgumentError(
      `Invalid source name "${oldName}": ${CUSTOM_ELEMENT_TAG_RULES}`,
      'old-name'
    );
  }
  if (!CUSTOM_ELEMENT_TAG_PATTERN.test(newName)) {
    throw new InvalidArgumentError(
      `Invalid target name "${newName}": ${CUSTOM_ELEMENT_TAG_RULES}`,
      'new-name'
    );
  }
  if (oldName === newName) {
    throw new InvalidArgumentError('Source and target names are identical.', 'new-name');
  }

  const config = await loadFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const paths = getProjectPaths(projectRoot);

  const isCustom = oldName in config.custom;
  const isOverride = oldName in config.overrides;
  if (!isCustom && !isOverride) {
    throw new FurnaceError(
      `Component "${oldName}" not found in furnace.json. Only custom and override components can be renamed.`,
      oldName
    );
  }
  if (newName in config.custom || newName in config.overrides || config.stock.includes(newName)) {
    throw new FurnaceError(
      `A component named "${newName}" already exists in furnace.json.`,
      newName
    );
  }

  // The furnace-state key is singular (`custom` / `override`, derived
  // inside performRenameMutations). The on-disk directory label differs.
  // Custom components live under `components/custom/` (singular) while
  // overrides live under `components/overrides/` (plural). Appending an
  // `s` to the state key produces the wrong label `components/customs/`
  // for custom components and is correct for overrides only by
  // coincidence. `componentDirLabel` centralises the pick so every
  // operator-facing string names the directory that actually exists on
  // disk.
  const componentDirLabel = isCustom ? 'custom' : 'overrides';
  const baseDir = isCustom ? furnacePaths.customDir : furnacePaths.overridesDir;
  const oldDir = join(baseDir, oldName);
  const newDir = join(baseDir, newName);

  if (!(await pathExists(oldDir))) {
    throw new FurnaceError(
      `Component directory not found: components/${componentDirLabel}/${oldName}`,
      oldName
    );
  }
  if (await pathExists(newDir)) {
    throw new FurnaceError(
      `Target directory already exists: components/${componentDirLabel}/${newName}`,
      newName
    );
  }

  await performRenameMutations({
    projectRoot,
    oldName,
    newName,
    newDir,
    furnaceConfigPath: furnacePaths.furnaceConfig,
    furnacePaths,
    engineDir: paths.engine,
  });

  note(
    `Component renamed: ${oldName} → ${newName}\n\n` +
      `Directory: components/${componentDirLabel}/${newName}/\n\n` +
      'Next steps:\n' +
      '  1. Review the renamed files for any remaining references\n' +
      '  2. Run "fireforge furnace validate" to verify\n' +
      '  3. Run "fireforge furnace apply" to update the engine',
    newName
  );

  outro('Rename complete');
}
