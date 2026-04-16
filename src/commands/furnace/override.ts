// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { select, text } from '@clack/prompts';

import { getProjectPaths, loadConfig, loadState } from '../../core/config.js';
import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { resolveFtlDir } from '../../core/furnace-constants.js';
import { recordFurnaceRollbackFailure, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  CUSTOM_ELEMENT_TAG_RULES,
} from '../../core/furnace-registration-validate.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  restoreRollbackJournalOrThrow,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getComponentDetails, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceOverrideOptions } from '../../types/commands/index.js';
import type { OverrideType } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { copyFile, ensureDir, pathExists, writeJson } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, note, outro, warn } from '../../utils/logger.js';

async function loadAuthoringFurnaceConfig(
  projectRoot: string
): Promise<ReturnType<typeof createDefaultFurnaceConfig>> {
  if (await furnaceConfigExists(projectRoot)) {
    return loadFurnaceConfig(projectRoot);
  }

  return createDefaultFurnaceConfig();
}

/**
 * Copies the source files needed for a new override into the workspace.
 * @param srcDir - Original component directory in the engine checkout
 * @param destDir - Destination override directory in the workspace
 * @param overrideType - Requested override mode
 * @returns Filenames copied into the override directory
 */
async function copyOverrideFiles(
  engineDir: string,
  srcDir: string,
  destDir: string,
  componentName: string,
  hasFTL: boolean,
  overrideType: OverrideType,
  ftlDir: string,
  journal: RollbackJournal
): Promise<string[]> {
  await ensureDir(destDir);

  const entries = await readdir(srcDir, { withFileTypes: true });
  const copiedFiles: string[] = [];

  // Snapshot-then-copy helper: ensures the destination's parent dir exists
  // before snapshot + copy, and surfaces the failing filename on error so
  // partial-state rollback has the context needed to report cleanly.
  const snapshotAndCopy = async (
    from: string,
    dest: string,
    displayName: string
  ): Promise<void> => {
    await ensureDir(dirname(dest));
    try {
      await snapshotFile(journal, dest);
    } catch (error: unknown) {
      throw new FurnaceError(
        `Failed to snapshot "${displayName}" before override: ${toError(error).message}`,
        componentName
      );
    }
    try {
      await copyFile(from, dest);
    } catch (error: unknown) {
      throw new FurnaceError(
        `Failed to copy "${displayName}" into the override: ${toError(error).message}`,
        componentName
      );
    }
  };

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    if (overrideType === 'css-only') {
      // Only copy .css files
      if (entry.name.endsWith('.css')) {
        const dest = join(destDir, entry.name);
        await snapshotAndCopy(join(srcDir, entry.name), dest, entry.name);
        copiedFiles.push(entry.name);
      }
    } else {
      // Full override: copy .mjs and .css files
      if (entry.name.endsWith('.mjs') || entry.name.endsWith('.css')) {
        const dest = join(destDir, entry.name);
        await snapshotAndCopy(join(srcDir, entry.name), dest, entry.name);
        copiedFiles.push(entry.name);
      }
    }
  }

  if (overrideType === 'full' && hasFTL) {
    const ftlName = `${componentName}.ftl`;
    const ftlSrc = join(engineDir, ftlDir, ftlName);
    const dest = join(destDir, ftlName);
    await snapshotAndCopy(ftlSrc, dest, ftlName);
    copiedFiles.push(ftlName);
  }

  return copiedFiles;
}

/**
 * Writes override metadata to disk and updates furnace.json with the new override entry.
 * @param projectRoot - Root directory of the project
 * @param destDir - Override component directory
 * @param componentName - Component tag name
 * @param overrideType - Override mode that was created
 * @param description - Human-readable override description
 * @param details - Source component metadata from the engine scan
 * @param firefoxVersion - Firefox version recorded in the workspace config
 * @param config - Mutable Furnace config object to update
 */
