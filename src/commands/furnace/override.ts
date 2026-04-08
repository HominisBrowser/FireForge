// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { select, text } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  ensureFurnaceConfig,
  getFurnacePaths,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { getComponentDetails, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceOverrideOptions } from '../../types/commands/index.js';
import type { OverrideType } from '../../types/furnace.js';
import { copyFile, ensureDir, pathExists, writeJson } from '../../utils/fs.js';
import { cancel, intro, isCancel, note, outro } from '../../utils/logger.js';

/**
 * Copies the source files needed for a new override into the workspace.
 * @param srcDir - Original component directory in the engine checkout
 * @param destDir - Destination override directory in the workspace
 * @param overrideType - Requested override mode
 * @returns Filenames copied into the override directory
 */
async function copyOverrideFiles(
  srcDir: string,
  destDir: string,
  overrideType: OverrideType
): Promise<string[]> {
  await ensureDir(destDir);

  const entries = await readdir(srcDir, { withFileTypes: true });
  const copiedFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    if (overrideType === 'css-only') {
      // Only copy .css files
      if (entry.name.endsWith('.css')) {
        await copyFile(join(srcDir, entry.name), join(destDir, entry.name));
        copiedFiles.push(entry.name);
      }
    } else {
      // Full override: copy .mjs and .css files
      if (entry.name.endsWith('.mjs') || entry.name.endsWith('.css')) {
        await copyFile(join(srcDir, entry.name), join(destDir, entry.name));
        copiedFiles.push(entry.name);
      }
    }
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
  config: Awaited<ReturnType<typeof ensureFurnaceConfig>>
): Promise<void> {
  const overrideJson = {
    type: overrideType,
    description,
    basePath: details.sourcePath,
    baseVersion: firefoxVersion,
  };

  await writeJson(join(destDir, 'override.json'), overrideJson);

  config.overrides[componentName] = {
    type: overrideType,
    description,
    basePath: details.sourcePath,
    baseVersion: firefoxVersion,
  };

  await writeFurnaceConfig(projectRoot, config);
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

  // Load or create furnace.json
  const config = await ensureFurnaceConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);

  // Verify engine/ exists
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  // --- Resolve component name ---
  let componentName = name;

  if (!componentName && isInteractive) {
    // Scan for available components, filtering out already-overridden ones
    const allComponents = await scanWidgetsDirectory(paths.engine);
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
  } else if (!componentName) {
    throw new InvalidArgumentError(
      'Component name is required in non-interactive mode.\n' +
        'Usage: fireforge furnace override <name> -t <type> -d "description"',
      'name'
    );
  }

  // Validate component name to prevent path traversal
  if (!/^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(componentName)) {
    throw new InvalidArgumentError(
      `Invalid component name "${componentName}": must contain a hyphen (required for custom elements), with only lowercase letters, digits, and hyphens.`,
      'name'
    );
  }

  // Check for existing override
  if (componentName in config.overrides) {
    throw new FurnaceError(
      `An override for "${componentName}" already exists in furnace.json`,
      componentName
    );
  }

  // Validate the component exists in engine
  const details = await getComponentDetails(paths.engine, componentName);
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
  const copiedFiles = await copyOverrideFiles(srcDir, destDir, overrideType);

  await saveOverrideConfig(
    projectRoot,
    destDir,
    componentName,
    overrideType,
    description,
    details,
    forgeConfig.firefox.version,
    config
  );

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
