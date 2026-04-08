// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import { extractComponentChecksums, hasComponentChanged } from '../../core/furnace-apply.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from '../../core/furnace-config.js';
import { checkRegistrationConsistency } from '../../core/furnace-validate-checks.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, warn } from '../../utils/logger.js';

/**
 * Displays detailed status for a single Furnace component, including registration drift.
 * @param name - Component tag name to inspect
 * @param config - Loaded Furnace configuration
 * @param projectRoot - Root directory of the project
 */
async function showDetailedComponentStatus(
  name: string,
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>,
  projectRoot: string
): Promise<void> {
  const customConfig = config.custom[name];
  const overrideConfig = config.overrides[name];

  if (!customConfig && !overrideConfig && !config.stock.includes(name)) {
    throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
  }

  if (overrideConfig) {
    info(`"${name}" is an override component (${overrideConfig.type}).`);
    info(`Base path: ${overrideConfig.basePath}`);
    info(`Base version: ${overrideConfig.baseVersion}`);
    outro('');
    return;
  }

  if (config.stock.includes(name)) {
    info(`"${name}" is a stock component. No local registration to check.`);
    outro('');
    return;
  }

  if (!customConfig) {
    outro('');
    return;
  }

  // Custom component — run registration consistency check
  const status = await checkRegistrationConsistency(projectRoot, name, customConfig);

  const lines: string[] = [];
  const check = (ok: boolean, label: string): void => {
    lines.push(`${ok ? '\u2713' : '\u2717'} ${label}`);
  };

  check(status.sourceExists, 'Source directory exists');
  check(status.targetExists, 'Target directory exists in engine');
  check(status.filesInSync, 'Source and target files in sync');
  check(status.jarMnMjs, `jar.mn has ${name}.mjs entry`);
  check(status.jarMnCss, `jar.mn has ${name}.css entry`);
  check(status.customElementsPresent, 'Registered in customElements.js');
  check(status.customElementsCorrectBlock, 'In correct DOMContentLoaded block');

  if (status.driftedFiles.length > 0) {
    lines.push(`Drifted files: ${status.driftedFiles.join(', ')}`);
  }
  if (status.missingTargetFiles.length > 0) {
    lines.push(`Missing in engine: ${status.missingTargetFiles.join(', ')}`);
  }

  note(lines.join('\n'), `${name} Registration Status`);

  outro('');
}

/**
 * Runs the furnace status command to show an overview of Furnace state.
 * When a component name is provided, shows detailed registration status.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name for detailed status
 */
export async function furnaceStatusCommand(projectRoot: string, name?: string): Promise<void> {
  intro('Furnace');

  if (!(await furnaceConfigExists(projectRoot))) {
    info(
      'Furnace is not configured. Run `fireforge furnace create` or `fireforge furnace override` to get started.'
    );
    outro('');
    return;
  }

  const config = await loadFurnaceConfig(projectRoot);
  const state = await loadFurnaceState(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);

  if (name) {
    await showDetailedComponentStatus(name, config, projectRoot);
    return;
  }

  // --- Overview mode ---
  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;
  const stockCount = config.stock.length;

  // Build summary lines
  const lines: string[] = [];
  lines.push(`Component prefix: ${config.componentPrefix || '(none)'}`);
  lines.push(`Stock components: ${stockCount}`);

  // Overrides
  lines.push(`Override components: ${overrideCount}`);
  if (overrideCount > 0) {
    for (const [oName, entry] of Object.entries(config.overrides)) {
      lines.push(`  ${oName} (${entry.type})`);
    }
  }

  // Custom
  lines.push(`Custom components: ${customCount}`);
  if (customCount > 0) {
    for (const cName of Object.keys(config.custom)) {
      lines.push(`  ${cName}`);
    }
  }

  // Last apply
  lines.push(`Last apply: ${state.lastApply ?? 'never'}`);

  note(lines.join('\n'), 'Furnace Status');

  // Check for changes since last apply
  if (await pathExists(paths.engine)) {
    let changesDetected = false;

    for (const oName of Object.keys(config.overrides)) {
      const componentDir = join(furnacePaths.overridesDir, oName);
      if (!(await pathExists(componentDir))) continue;
      const previous = extractComponentChecksums(state.appliedChecksums, 'override', oName);
      if (await hasComponentChanged(componentDir, previous)) {
        changesDetected = true;
        break;
      }
    }

    if (!changesDetected) {
      for (const cName of Object.keys(config.custom)) {
        const componentDir = join(furnacePaths.customDir, cName);
        if (!(await pathExists(componentDir))) continue;
        const previous = extractComponentChecksums(state.appliedChecksums, 'custom', cName);
        if (await hasComponentChanged(componentDir, previous)) {
          changesDetected = true;
          break;
        }
      }
    }

    if (changesDetected) {
      warn(
        'Components have been modified since last apply. Run `fireforge build` or `fireforge furnace apply`.'
      );
    }
  }

  outro('');
}
