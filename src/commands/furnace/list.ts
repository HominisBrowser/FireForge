// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import {
  extractComponentChecksums,
  hasComponentChanged,
} from '../../core/furnace-apply-helpers.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from '../../core/furnace-config.js';
import { pathExists } from '../../utils/fs.js';
import {
  formatErrorText,
  formatSuccessText,
  info,
  intro,
  note,
  outro,
} from '../../utils/logger.js';

/**
 * Returns a short health indicator for a component directory based on whether
 * its workspace checksums have changed since the last apply.
 */
async function getHealthIndicator(
  componentDir: string,
  type: 'override' | 'custom',
  name: string,
  appliedChecksums: Record<string, string> | undefined
): Promise<string> {
  try {
    if (!(await pathExists(componentDir))) {
      return formatErrorText('missing');
    }
    const previous = extractComponentChecksums(appliedChecksums, type, name);
    if (Object.keys(previous).length === 0) {
      return formatErrorText('not applied');
    }
    const changed = await hasComponentChanged(componentDir, previous);
    return changed ? formatErrorText('modified') : formatSuccessText('clean');
  } catch {
    // A race with `furnace remove`, filesystem permission change, or a
    // transient IO failure must not crash the entire `list -v` output —
    // render a degraded state so the rest of the table still shows.
    return formatErrorText('unavailable');
  }
}

/**
 * Runs the furnace list command to display all registered components.
 * @param projectRoot - Root directory of the project
 * @param options - List options
 */
export async function furnaceListCommand(
  projectRoot: string,
  options: { verbose?: boolean } = {}
): Promise<void> {
  intro('Furnace List');

  if (!(await furnaceConfigExists(projectRoot))) {
    info(
      'No components configured. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
    outro('Done');
    return;
  }

  const config = await loadFurnaceConfig(projectRoot);

  const stockCount = config.stock.length;
  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;
  const total = stockCount + overrideCount + customCount;

  if (total === 0) {
    info(
      'No components configured. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
    outro('Done');
    return;
  }

  const showHealth = options.verbose ?? false;
  const furnacePaths = showHealth ? getFurnacePaths(projectRoot) : undefined;
  const state = showHealth ? await loadFurnaceState(projectRoot) : undefined;

  // --- Stock ---
  if (stockCount > 0) {
    info('Stock:');
    for (const name of config.stock) {
      info(`  ${name}`);
    }
  }

  // --- Overrides ---
  if (overrideCount > 0) {
    info('Overrides:');
    for (const [name, entry] of Object.entries(config.overrides)) {
      let line = `  ${name} (${entry.type})`;
      if (entry.description) {
        line += ` — ${entry.description}`;
      }
      if (showHealth && furnacePaths && state) {
        const componentDir = join(furnacePaths.overridesDir, name);
        const health = await getHealthIndicator(
          componentDir,
          'override',
          name,
          state.appliedChecksums
        );
        line += ` [${health}]`;
      }
      info(line);
    }
  }

  // --- Custom ---
  if (customCount > 0) {
    info('Custom:');
    for (const [name, entry] of Object.entries(config.custom)) {
      const flags: string[] = [];
      if (entry.localized) flags.push('localized');
      if (entry.register) flags.push('registered');

      let line = `  ${name}`;
      if (entry.description) {
        line += ` — ${entry.description}`;
      }
      if (flags.length > 0) {
        line += ` [${flags.join(', ')}]`;
      }
      if (showHealth && furnacePaths && state) {
        const componentDir = join(furnacePaths.customDir, name);
        const health = await getHealthIndicator(
          componentDir,
          'custom',
          name,
          state.appliedChecksums
        );
        line += ` [${health}]`;
      }
      info(line);
    }
  }

  note(
    `Stock: ${stockCount}  Overrides: ${overrideCount}  Custom: ${customCount}  Total: ${total}`,
    'Summary'
  );

  outro('List complete');
}