async function saveOverrideConfig(
  projectRoot: string,
  destDir: string,
  componentName: string,
  overrideType: OverrideType,
  description: string,
  details: { sourcePath: string },
  firefoxVersion: string,
  config: Awaited<ReturnType<typeof loadAuthoringFurnaceConfig>>,
  journal: RollbackJournal,
  baseCommit?: string
): Promise<void> {
  const overrideJson = {
    type: overrideType,
    description,
    basePath: details.sourcePath,
    baseVersion: firefoxVersion,
    ...(baseCommit ? { baseCommit } : {}),
  };

  const overrideJsonPath = join(destDir, 'override.json');
  await snapshotFile(journal, overrideJsonPath);
  await writeJson(overrideJsonPath, overrideJson);

  config.overrides[componentName] = {
    type: overrideType,
    description,
    basePath: details.sourcePath,
    baseVersion: firefoxVersion,
    ...(baseCommit ? { baseCommit } : {}),
  };

  await writeFurnaceConfig(projectRoot, config);
}

/**
 * Performs the transactional mutation phase of furnace override under the
 * shared lifecycle wrapper. Extracted from `furnaceOverrideCommand` so the
 * main function stays under the `max-lines-per-function` threshold and so
 * the rollback contract is colocated with the writes it guards.
 */
async function performOverrideMutations(args: {
  projectRoot: string;
  componentName: string;
  overrideType: OverrideType;
  description: string;
  engineDir: string;
  srcDir: string;
  destDir: string;
  details: { sourcePath: string; hasFTL: boolean };
  config: Awaited<ReturnType<typeof loadAuthoringFurnaceConfig>>;
  furnacePaths: { furnaceConfig: string };
  ftlDir: string;
  firefoxVersion: string;
  baseCommit?: string;
}): Promise<string[]> {
  return runFurnaceMutation(
    args.projectRoot,
    'override-rollback',
    async (ctx): Promise<string[]> => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      recordCreatedDir(journal, args.destDir);

      try {
        const filesCopied = await copyOverrideFiles(
          args.engineDir,
          args.srcDir,
          args.destDir,
          args.componentName,
          args.details.hasFTL,
          args.overrideType,
          args.ftlDir,
          journal
        );

        await snapshotFile(journal, args.furnacePaths.furnaceConfig);
        await saveOverrideConfig(
          args.projectRoot,
          args.destDir,
          args.componentName,
          args.overrideType,
          args.description,
          args.details,
          args.firefoxVersion,
          args.config,
          journal,
          args.baseCommit
        );

        return filesCopied;
      } catch (error: unknown) {
        try {
          await restoreRollbackJournalOrThrow(
            journal,
            `Failed to override component "${args.componentName}"`
          );
        } catch (rollbackError) {
          await recordFurnaceRollbackFailure(
            args.projectRoot,
            'override-rollback',
            `component "${args.componentName}": ${toError(rollbackError).message}`
          );
          throw rollbackError;
        }
        throw error;
      }
    }
  );
}

/**
 * Throws if `componentName` is already classified anywhere in the furnace
 * config. Without this guard, `writeFurnaceConfig` would happily produce a
 * file where the same tag appears under multiple categories (stock +
 * override, custom + override) and later commands would no longer be able
 * to reason about that component cleanly.
 */
function assertNoComponentCollision(
  config: Awaited<ReturnType<typeof loadAuthoringFurnaceConfig>>,
  componentName: string
): void {
  if (componentName in config.overrides) {
    throw new FurnaceError(
      `An override for "${componentName}" already exists in furnace.json`,
      componentName
    );
  }
  if (config.stock.includes(componentName)) {
    throw new FurnaceError(
      `"${componentName}" is already registered as a stock component. Remove it from config.stock before creating an override.`,
      componentName
    );
  }
  if (componentName in config.custom) {
    throw new FurnaceError(
      `"${componentName}" is already registered as a custom component. Custom components cannot also be overrides.`,
      componentName
    );
  }
}

/**
 * Runs the furnace override command to fork an existing engine component.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component tag name (prompted if not provided)
 * @param options - CLI options for non-interactive mode
 */
