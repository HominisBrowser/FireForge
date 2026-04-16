// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import {
  isComponentSourceFile,
  resolveFtlDir,
  tagNameToClassName,
} from '../../core/furnace-constants.js';
import { recordFurnaceRollbackFailure, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  CUSTOM_ELEMENT_TAG_RULES,
} from '../../core/furnace-registration-validate.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
  snapshotDir,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getStoriesDir } from '../../core/furnace-stories.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
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

/** Escapes regex metacharacters so a user-supplied name is literal inside a RegExp. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies the component rename to a filename. Only replaces the leading
 * component name when it is followed by `.` (extension) or equals the
 * filename exactly; every other filename is returned unchanged so stray
 * assets, editor backups, or files whose name coincidentally contains the
 * old component name in the middle or at the end are not accidentally
 * renamed.
 */
function renameComponentFileName(fileName: string, oldName: string, newName: string): string {
  if (fileName === oldName) return newName;
  if (fileName.startsWith(oldName + '.')) {
    return newName + fileName.slice(oldName.length);
  }
  return fileName;
}

function updateConfigForCustomRename(
  config: FurnaceConfig,
  oldName: string,
  newName: string
): void {
  const oldConfig = config.custom[oldName];
  if (!oldConfig) return;

  config.custom[newName] = {
    ...oldConfig,
    targetPath: oldConfig.targetPath.replace(new RegExp(`(^|/)${oldName}$`), `$1${newName}`),
  };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- idiomatic key removal from config record
  delete config.custom[oldName];

  // Update composes references in other components
  for (const customConfig of Object.values(config.custom)) {
    if (customConfig.composes) {
      customConfig.composes = customConfig.composes.map((ref) => (ref === oldName ? newName : ref));
    }
  }
}

function updateConfigForOverrideRename(
  config: FurnaceConfig,
  oldName: string,
  newName: string
): void {
  const oldConfig = config.overrides[oldName];
  if (!oldConfig) return;

  config.overrides[newName] = { ...oldConfig };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- idiomatic key removal from config record
  delete config.overrides[oldName];
}

/**
 * Derives the test file name for a component, matching the convention used by
 * `furnace create --with-tests`.
 */
