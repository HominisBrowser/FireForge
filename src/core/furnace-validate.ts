// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists } from '../utils/fs.js';
import { loadConfig } from './config.js';
import { getFurnacePaths, loadFurnaceConfig } from './furnace-config.js';
import { detectComposesCycles, validateComposesReferences } from './furnace-graph-utils.js';
import {
  validateAccessibility,
  validateCompatibility,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateStructure,
  validateTokenLink,
} from './furnace-validate-checks.js';
import {
  findOverrideBaseVersionDrift,
  type OverrideVersionDrift,
} from './furnace-version-drift.js';

function buildOverrideVersionDriftIssues(
  config: FurnaceConfig,
  currentVersion: string,
  tagName?: string
): ValidationIssue[] {
  return findOverrideBaseVersionDrift(config, currentVersion)
    .filter((entry: OverrideVersionDrift) => tagName === undefined || entry.name === tagName)
    .map((entry: OverrideVersionDrift) => ({
      component: entry.name,
      severity: 'error' as const,
      check: 'override-base-version-drift',
      message:
        `Override targets Firefox ${entry.baseVersion}, but fireforge.json records ${entry.currentVersion}. ` +
        'Refresh the override if upstream changed, or update baseVersion in furnace.json to acknowledge the new baseline.',
    }));
}

// ---------------------------------------------------------------------------
// Aggregate validators
// ---------------------------------------------------------------------------

/**
 * Runs all validation checks on a single component.
 *
 * @param componentDir - Path to the component directory
 * @param tagName - Component tag name
 * @param type - Component type (stock, override, custom)
 * @param config - Optional furnace config for cross-component checks
 * @param root - Optional project root for checks that read outside componentDir
 * @param options - Optional behavior flags. `skipAggregateChecks` suppresses the
 *        per-component registration/jar.mn scan so that an outer caller
 *        (e.g. validateAllComponents) can run the aggregate versions once
 *        without double-reporting the same issues.
 * @returns Combined list of validation issues
 */
export async function validateComponent(
  componentDir: string,
  tagName: string,
  type: ComponentType,
  config?: FurnaceConfig,
  root?: string,
  options?: { skipAggregateChecks?: boolean }
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Pass the matching custom config so structure validation can enforce
  // the .ftl-when-localized invariant. Non-custom validations ignore the
  // parameter, so this is a no-op for stock and override components.
  issues.push(
    ...(await validateStructure(
      componentDir,
      tagName,
      type,
      type === 'custom' ? config?.custom[tagName] : undefined
    ))
  );
  issues.push(...(await validateAccessibility(componentDir, tagName)));
  issues.push(...(await validateCompatibility(componentDir, tagName, type, config, root)));

  if (root && config && type === 'override') {
    const forgeConfig = await loadConfig(root);
    issues.push(...buildOverrideVersionDriftIssues(config, forgeConfig.firefox.version, tagName));
  }

  // Check for missing token link across configured chrome host documents.
  if (root) {
    issues.push(
      ...(await validateTokenLink(
        componentDir,
        tagName,
        root,
        config?.tokenPrefix,
        config?.tokenHostDocuments
      ))
    );
  }

  // When root is provided and this is a custom component with registration,
  // also run registration pattern and jar.mn validation for this component.
  // Skipped when an outer orchestrator (validateAllComponents) will run the
  // aggregate versions itself; otherwise the same issues are reported twice.
  if (root && config && type === 'custom' && !options?.skipAggregateChecks) {
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

  // Validate composition graph integrity (dangling references and cycles)
  try {
    validateComposesReferences(config.stock, config.overrides, config.custom);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Attribute the issue to the first custom component with a bad composes reference
    for (const [name, cfg] of Object.entries(config.custom)) {
      if (cfg.composes) {
        const existing = results.get(name) ?? [];
        existing.push({
          component: name,
          severity: 'error',
          check: 'composes-dangling-reference',
          message,
        });
        results.set(name, existing);
        break;
      }
    }
  }

  try {
    detectComposesCycles(config.custom);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Attribute the cycle issue to the first custom component in the cycle
    for (const name of Object.keys(config.custom)) {
      if (config.custom[name]?.composes) {
        const existing = results.get(name) ?? [];
        existing.push({
          component: name,
          severity: 'error',
          check: 'composes-cycle',
          message,
        });
        results.set(name, existing);
        break;
      }
    }
  }

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
    // Skip registration/jar.mn checks inside validateComponent — the aggregate
    // validators below run them exactly once across all components, which both
    // surfaces cross-component issues and avoids double-counting.
    const issues = await validateComponent(componentDir, name, 'custom', config, root, {
      skipAggregateChecks: true,
    });
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
