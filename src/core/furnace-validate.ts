// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists } from '../utils/fs.js';
import { getFurnacePaths, loadFurnaceConfig } from './furnace-config.js';
import {
  validateAccessibility,
  validateCompatibility,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateStructure,
  validateTokenLink,
} from './furnace-validate-checks.js';

// ---------------------------------------------------------------------------
// Aggregate validators
// ---------------------------------------------------------------------------

/**
 * Runs all validation checks on a single component.
 * @param componentDir - Path to the component directory
 * @param tagName - Component tag name
 * @param type - Component type (stock, override, custom)
 * @returns Combined list of validation issues
 */
export async function validateComponent(
  componentDir: string,
  tagName: string,
  type: ComponentType,
  config?: FurnaceConfig,
  root?: string
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  issues.push(...(await validateStructure(componentDir, tagName, type)));
  issues.push(...(await validateAccessibility(componentDir, tagName)));
  issues.push(...(await validateCompatibility(componentDir, tagName, type, config, root)));

  // Check for missing token link in browser.xhtml
  if (root) {
    issues.push(...(await validateTokenLink(componentDir, tagName, root, config?.tokenPrefix)));
  }

  // When root is provided and this is a custom component with registration,
  // also run registration pattern and jar.mn validation for this component.
  if (root && config && type === 'custom') {
    const customConfig = config.custom[tagName];
    if (customConfig?.register) {
      const singleConfig: FurnaceConfig = {
        ...config,
        custom: { [tagName]: customConfig },
      };
      issues.push(...(await validateRegistrationPatterns(root, singleConfig)));
      issues.push(...(await validateJarMnEntries(root, singleConfig)));
    }
  }

  return issues;
}

/**
 * Validates all components registered in furnace.json.
 * Stock components are skipped (no local files to validate).
 * @param root - Project root directory
 * @returns Map of component name to its validation issues
 */
export async function validateAllComponents(root: string): Promise<Map<string, ValidationIssue[]>> {
  const config = await loadFurnaceConfig(root);
  const furnacePaths = getFurnacePaths(root);
  const results = new Map<string, ValidationIssue[]>();

  // Override components
  for (const name of Object.keys(config.overrides)) {
    const componentDir = join(furnacePaths.overridesDir, name);
    if (!(await pathExists(componentDir))) {
      results.set(name, [
        {
          component: name,
          severity: 'error',
          check: 'missing-component-dir',
          message: `Component directory not found: components/overrides/${name}`,
        },
      ]);
      continue;
    }
    const issues = await validateComponent(componentDir, name, 'override', config, root);
    results.set(name, issues);
  }

  // Custom components
  for (const name of Object.keys(config.custom)) {
    const componentDir = join(furnacePaths.customDir, name);
    if (!(await pathExists(componentDir))) {
      results.set(name, [
        {
          component: name,
          severity: 'error',
          check: 'missing-component-dir',
          message: `Component directory not found: components/custom/${name}`,
        },
      ]);
      continue;
    }
    // Pass root so that per-component token link validation runs.
    // Per-component registration/jar.mn checks are also included, but that's
    // acceptable as the aggregate validators below deduplicate by component name.
    const issues = await validateComponent(componentDir, name, 'custom', config, root);
    results.set(name, issues);
  }

  // Registration pattern validation (customElements.js Pattern A vs B)
  const registrationIssues = await validateRegistrationPatterns(root, config);
  for (const issue of registrationIssues) {
    const existing = results.get(issue.component) ?? [];
    existing.push(issue);
    results.set(issue.component, existing);
  }

  // jar.mn entry validation
  const jarMnIssues = await validateJarMnEntries(root, config);
  for (const issue of jarMnIssues) {
    const existing = results.get(issue.component) ?? [];
    existing.push(issue);
    results.set(issue.component, existing);
  }

  return results;
}
