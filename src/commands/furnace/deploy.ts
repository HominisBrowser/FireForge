// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import {
  applyAllComponents,
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  prefixChecksums,
} from '../../core/furnace-apply.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  updateFurnaceState,
} from '../../core/furnace-config.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
} from '../../core/furnace-rollback.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceDeployOptions } from '../../types/commands/index.js';
import type { ComponentType } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, note, outro, spinner, success, warn } from '../../utils/logger.js';
import { displayValidationIssues } from './validation-output.js';

/**
 * Builds the final deploy failure summary from apply and validation error counts.
 * @param applyErrors - Number of component application failures
 * @param validationErrors - Number of validation failures
 * @param isDryRun - Whether deploy was running in dry-run mode
 * @returns User-facing deploy summary message
 */
function buildDeployFailureMessage(
  applyErrors: number,
  validationErrors: number,
  isDryRun: boolean
): string {
  const mode = isDryRun ? 'Dry run' : 'Deploy';

  if (applyErrors > 0 && validationErrors > 0) {
    return `${mode} completed with ${applyErrors} apply error(s) and ${validationErrors} validation error(s).`;
  }

  if (applyErrors > 0) {
    return `${mode} completed with ${applyErrors} apply error(s).`;
  }

  return `${mode} completed with ${validationErrors} validation error(s).`;
}

function getStepFailureCount(result: Awaited<ReturnType<typeof applyAllComponents>>): number {
  return result.applied.filter((entry) => (entry.stepErrors?.length ?? 0) > 0).length;
}

function getFailedComponentNames(
  result: Awaited<ReturnType<typeof applyAllComponents>>
): Set<string> {
  const failed = new Set(result.errors.map((entry) => entry.name));

  for (const applied of result.applied) {
    if ((applied.stepErrors?.length ?? 0) > 0) {
      failed.add(applied.name);
    }
  }

  return failed;
}

/**
 * Persists checksum state for a successfully applied named component.
 * @param projectRoot - Root directory of the project
 * @param appliedEntry - Applied component descriptor from deploy
 * @param furnacePaths - Resolved Furnace workspace paths
 */
async function persistSingleComponentState(
  projectRoot: string,
  appliedEntry: { name: string; type: string },
  furnacePaths: ReturnType<typeof getFurnacePaths>
): Promise<void> {
  const componentDir =
    appliedEntry.type === 'override'
      ? join(furnacePaths.overridesDir, appliedEntry.name)
      : join(furnacePaths.customDir, appliedEntry.name);
  const checksums = await computeComponentChecksums(componentDir);
  const prefixed = prefixChecksums(checksums, appliedEntry.type, appliedEntry.name);
  await updateFurnaceState(projectRoot, (current) => ({
    ...current,
    appliedChecksums: { ...(current.appliedChecksums ?? {}), ...prefixed },
    lastApply: new Date().toISOString(),
  }));
}

/**
 * Applies a single named override or custom component in targeted deploy mode.
 * @param name - Component name to apply
 * @param engineDir - Firefox engine source directory
 * @param furnacePaths - Resolved Furnace workspace paths
 * @param config - Loaded Furnace configuration
 * @param isDryRun - Whether file writes should be skipped
 * @returns Apply result for the named component, or `stock` for stock-only entries
 */