export async function furnaceOverrideCommand(
  projectRoot: string,
  name?: string,
  options: FurnaceOverrideOptions = {}
): Promise<void> {
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  intro('Furnace Override');

  // --- Validate config-independent inputs BEFORE auto-creating furnace.json
  // so a failed authoring command never strands a fresh config in the
  // project root. CLI-supplied name is checked here; the engine directory
  // and component-resolution checks below also have no config dependency.
  const paths = getProjectPaths(projectRoot);

  if (name !== undefined && !CUSTOM_ELEMENT_TAG_PATTERN.test(name)) {
    throw new InvalidArgumentError(
      `Invalid component name "${name}": ${CUSTOM_ELEMENT_TAG_RULES}`,
      'name'
    );
  }

  if (name === undefined && !isInteractive) {
    throw new InvalidArgumentError(
      'Component name is required in non-interactive mode.\n' +
        'Usage: fireforge furnace override <name> -t <type> -d "description"',
      'name'
    );
  }

  // Verify engine/ exists (config-independent precondition)
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  // Load the current config without auto-creating a new furnace.json. A user
  // cancelling out of the interactive prompts should not leave a fresh config
  // behind in an otherwise untouched project.
  const config = await loadAuthoringFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  // --- Resolve component name ---
  let componentName = name;

  if (!componentName) {
    // Interactive prompt path; non-interactive missing-name was rejected above.
    const allComponents = await scanWidgetsDirectory(paths.engine, ftlDir);
    const available = allComponents.filter((c) => !(c.tagName in config.overrides));

    if (available.length === 0) {
      throw new FurnaceError('No components available to override.');
    }

    const selected = await select({
      message: 'Select a component to override:',
      options: available.map((c) => ({
        value: c.tagName,
        label: c.tagName,
        hint: [c.hasCSS && 'CSS', c.hasFTL && 'FTL', c.isRegistered && 'registered']
          .filter(Boolean)
          .join(', '),
      })),
    });

    if (isCancel(selected)) {
      cancel('Override cancelled');
      return;
    }

    componentName = selected as string;
  }

  assertNoComponentCollision(config, componentName);

  // Validate the component exists in engine
  const details = await getComponentDetails(paths.engine, componentName, ftlDir);
  if (!details) {
    throw new FurnaceError(
      `Component "${componentName}" not found in the engine source tree.`,
      componentName
    );
  }

  // --- Resolve override type ---
  let overrideType: OverrideType | undefined = options.type;

  if (!overrideType && isInteractive) {
    const typeResult = await select({
      message: 'Override type:',
      options: [
        {
          value: 'css-only' as const,
          label: 'CSS only — restyle the component',
        },
        {
          value: 'full' as const,
          label: 'Full override — modify styling and behavior',
        },
      ],
    });

    if (isCancel(typeResult)) {
      cancel('Override cancelled');
      return;
    }

    overrideType = typeResult as OverrideType;
  } else if (!overrideType) {
    throw new InvalidArgumentError(
      'Override type is required in non-interactive mode. Use -t css-only or -t full.',
      'type'
    );
  }

  if (overrideType === 'css-only' && !details.hasCSS) {
    throw new FurnaceError(
      `Component "${componentName}" does not have any CSS files to override with --type css-only.`,
      componentName
    );
  }

  // --- Resolve description ---
  let description = options.description ?? '';
  if (!description && isInteractive) {
    const descResult = await text({
      message: 'Description (optional):',
      placeholder: 'What are you changing about this component?',
    });

    if (!isCancel(descResult)) {
      description = String(descResult);
    }
  }

  // --- Copy original files ---
  const srcDir = join(paths.engine, details.sourcePath);
  const destDir = join(furnacePaths.overridesDir, componentName);

  if (await pathExists(destDir)) {
    throw new FurnaceError(
      `Directory already exists: components/overrides/${componentName}`,
      componentName
    );
  }

  const forgeConfig = await loadConfig(projectRoot);
  const state = await loadState(projectRoot);

  // All validation is done. The mutation phase runs in a helper that owns
  // the rollback journal, the furnace-wide lock, and SIGINT/SIGTERM-driven
  // teardown via the lifecycle wrapper.
  const copiedFiles = await performOverrideMutations({
    projectRoot,
    componentName,
    overrideType,
    description,
    srcDir,
    destDir,
    engineDir: paths.engine,
    details,
    config,
    furnacePaths,
    ftlDir,
    firefoxVersion: forgeConfig.firefox.version,
    ...(state.baseCommit ? { baseCommit: state.baseCommit } : {}),
  });

  // --- Success ---
  note(
    `Files copied to components/overrides/${componentName}/:\n` +
      copiedFiles.map((f) => `  ${f}`).join('\n') +
      '\n  override.json' +
      '\n\n' +
      'Next steps:\n' +
      `  1. Edit the copied files in components/overrides/${componentName}/\n` +
      '  2. Run "fireforge furnace preview" to see changes\n' +
      '  3. Run "fireforge build" to apply and build',
    componentName
  );

  outro('Override created');
}

