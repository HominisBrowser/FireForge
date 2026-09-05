// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { select, text } from '@clack/prompts';

import { getProjectPaths, loadConfig, loadState } from '../../core/config.js';
import { stdioIsInteractive } from '../../core/destructive.js';
import { getFurnacePaths, writeFurnaceConfig } from '../../core/furnace-config.js';
import { resolveFtlDir } from '../../core/furnace-constants.js';
import { completeJournalRollback, runFurnaceMutation } from '../../core/furnace-operation.js';
import { assertFurnaceEngineReady } from '../../core/furnace-precondition.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  CUSTOM_ELEMENT_TAG_RULES,
} from '../../core/furnace-registration-validate.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getComponentDetails, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceOverrideOptions } from '../../types/commands/index.js';
import type { OverrideType } from '../../types/furnace.js';
import type { FurnaceConfig } from '../../types/index.js';
import { toError } from '../../utils/errors.js';
import { copyFile, ensureDir, pathExists, writeJson } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, note, outro, warn } from '../../utils/logger.js';
import { loadAuthoringFurnaceConfig } from './authoring-config.js';

interface CopyOverrideFilesOptions {
  /** Absolute path to the engine checkout. */
  engineDir: string;
  /** Original component directory in the engine checkout. */
  srcDir: string;
  /** Destination override directory in the workspace. */
  destDir: string;
  /** Custom element tag name being overridden. */
  componentName: string;
  /** Whether the component ships a localized `.ftl` file. */
  hasFTL: boolean;
  /** Requested override mode. */
  overrideType: OverrideType;
  /** Engine-relative directory the shared `.ftl` deploys into. */
  ftlDir: string;
  /** Rollback journal every write is recorded in. */
  journal: RollbackJournal;
}

/**
 * Copies the source files needed for a new override into the workspace.
 * @param options - See {@link CopyOverrideFilesOptions}
 * @returns Filenames copied into the override directory
 */
async function copyOverrideFiles(options: CopyOverrideFilesOptions): Promise<string[]> {
  const { engineDir, srcDir, destDir, componentName, hasFTL, overrideType, ftlDir, journal } =
    options;
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

interface SaveOverrideConfigOptions {
  /** Project root holding `furnace.json`. */
  projectRoot: string;
  /** Override directory the `override.json` marker is written into. */
  destDir: string;
  /** Custom element tag name being overridden. */
  componentName: string;
  /** Requested override mode. */
  overrideType: OverrideType;
  /** Human-readable override description. */
  description: string;
  /** Resolved engine details for the overridden component. */
  details: { sourcePath: string };
  /** Firefox version the override was forked from. */
  firefoxVersion: string;
  /** Rollback journal every write is recorded in. */
  journal: RollbackJournal;
  /** Engine commit the override was forked from, when known. */
  baseCommit?: string | undefined;
}

/**
 * Writes override metadata to disk and updates furnace.json with the new
 * override entry. Re-reads the current on-disk furnace.json inside the
 * operation lock and splices the new entry onto the fresh state, so two
 * concurrent `furnace override` commands cannot race their read-modify-write
 * cycles into a single surviving entry — otherwise both report success and
 * furnace.json keeps only the second writer's.
 */
async function saveOverrideConfig(options: SaveOverrideConfigOptions): Promise<void> {
  const {
    projectRoot,
    destDir,
    componentName,
    overrideType,
    description,
    details,
    firefoxVersion,
    journal,
    baseCommit,
  } = options;
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

  // Re-read the current furnace.json inside the lock. The outer caller
  // loaded a snapshot before entering `runFurnaceMutation`, but another
  // furnace mutation (override / init / sync) may have landed in between
  // — writing back the stale snapshot would drop that concurrent write.
  const freshConfig = await loadAuthoringFurnaceConfig(projectRoot);
  freshConfig.overrides[componentName] = {
    type: overrideType,
    description,
    basePath: details.sourcePath,
    baseVersion: firefoxVersion,
    ...(baseCommit ? { baseCommit } : {}),
  };
  // Promote from the stock bucket here, against the fresh state, so the
  // stock→override transition survives even when another concurrent
  // override already rewrote furnace.json between the outer read and
  // this write.
  const stockIndex = freshConfig.stock.indexOf(componentName);
  if (stockIndex !== -1) {
    freshConfig.stock.splice(stockIndex, 1);
  }

  await writeFurnaceConfig(projectRoot, freshConfig);
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
  config: FurnaceConfig;
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
        const filesCopied = await copyOverrideFiles({
          engineDir: args.engineDir,
          srcDir: args.srcDir,
          destDir: args.destDir,
          componentName: args.componentName,
          hasFTL: args.details.hasFTL,
          overrideType: args.overrideType,
          ftlDir: args.ftlDir,
          journal,
        });

        await snapshotFile(journal, args.furnacePaths.furnaceConfig);
        await saveOverrideConfig({
          projectRoot: args.projectRoot,
          destDir: args.destDir,
          componentName: args.componentName,
          overrideType: args.overrideType,
          description: args.description,
          details: args.details,
          firefoxVersion: args.firefoxVersion,
          journal,
          baseCommit: args.baseCommit,
        });

        return filesCopied;
      } catch (error: unknown) {
        return await completeJournalRollback(ctx, journal, error, {
          projectRoot: args.projectRoot,
          operation: 'override-rollback',
          failureMessage: `Failed to override component "${args.componentName}"`,
          subject: `component "${args.componentName}"`,
        });
      }
    }
  );
}