async function applyNamedComponent(
  name: string,
  engineDir: string,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>,
  isDryRun: boolean
): Promise<Awaited<ReturnType<typeof applyAllComponents>> | 'stock'> {
  const rollbackJournal = isDryRun ? undefined : createRollbackJournal();
  const result: Awaited<ReturnType<typeof applyAllComponents>> = {
    applied: [],
    skipped: [],
    errors: [],
    actions: [],
  };

  const overrideConfig = config.overrides[name];
  const customConfig = config.custom[name];

  if (overrideConfig) {
    const componentDir = join(furnacePaths.overridesDir, name);
    if (!(await pathExists(componentDir))) {
      throw new FurnaceError(`Component directory not found: components/overrides/${name}`, name);
    }
    try {
      const { affectedPaths: filesAffected, actions } = await applyOverrideComponent(
        engineDir,
        name,
        componentDir,
        overrideConfig,
        isDryRun,
        rollbackJournal
      );
      if (isDryRun && actions) {
        result.actions = actions;
      }
      result.applied.push({ name, type: 'override', filesAffected });
    } catch (error: unknown) {
      result.errors.push({ name, error: toError(error).message });
    }

    if (!isDryRun && result.errors.length > 0 && rollbackJournal) {
      await restoreRollbackJournalOrThrow(rollbackJournal, `Furnace deploy failed for "${name}"`);
    }

    return result;
  }

  if (customConfig) {
    const componentDir = join(furnacePaths.customDir, name);
    if (!(await pathExists(componentDir))) {
      throw new FurnaceError(`Component directory not found: components/custom/${name}`, name);
    }
    try {
      const {
        affectedPaths: filesAffected,
        stepErrors,
        actions,
      } = await applyCustomComponent(
        engineDir,
        name,
        componentDir,
        customConfig,
        isDryRun,
        rollbackJournal
      );
      if (isDryRun && actions) {
        result.actions = actions;
      }
      result.applied.push({
        name,
        type: 'custom',
        filesAffected,
        ...(stepErrors.length > 0 ? { stepErrors } : {}),
      });
    } catch (error: unknown) {
      result.errors.push({ name, error: toError(error).message });
    }
    if (!isDryRun && getStepFailureCount(result) > 0 && rollbackJournal) {
      await restoreRollbackJournalOrThrow(rollbackJournal, `Furnace deploy failed for "${name}"`);
    }

    return result;
  }

  if (config.stock.includes(name)) {
    return 'stock';
  }

  throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
}

/**
 * Resolves the validation target for a single named component.
 * @param name - Component name to validate
 * @param config - Loaded Furnace configuration
 * @param furnacePaths - Resolved Furnace workspace paths
 * @returns Validation target details, or `stock` for stock-only entries
 */
