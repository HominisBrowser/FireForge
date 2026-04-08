// SPDX-License-Identifier: EUPL-1.2
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { confirm } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import {
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import { deregisterTestManifest } from '../../core/manifest-register.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceRemoveOptions } from '../../types/commands/index.js';
import type { ComponentType } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { pathExists, readText, removeDir, writeText } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, outro, warn } from '../../utils/logger.js';

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
 * Removes generated browser mochitest files associated with a custom component.
 * @param name - Custom component tag name
 * @param projectRoot - Root directory of the project
 */
async function cleanupCustomTestFiles(name: string, projectRoot: string): Promise<void> {
  try {
    const forgeConfig = await loadConfig(projectRoot);
    const paths = getProjectPaths(projectRoot);
    const binaryName = forgeConfig.binaryName;
    const strippedName = name.startsWith('moz-') ? name.slice(4) : name;
    const withoutBinaryPrefix = strippedName.startsWith(binaryName + '-')
      ? strippedName.slice(binaryName.length + 1)
      : strippedName;
    const underscored = withoutBinaryPrefix.replace(/-/g, '_');
    const testFileName = `browser_${binaryName}_${underscored}.js`;
    const testDir = join(paths.engine, 'browser/base/content/test', binaryName);

    if (await pathExists(testDir)) {
      const testFilePath = join(testDir, testFileName);
      if (await pathExists(testFilePath)) {
        await unlink(testFilePath);
        info(`Deleted test file: ${testFileName}`);
      }

      const tomlPath = join(testDir, 'browser.toml');
      if (await pathExists(tomlPath)) {
        const toml = await readText(tomlPath);
        const entryPattern = `["${testFileName}"]`;
        if (toml.includes(entryPattern)) {
          const updated = toml.replace(new RegExp(`\\n?\\n?\\["${testFileName}"\\]\\n?`), '\n');
          await writeText(tomlPath, updated);
        }
      }

      const remaining = await readdir(testDir);
      const hasTests = remaining.some((f) => f.startsWith('browser_') && f.endsWith('.js'));
      if (!hasTests) {
        await removeDir(testDir);
        info(`Deleted empty test directory: browser/base/content/test/${binaryName}/`);
        if (await deregisterTestManifest(paths.engine, binaryName)) {
          info('Deregistered test manifest from browser/base/moz.build');
        }
      }
    }
  } catch (error: unknown) {
    warn(
      `Could not clean up test files — ${toError(error).message}. Remove them manually if needed.`
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

  // Require --force in non-interactive mode to prevent silent removals
  if (!isInteractive && !options.force) {
    throw new FurnaceError(
      `Cannot remove "${name}" in non-interactive mode without --force flag.`,
      name
    );
  }

  // Confirm removal (skip if --force)
  if (!options.force && isInteractive) {
    const confirmed = await confirm({
      message: `Remove ${type} component "${name}"?`,
    });

    if (isCancel(confirmed) || !confirmed) {
      cancel('Remove cancelled');
      return;
    }
  }

  // Delete component directory for override and custom types
  const paths = getProjectPaths(projectRoot);
  if (type === 'override') {
    const dir = join(furnacePaths.overridesDir, name);
    if (await pathExists(dir)) {
      await removeDir(dir);
      info(`Deleted components/overrides/${name}/`);
    }
    // Clean up deployed files in engine
    const overrideConfig = config.overrides[name];
    if (overrideConfig?.basePath) {
      const engineDir = join(paths.engine, overrideConfig.basePath);
      if (await pathExists(engineDir)) {
        warn(
          `Deployed files may remain in engine/${overrideConfig.basePath}. Run "fireforge reset -f && fireforge import" to clean.`
        );
      }
    }
  } else if (type === 'custom') {
    const customConfig = config.custom[name];
    if (customConfig?.register) {
      await removeCustomElementRegistration(paths.engine, name);
      info(`Deregistered ${name} from customElements.js`);
    }

    await removeJarMnEntries(paths.engine, name);
    info(`Removed ${name} entries from toolkit/content/jar.mn`);

    const dir = join(furnacePaths.customDir, name);
    if (await pathExists(dir)) {
      await removeDir(dir);
      info(`Deleted components/custom/${name}/`);
    }
    // Clean up deployed files in engine
    if (customConfig?.targetPath) {
      const engineDir = join(paths.engine, customConfig.targetPath);
      if (await pathExists(engineDir)) {
        await removeDir(engineDir);
        info(`Deleted deployed files from engine/${customConfig.targetPath}/`);
      }
    }
  }

  if (type === 'custom') {
    await cleanupCustomTestFiles(name, projectRoot);
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

  await writeFurnaceConfig(projectRoot, config);

  info(`Removed "${name}" from furnace.json`);
  outro('Component removed');
}
