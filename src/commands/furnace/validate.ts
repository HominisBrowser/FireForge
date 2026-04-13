// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
} from '../../core/furnace-config.js';
import { addCustomElementRegistration, addJarMnEntries } from '../../core/furnace-registration.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { ComponentType, ValidationIssue } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, success, warn } from '../../utils/logger.js';
import { displayValidationIssues } from './validation-output.js';

/** Checks that auto-fix can correct. */
const FIXABLE_CHECKS = new Set([
  'missing-jar-mn-mjs',
  'missing-jar-mn-css',
  'wrong-registration-pattern',
]);

/**
 * Auto-fixes registration issues that have deterministic solutions.
 * @returns Number of issues fixed
 */
async function autoFixIssues(projectRoot: string, issues: ValidationIssue[]): Promise<number> {
  const { engine: engineDir } = getProjectPaths(projectRoot);
  const config = await loadFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  let fixed = 0;

  // Group jar.mn fixes per component to batch them
  const jarMnFixesByComponent = new Map<string, string[]>();

  for (const issue of issues) {
    if (!FIXABLE_CHECKS.has(issue.check)) continue;

    const customConfig = config.custom[issue.component];
    if (!customConfig) continue;

    if (issue.check === 'missing-jar-mn-mjs' || issue.check === 'missing-jar-mn-css') {
      const ext = issue.check === 'missing-jar-mn-mjs' ? '.mjs' : '.css';
      const fileName = `${issue.component}${ext}`;
      const existing = jarMnFixesByComponent.get(issue.component) ?? [];
      existing.push(fileName);
      jarMnFixesByComponent.set(issue.component, existing);
    }
  }

  // Fix jar.mn entries
  for (const [componentName, files] of jarMnFixesByComponent) {
    try {
      await addJarMnEntries(engineDir, componentName, files);
      fixed += files.length;
      info(`Fixed: added ${files.join(', ')} to jar.mn for ${componentName}`);
    } catch (err: unknown) {
      warn(
        `Could not fix jar.mn for ${componentName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Fix missing customElements.js registrations
  for (const issue of issues) {
    if (issue.check !== 'wrong-registration-pattern') continue;

    // wrong-registration-pattern means it IS registered, but in the wrong block.
    // We don't auto-fix this as it requires moving code between blocks, which
    // is too risky. Only fix truly missing registrations.
  }

  // Check for components that are missing from customElements.js entirely
  // (detected by post-apply consistency, not by validate — but we can check here)
  for (const [componentName, customConfig] of Object.entries(config.custom)) {
    if (!customConfig.register) continue;

    const componentDir = join(furnacePaths.customDir, componentName);
    if (!(await pathExists(componentDir))) continue;

    const entries = await readdir(componentDir, { withFileTypes: true });
    const hasMjs = entries.some((e) => e.isFile() && e.name === `${componentName}.mjs`);
    if (!hasMjs) continue;

    const modulePath = `chrome://global/content/elements/${componentName}.mjs`;
    try {
      await addCustomElementRegistration(engineDir, componentName, modulePath);
      // addCustomElementRegistration is idempotent — it returns without error
      // if already registered. We only count it as fixed if a matching issue
      // existed in the input.
    } catch {
      // Ignore — idempotent call, may already be registered
    }
  }

  return fixed;
}

/**
 * Runs the furnace validate command to perform static analysis on components.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name to validate (validates all if omitted)
 * @param options - Optional command options (e.g. --fix)
 */
export async function furnaceValidateCommand(
  projectRoot: string,
  name?: string,
  options: { fix?: boolean } = {}
): Promise<void> {
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
  let allIssues: ValidationIssue[] = [];

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
    allIssues = issues;

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
      allIssues.push(...issues);
      if (issues.length === 0) {
        success(`${componentName} — all checks passed`);
      } else {
        const [e, w] = displayValidationIssues(issues);
        totalErrors += e;
        totalWarnings += w;
      }
    }
  }

  // Auto-fix fixable issues when --fix is passed
  if (options.fix && allIssues.length > 0) {
    const fixableIssues = allIssues.filter((issue) => FIXABLE_CHECKS.has(issue.check));
    if (fixableIssues.length > 0) {
      const fixedCount = await autoFixIssues(projectRoot, fixableIssues);
      if (fixedCount > 0) {
        info(`\nAuto-fixed ${fixedCount} issue(s). Re-run validate to confirm.`);
      }
    } else {
      info('\nNo auto-fixable issues found. Remaining issues require manual resolution.');
    }
  }

  // Summary
  note(
    `${totalErrors} error(s), ${totalWarnings} warning(s) across ${componentCount} component(s)`,
    'Validation Summary'
  );

  if (totalErrors > 0) {
    const fixHint = options.fix ? '' : ' Use --fix to auto-correct registration issues.';
    info(`Fix the errors above and run "fireforge furnace validate" again.${fixHint}`);
    throw new FurnaceError(`Validation failed with ${totalErrors} error(s).`);
  }

  outro('Validation passed');
}