function resolveNamedValidationTarget(
  name: string,
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>,
  furnacePaths: ReturnType<typeof getFurnacePaths>
): { type: ComponentType; componentDir: string } | 'stock' {
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

/**
 * Prints the deploy summary after apply and validation complete.
 * @param result - Aggregate apply result
 * @param totalErrors - Total validation errors encountered
 * @param totalWarnings - Total validation warnings encountered
 * @param componentCount - Number of components considered during deploy
 * @param skippedValidationCount - Number of components skipped from validation
 * @param isDryRun - Whether deploy was running in dry-run mode
 */
function printDeploymentSummary(
  result: Awaited<ReturnType<typeof applyAllComponents>>,
  totalErrors: number,
  totalWarnings: number,
  componentCount: number,
  skippedValidationCount: number,
  isDryRun: boolean
): void {
  const appliedCount = result.applied.length;
  const skippedCount = result.skipped.length;
  const applyErrors = result.errors.length + getStepFailureCount(result);
  const stepErrorCount = result.applied.reduce((sum, a) => sum + (a.stepErrors?.length ?? 0), 0);

  if (isDryRun) {
    note(
      `Would apply ${appliedCount} component(s)\n` +
        `${result.actions?.length ?? 0} planned action(s)\n` +
        `${applyErrors} apply error(s)\n` +
        `${totalErrors} validation error(s), ${totalWarnings} validation warning(s) across ${componentCount} validated component(s)` +
        (skippedValidationCount > 0
          ? `\nSkipped validation for ${skippedValidationCount} component(s) with apply errors`
          : ''),
      'Dry Run Summary'
    );
  } else {
    note(
      `Applied ${appliedCount}, skipped ${skippedCount}\n` +
        `${applyErrors} apply error(s)` +
        (stepErrorCount > 0 ? `, ${stepErrorCount} registration step error(s)` : '') +
        `\n` +
        `${totalErrors} validation error(s), ${totalWarnings} validation warning(s) across ${componentCount} validated component(s)` +
        (skippedValidationCount > 0
          ? `\nSkipped validation for ${skippedValidationCount} component(s) with apply errors`
          : ''),
      'Deploy Summary'
    );
  }

  const totalProblems = applyErrors + totalErrors;
  if (totalProblems > 0) {
    throw new FurnaceError(buildDeployFailureMessage(applyErrors, totalErrors, isDryRun));
  }

  outro(isDryRun ? 'Dry run complete (no files modified)' : 'Deploy complete');
}

function logApplyResult(
  result: Awaited<ReturnType<typeof applyAllComponents>>,
  isDryRun: boolean
): void {
  if (isDryRun && result.actions && result.actions.length > 0) {
    info('Planned actions:');
    for (const action of result.actions) {
      info(`  [${action.action}] ${action.component}: ${action.description}`);
    }
  } else if (isDryRun) {
    info('No actions would be performed.');
  } else {
    for (const applied of result.applied) {
      success(`${applied.name} (${applied.type}) → ${applied.filesAffected.length} files`);
    }

    for (const skipped of result.skipped) {
      info(`${skipped.name} — ${skipped.reason}`);
    }

    for (const applied of result.applied) {
      if (applied.stepErrors && applied.stepErrors.length > 0) {
        for (const stepErr of applied.stepErrors) {
          warn(`${applied.name}: [${stepErr.step}] ${stepErr.error}`);
        }
      }
    }
  }

  for (const err of result.errors) {
    error(`${err.name} — ${err.error}`);
  }
}

/**
 * Runs the furnace deploy command: apply components then validate in one step.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name to deploy (deploys all if omitted)
 * @param options - Command options
 */
export async function furnaceDeployCommand(
  projectRoot: string,
  name?: string,
  options: FurnaceDeployOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun ?? false;

  intro(isDryRun ? 'Furnace Deploy (dry run)' : 'Furnace Deploy');

  // Verify engine exists
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  // Load furnace config
  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'No furnace.json found. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  const config = await loadFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);

  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;

  if (overrideCount === 0 && customCount === 0) {
    info('No components to deploy.');
    outro('Done');
    return;
  }

  // --- Step 1: Apply ---
  const applySpinner = spinner(
    isDryRun ? 'Calculating planned actions...' : 'Applying components to engine...'
  );

  let result: Awaited<ReturnType<typeof applyAllComponents>>;

  if (name) {
    const namedApplyResult = await applyNamedComponent(
      name,
      paths.engine,
      furnacePaths,
      config,
      isDryRun
    );

    if (namedApplyResult === 'stock') {
      applySpinner.stop('Apply skipped');
      info(`"${name}" is a stock component. Stock components are not applied locally.`);
      outro(isDryRun ? 'Dry run complete (no files modified)' : 'Deploy complete');
      return;
    }

    result = namedApplyResult;

    // Persist Furnace state for the deployed component so status/change
    // detection stays accurate after single-component deploys.
    if (
      !isDryRun &&
      result.errors.length === 0 &&
      getStepFailureCount(result) === 0 &&
      result.applied.length > 0
    ) {
      const applied = result.applied[0] as (typeof result.applied)[number];
      await persistSingleComponentState(projectRoot, applied, furnacePaths);
    }
  } else {
    result = await applyAllComponents(projectRoot, isDryRun);
  }

  applySpinner.stop(isDryRun ? 'Planned actions calculated' : 'Components applied');

  logApplyResult(result, isDryRun);

  // --- Step 2: Validate (read-only, runs even in dry-run) ---
  const validateSpinner = spinner('Validating components...');
  const failedComponents = getFailedComponentNames(result);

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
      return;
    }

    if (!(await pathExists(target.componentDir))) {
      validateSpinner.stop('Validation failed');
      throw new FurnaceError(`Component directory not found for "${name}".`, name);
    }

    const issues = await validateComponent(
      target.componentDir,
      name,
      target.type,
      config,
      projectRoot
    );
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
    // Validate all components
    const results = await validateAllComponents(projectRoot);

    validateSpinner.stop('Validation complete');

    for (const [componentName, issues] of results) {
      if (failedComponents.has(componentName)) {
        skippedValidationCount++;
        continue;
      }

      componentCount++;
      if (issues.length === 0) {
        success(`${componentName} — all checks passed`);
      } else {
        const [errors, warnings] = displayValidationIssues(issues);
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

  // --- Step 3: Summary ---
  printDeploymentSummary(
    result,
    totalErrors,
    totalWarnings,
    componentCount,
    skippedValidationCount,
    isDryRun
  );
}