/**
 * Throws if `componentName` is already classified as something `override`
 * cannot coexist with. A stock-bucket entry is NOT a hard conflict — the
 * whole point of `override` is to fork a component out of the stock bucket
 * into the overrides bucket, and requiring manual `furnace.json` surgery
 * first was a pure footgun. `promoteStockToOverrideIfNeeded` handles the
 * transition in-memory; this guard only rejects the other two cases where
 * a rename actually contradicts existing state.
 */
function assertNoComponentCollision(config: FurnaceConfig, componentName: string): void {
  if (componentName in config.overrides) {
    throw new FurnaceError(
      `An override for "${componentName}" already exists in furnace.json`,
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
 * When the operator overrides a component that `furnace scan` previously
 * classified as stock, splice the name out of `config.stock` in-memory so
 * the subsequent `writeFurnaceConfig` inside the mutation phase persists
 * the stock → override promotion atomically alongside the new override
 * entry. Returns true when a promotion happened so the caller can emit a
 * one-line note; false when the component was not stock.
 */
function promoteStockToOverrideIfNeeded(config: FurnaceConfig, componentName: string): boolean {
  const index = config.stock.indexOf(componentName);
  if (index === -1) return false;
  config.stock.splice(index, 1);
  return true;
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
  const isInteractive = stdioIsInteractive();

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
  await assertFurnaceEngineReady(projectRoot);

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

    componentName = selected;
  }

  assertNoComponentCollision(config, componentName);
  const promotedFromStock = promoteStockToOverrideIfNeeded(config, componentName);
  if (promotedFromStock) {
    info(`Promoting "${componentName}" from stock to override.`);
  }

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

    overrideType = typeResult;
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
      description = descResult;
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

  const isInteractive = stdioIsInteractive();
  if (!options.type && !isInteractive) {
    throw new InvalidArgumentError(
      'Override type is required for batch override in non-interactive mode. Use -t css-only or -t full.',
      'type'
    );
  }

  const paths = getProjectPaths(projectRoot);
  await assertFurnaceEngineReady(projectRoot);

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
  // bucket in furnace.json. A stock-bucket entry is promoted in-memory
  // here (see `promoteStockToOverrideIfNeeded`) rather than rejected —
  // the operator's intent is to fork that specific stock component. The
  // collision guard still rejects name conflicts that would double-
  // classify a tag in a way `writeFurnaceConfig` cannot safely produce
  // (two overrides, or an override + custom).
  const uniqueNames = [...new Set(names)];
  for (const name of uniqueNames) {
    assertNoComponentCollision(config, name);
    if (promoteStockToOverrideIfNeeded(config, name)) {
      info(`Promoting "${name}" from stock to override.`);
    }
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
      overrideType = typeResult;
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
        error: toError(error).message,
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