/**
 * Creates multiple overrides in a single invocation. Each component is validated
 * and created sequentially; failures on one component do not block the rest.
 * @param projectRoot - Root directory of the project
 * @param names - Component tag names to override
 * @param options - CLI options applied to all overrides
 */
export async function furnaceBatchOverrideCommand(
  projectRoot: string,
  names: string[],
  options: FurnaceOverrideOptions = {}
): Promise<void> {
  intro(`Furnace Override (batch: ${names.length} components)`);

  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
  if (!options.type && !isInteractive) {
    throw new InvalidArgumentError(
      'Override type is required for batch override in non-interactive mode. Use -t css-only or -t full.',
      'type'
    );
  }

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  // Validate all names upfront before any mutations
  for (const name of names) {
    if (!CUSTOM_ELEMENT_TAG_PATTERN.test(name)) {
      throw new InvalidArgumentError(
        `Invalid component name "${name}": ${CUSTOM_ELEMENT_TAG_RULES}`,
        'name'
      );
    }
  }

  const config = await loadAuthoringFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  const forgeConfig = await loadConfig(projectRoot);
  const state = await loadState(projectRoot);

  // Check for duplicates and pre-existing classifications across every
  // bucket in furnace.json. Missing these collisions silently double-
  // classifies a tag (e.g. both stock and override) and leaves the
  // workspace in a state that later `furnace status`/`apply` cannot
  // reason about cleanly.
  const uniqueNames = [...new Set(names)];
  for (const name of uniqueNames) {
    assertNoComponentCollision(config, name);
  }

  const succeeded: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const componentName of uniqueNames) {
    const details = await getComponentDetails(paths.engine, componentName, ftlDir);
    if (!details) {
      failed.push({ name: componentName, error: 'not found in engine source tree' });
      continue;
    }

    let overrideType = options.type;
    if (!overrideType) {
      const typeResult = await select({
        message: `Override type for ${componentName}:`,
        options: [
          { value: 'css-only' as const, label: 'CSS only — restyle the component' },
          { value: 'full' as const, label: 'Full override — modify styling and behavior' },
        ],
      });
      if (isCancel(typeResult)) {
        info(`Skipping ${componentName} (cancelled)`);
        continue;
      }
      overrideType = typeResult as OverrideType;
    }

    if (overrideType === 'css-only' && !details.hasCSS) {
      failed.push({ name: componentName, error: 'no CSS files to override with --type css-only' });
      continue;
    }

    const destDir = join(furnacePaths.overridesDir, componentName);
    if (await pathExists(destDir)) {
      failed.push({ name: componentName, error: 'directory already exists' });
      continue;
    }

    try {
      await performOverrideMutations({
        projectRoot,
        componentName,
        overrideType,
        description: options.description ?? '',
        srcDir: join(paths.engine, details.sourcePath),
        destDir,
        engineDir: paths.engine,
        details,
        config,
        furnacePaths,
        ftlDir,
        firefoxVersion: forgeConfig.firefox.version,
        ...(state.baseCommit ? { baseCommit: state.baseCommit } : {}),
      });
      succeeded.push(componentName);
    } catch (error: unknown) {
      failed.push({
        name: componentName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (succeeded.length > 0) {
    note(
      `Created ${succeeded.length} override(s):\n` +
        succeeded.map((n) => `  components/overrides/${n}/`).join('\n') +
        '\n\n' +
        'Next steps:\n' +
        '  1. Edit the copied files in each override directory\n' +
        '  2. Run "fireforge furnace preview" to see changes\n' +
        '  3. Run "fireforge build" to apply and build',
      'Batch Override'
    );
  }

  if (failed.length > 0) {
    for (const f of failed) {
      warn(`${f.name}: ${f.error}`);
    }
  }

  if (succeeded.length === 0) {
    throw new FurnaceError(`All ${uniqueNames.length} override(s) failed.`);
  }

  outro(`Batch override complete: ${succeeded.length} succeeded, ${failed.length} failed`);
}