function deriveTestFileName(componentName: string, binaryName: string): string {
  const strippedName = componentName.startsWith('moz-') ? componentName.slice(4) : componentName;
  const withoutBinaryPrefix = strippedName.startsWith(binaryName + '-')
    ? strippedName.slice(binaryName.length + 1)
    : strippedName;
  const underscored = withoutBinaryPrefix.replace(/-/g, '_');
  return `browser_${binaryName}_${underscored}.js`;
}

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
  journal: ReturnType<typeof createRollbackJournal>
): Promise<void> {
  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch {
    return; // Cannot determine test paths without config.
  }

  const binaryName = forgeConfig.binaryName;
  const oldTestFileName = deriveTestFileName(oldName, binaryName);
  const newTestFileName = deriveTestFileName(newName, binaryName);
  const testDir = join(engineDir, 'browser/base/content/test', binaryName);

  if (!(await pathExists(testDir))) return;

  // Rename the test JS file
  const oldTestPath = join(testDir, oldTestFileName);
  const newTestPath = join(testDir, newTestFileName);
  if (await pathExists(oldTestPath)) {
    try {
      await snapshotFile(journal, oldTestPath);
      const content = await readText(oldTestPath);
      await writeText(newTestPath, content);
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
 * Performs the transactional rename mutation inside a furnace lock.
 */
async function performRenameMutations(args: {
  projectRoot: string;
  oldName: string;
  newName: string;
  oldDir: string;
  newDir: string;
  isCustom: boolean;
  componentType: string;
  config: FurnaceConfig;
  furnaceConfigPath: string;
  engineDir: string;
}): Promise<void> {
  const { projectRoot, oldName, newName, oldDir, newDir, isCustom, componentType, config } = args;
  const oldClassName = tagNameToClassName(oldName);
  const newClassName = tagNameToClassName(newName);

  await runFurnaceMutation(projectRoot, 'rename-rollback', async (ctx) => {
    const journal = createRollbackJournal();
    ctx.registerJournal(journal);

    try {
      await snapshotDir(journal, oldDir);
      await snapshotFile(journal, args.furnaceConfigPath);

      // 1. Create new directory with renamed files and updated content
      await ensureDir(newDir);
      const entries = await readdir(oldDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const oldFileName = entry.name;
        // Rename only when the filename starts with the component name — the
        // scaffolding convention for both create and override is `${name}.ext`.
        // A plain `replace(oldName, newName)` produced wrong results when the
        // old name occurred more than once (e.g. `foo-foo.mjs` renamed `foo` →
        // `bar` became `bar-foo.mjs` instead of `bar-bar.mjs`) and also when
        // the old name appeared inside a file that was not the component
        // scaffold itself (e.g. a sibling helper). Unrelated files (stray
        // assets, editor backups) are copied verbatim.
        const newFileName = renameComponentFileName(oldFileName, oldName, newName);
        const oldPath = join(oldDir, oldFileName);
        const newPath = join(newDir, newFileName);

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
        await updateEngineRegistrations(args.engineDir, oldName, newName, newDir, ftlDir, journal);
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
      }

      info(`Renamed ${componentType} component: ${oldName} → ${newName}`);
    } catch (error: unknown) {
      try {
        if (await pathExists(newDir)) {
          await removeDir(newDir);
        }
      } catch {
        // Best effort cleanup
      }
      try {
        await restoreRollbackJournalOrThrow(
          journal,
          `Failed to rename component "${oldName}" to "${newName}"`
        );
      } catch (rollbackError) {
        await recordFurnaceRollbackFailure(
          projectRoot,
          'rename-rollback',
          `rename "${oldName}" → "${newName}": ${toError(rollbackError).message}`
        );
        throw rollbackError;
      }
      throw error;
    }
  });
}

/**
 * Re-keys checksum entries in furnace-state.json from the old component name
 * to the new name so that `doctor` doesn't flag stale entries and the next
 * `apply` can correctly detect whether the renamed component has changed.
 */
async function rekeyStateChecksums(
  projectRoot: string,
  componentType: string,
  oldName: string,
  newName: string
): Promise<void> {
  const oldPrefix = `${componentType}/${oldName}/`;
  const newPrefix = `${componentType}/${newName}/`;

  await updateFurnaceState(projectRoot, (state) => {
    const result = { ...state };
    for (const field of ['appliedChecksums', 'engineChecksums'] as const) {
      const checksums = state[field];
      if (!checksums) continue;
      const updated: Record<string, string> = {};
      for (const [key, value] of Object.entries(checksums)) {
        if (key.startsWith(oldPrefix)) {
          updated[newPrefix + key.slice(oldPrefix.length)] = value;
        } else {
          updated[key] = value;
        }
      }
      result[field] = updated;
    }
    return result;
  });
}

async function updateEngineRegistrations(
  engineDir: string,
  oldName: string,
  newName: string,
  newDir: string,
  ftlDir: string,
  journal: ReturnType<typeof createRollbackJournal>
): Promise<void> {
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
    const ftlContent = await readText(oldFtlPath);
    await writeText(newFtlPath, ftlContent);
    await removeFile(oldFtlPath);
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

  const componentType = isCustom ? 'custom' : 'override';
  const baseDir = isCustom ? furnacePaths.customDir : furnacePaths.overridesDir;
  const oldDir = join(baseDir, oldName);
  const newDir = join(baseDir, newName);

  if (!(await pathExists(oldDir))) {
    throw new FurnaceError(
      `Component directory not found: components/${componentType}s/${oldName}`,
      oldName
    );
  }
  if (await pathExists(newDir)) {
    throw new FurnaceError(
      `Target directory already exists: components/${componentType}s/${newName}`,
      newName
    );
  }

  await performRenameMutations({
    projectRoot,
    oldName,
    newName,
    oldDir,
    newDir,
    isCustom,
    componentType,
    config,
    furnaceConfigPath: furnacePaths.furnaceConfig,
    engineDir: paths.engine,
  });

  note(
    `Component renamed: ${oldName} → ${newName}\n\n` +
      `Directory: components/${componentType}s/${newName}/\n\n` +
      'Next steps:\n' +
      '  1. Review the renamed files for any remaining references\n' +
      '  2. Run "fireforge furnace validate" to verify\n' +
      '  3. Run "fireforge furnace apply" to update the engine',
    newName
  );

  outro('Rename complete');
}
