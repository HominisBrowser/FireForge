// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { getFurnacePaths } from '../../core/furnace-config.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { DryRunAction, FurnaceConfig, ValidationIssue } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, type SpinnerHandle, success, warn } from '../../utils/logger.js';

/**
 * Displays validation issues and returns aggregated error and warning counts.
 * @param issues - Validation issues to render
 * @returns Tuple of [errorCount, warningCount]
 */
export function displayValidationIssues(issues: ValidationIssue[]): [number, number] {
  let errors = 0;
  let warnings = 0;

  for (const issue of issues) {
    if (issue.severity === 'error') {
      error(`${issue.component}: [${issue.check}] ${issue.message}`);
      errors++;
    } else {
      warn(`${issue.component}: [${issue.check}] ${issue.message}`);
      warnings++;
    }
  }

  return [errors, warnings];
}

function filterProjectedDryRunIssues(
  issues: ValidationIssue[],
  actions: DryRunAction[] | undefined
): ValidationIssue[] {
  if (!actions || actions.length === 0) return issues;

  const plannedJarRegistrations = new Set(
    actions.filter((action) => action.action === 'register-jar').map((action) => action.component)
  );

  return issues.filter((issue) => {
    if (
      plannedJarRegistrations.has(issue.component) &&
      (issue.check === 'missing-jar-mn-mjs' || issue.check === 'missing-jar-mn-css')
    ) {
      return false;
    }
    return true;
  });
}

function resolveNamedValidationTarget(
  name: string,
  config: FurnaceConfig,
  furnacePaths: ReturnType<typeof getFurnacePaths>
): { type: 'override' | 'custom'; componentDir: string } | 'stock' {
  if (name in config.overrides) {
    return {
      type: 'override',
      componentDir: join(furnacePaths.overridesDir, name),
    };
  }

  if (name in config.custom) {
    return {
      type: 'custom',
      componentDir: join(furnacePaths.customDir, name),
    };
  }

  if (config.stock.includes(name)) {
    return 'stock';
  }

  throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
}

export type ValidationResult =
  | { done: true }
  | {
      done: false;
      totalErrors: number;
      totalWarnings: number;
      componentCount: number;
      skippedValidationCount: number;
    };

/**
 * Runs the validation phase of a furnace deploy, checking all or a single component.
 * @param validateSpinner - Active spinner handle for progress display
 * @param name - Optional component name (validates all if omitted)
 * @param config - Loaded Furnace configuration
 * @param furnacePaths - Resolved Furnace workspace paths
 * @param failedComponents - Names of components whose apply step failed
 * @param isDryRun - Whether deploy is running in dry-run mode
 * @param projectRoot - Root directory of the project
 * @returns Validation counts, or `done: true` if the caller should early-return
 */
export async function runDeployValidation(
  validateSpinner: SpinnerHandle,
  name: string | undefined,
  config: FurnaceConfig,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  failedComponents: Set<string>,
  isDryRun: boolean,
  projectRoot: string,
  dryRunActions?: DryRunAction[]
): Promise<ValidationResult> {
  let totalErrors = 0;
  let totalWarnings = 0;
  let componentCount = 0;
  let skippedValidationCount = 0;

  if (name && failedComponents.has(name)) {
    skippedValidationCount = 1;
    validateSpinner.stop('Validation skipped');
    warn(`Skipping validation for ${name} because apply failed.`);
  } else if (name) {
    const target = resolveNamedValidationTarget(name, config, furnacePaths);
    if (target === 'stock') {
      validateSpinner.stop('Validation skipped');
      info(`"${name}" is a stock component. Stock components are not validated locally.`);
      outro(isDryRun ? 'Dry run complete' : 'Deploy complete');
      return { done: true };
    }

    if (!(await pathExists(target.componentDir))) {
      validateSpinner.stop('Validation failed');
      throw new FurnaceError(`Component directory not found for "${name}".`, name);
    }

    const rawIssues = await validateComponent(
      target.componentDir,
      name,
      target.type,
      config,
      projectRoot
    );
    const issues = isDryRun ? filterProjectedDryRunIssues(rawIssues, dryRunActions) : rawIssues;
    componentCount = 1;

    validateSpinner.stop('Validation complete');

    if (issues.length === 0) {
      success(`${name} — all checks passed`);
    } else {
      const [errors, warnings] = displayValidationIssues(issues);
      totalErrors += errors;
      totalWarnings += warnings;
    }
  } else {
    const results = await validateAllComponents(projectRoot);

    validateSpinner.stop('Validation complete');

    for (const [componentName, issues] of results) {
      if (failedComponents.has(componentName)) {
        skippedValidationCount++;
        continue;
      }

      componentCount++;
      const projectedIssues = isDryRun
        ? filterProjectedDryRunIssues(issues, dryRunActions)
        : issues;
      if (projectedIssues.length === 0) {
        success(`${componentName} — all checks passed`);
      } else {
        const [errors, warnings] = displayValidationIssues(projectedIssues);
        totalErrors += errors;
        totalWarnings += warnings;
      }
    }

    if (skippedValidationCount > 0) {
      warn(
        `Skipped validation for ${skippedValidationCount} component(s) because their apply step failed.`
      );
    }
  }

  return { done: false, totalErrors, totalWarnings, componentCount, skippedValidationCount };
}
