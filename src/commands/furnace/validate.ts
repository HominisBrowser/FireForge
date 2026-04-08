// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
} from '../../core/furnace-config.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { ComponentType } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, success } from '../../utils/logger.js';
import { displayValidationIssues } from './validation-output.js';

/**
 * Runs the furnace validate command to perform static analysis on components.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name to validate (validates all if omitted)
 */
export async function furnaceValidateCommand(projectRoot: string, name?: string): Promise<void> {
  intro('Furnace Validate');

  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'No furnace.json found. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  const config = await loadFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);

  let totalErrors = 0;
  let totalWarnings = 0;
  let componentCount: number;

  if (name) {
    // --- Single component validation ---
    let type: ComponentType;
    let componentDir: string;

    if (name in config.overrides) {
      type = 'override';
      componentDir = join(furnacePaths.overridesDir, name);
    } else if (name in config.custom) {
      type = 'custom';
      componentDir = join(furnacePaths.customDir, name);
    } else if (config.stock.includes(name)) {
      info(`"${name}" is a stock component. Stock components are not validated locally.`);
      outro('Validation complete');
      return;
    } else {
      throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
    }

    if (!(await pathExists(componentDir))) {
      throw new FurnaceError(`Component directory not found for "${name}".`, name);
    }

    const issues = await validateComponent(componentDir, name, type, config, projectRoot);
    componentCount = 1;

    if (issues.length === 0) {
      success(`${name} — all checks passed`);
    } else {
      const [e, w] = displayValidationIssues(issues);
      totalErrors += e;
      totalWarnings += w;
    }
  } else {
    // --- Validate all components ---
    const overrideCount = Object.keys(config.overrides).length;
    const customCount = Object.keys(config.custom).length;

    if (overrideCount === 0 && customCount === 0) {
      info('No components to validate.');
      outro('Done');
      return;
    }

    if (config.stock.length > 0) {
      info(`Skipping ${config.stock.length} stock component(s) (no local files to validate).`);
    }

    const results = await validateAllComponents(projectRoot);
    componentCount = results.size;

    for (const [componentName, issues] of results) {
      if (issues.length === 0) {
        success(`${componentName} — all checks passed`);
      } else {
        const [e, w] = displayValidationIssues(issues);
        totalErrors += e;
        totalWarnings += w;
      }
    }
  }

  // Summary
  note(
    `${totalErrors} error(s), ${totalWarnings} warning(s) across ${componentCount} component(s)`,
    'Validation Summary'
  );

  if (totalErrors > 0) {
    info('Fix the errors above and run "fireforge furnace validate" again.');
    throw new FurnaceError(`Validation failed with ${totalErrors} error(s).`);
  }

  outro('Validation passed');
}
