// SPDX-License-Identifier: EUPL-1.2
import { getProjectPaths, loadConfig } from '../../core/config.js';
import { applyAllComponents, type ApplyAllComponentsResult } from '../../core/furnace-apply.js';
import { logApplyResult } from '../../core/furnace-apply-output.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
} from '../../core/furnace-config.js';
import { reportJsconfigPathsSync } from '../../core/furnace-jsconfig.js';
import { type FurnaceOperationContext, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  getPersistableAppliedEntry,
  getStepFailureCount,
  persistSingleComponentState,
  shouldPersistSingleComponentState,
} from '../../core/furnace-state-persist.js';
import { hasBlockingStepErrors } from '../../core/furnace-step-errors.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftError,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceDeployOptions } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, spinner, warn } from '../../utils/logger.js';
import { runDeployValidation } from './validation-output.js';

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

function getFailedComponentNames(result: ApplyAllComponentsResult): Set<string> {
  const failed = new Set(result.errors.map((entry) => entry.name));

  for (const applied of result.applied) {
    if (hasBlockingStepErrors(applied)) {
      failed.add(applied.name);
    }
  }

  return failed;
}

/**
 * Applies a single named override or custom component in targeted deploy mode.
 *
 * Delegates to {@link applyAllComponents} with a `componentName` filter so
 * targeted deploys run the exact same pipeline as deploy-all — including
 * workspace-deletion detection, engine orphan undeploy, and jar.mn /
 * customElements.js re-sync. The previous implementation called the
 * per-component apply helpers directly and never pruned: renaming a helper
 * file in the workspace left the old deployed file and its stale jar.mn
 * line in the engine (field report D1).
 *
 * `persistState: false` is load-bearing: the batch persist path *replaces*
 * `appliedChecksums` wholesale with only this run's entries, which for a
 * named deploy would wipe every other component's state. Named deploy keeps
 * its per-component state merge ({@link persistSingleComponentState}) and
 * its atomicity gate ({@link shouldPersistNamedDeployState}) at the call
 * site. Rollback on failure happens inside `applyAllComponents`; the
 * journal returned on success is ignored (the deploy keeps its files).
 *
 * @param name - Component name to apply
 * @param config - Loaded Furnace configuration
 * @param isDryRun - Whether file writes should be skipped
 * @returns Apply result for the named component, or `stock` for stock-only entries
 */
async function applyNamedComponent(
  name: string,
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>,
  isDryRun: boolean,
  projectRoot: string,
  operationContext?: FurnaceOperationContext
): Promise<ApplyAllComponentsResult | 'stock'> {
  if (!(name in config.overrides) && !(name in config.custom)) {
    if (config.stock.includes(name)) {
      return 'stock';
    }
    throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
  }

  return applyAllComponents(projectRoot, isDryRun, {
    componentName: name,
    persistState: false,
    ...(operationContext ? { operationContext } : {}),
  });
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
  result: ApplyAllComponentsResult,
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
        `${totalErrors} validation error(s), ${totalWarnings} validation warning(s) across ${componentCount} validated component(s)\n` +
        '(validation ran against current source files — no engine files were modified)' +
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

function enforceScopedOverrideVersionDriftPreflight(
  scopedDrift: ReturnType<typeof findOverrideBaseVersionDrift>,
  force: boolean
): void {
  for (const entry of scopedDrift) {
    warn(formatOverrideBaseVersionDriftWarning(entry));
  }

  if (!force && scopedDrift.length > 0) {
    throw new FurnaceError(formatOverrideBaseVersionDriftError(scopedDrift));
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

  // Refuse real mutation when the targeted overrides were created against a
  // different Firefox version. Dry-run still proceeds so operators can inspect
  // the plan before deciding whether to refresh the override or acknowledge
  // the new baseline in furnace.json.
  const forgeConfig = await loadConfig(projectRoot);
  const driftEntries = findOverrideBaseVersionDrift(config, forgeConfig.firefox.version);
  const force = options.force ?? false;
  const scopedDrift = name ? driftEntries.filter((entry) => entry.name === name) : driftEntries;
  enforceScopedOverrideVersionDriftPreflight(scopedDrift, force);

  // --- Step 1: Apply ---
  const applySpinner = spinner(
    isDryRun ? 'Calculating planned actions...' : 'Applying components to engine...'
  );

  // The apply phase is lock-protected and registered with the global
  // SIGINT/SIGTERM rollback pathway via runFurnaceMutation. The validation
  // phase below is read-only and runs outside the lock so two concurrent
  // `furnace deploy` runs only contend on the actual mutation.
  const applyOutcome = await runFurnaceMutation(
    projectRoot,
    'deploy-rollback',
    async (
      ctx
    ): Promise<{ kind: 'stock' } | { kind: 'result'; result: ApplyAllComponentsResult }> => {
      if (name) {
        const namedApplyResult = await applyNamedComponent(
          name,
          config,
          isDryRun,
          projectRoot,
          ctx
        );

        if (namedApplyResult === 'stock') {
          return { kind: 'stock' };
        }

        // Named deploy is atomic: state is persisted only when every apply
        // step succeeded. Any rollback triggered by applyNamedComponent has
        // already restored the engine to its pre-deploy state, so persisting
        // partial checksums here would mis-report the next status/apply run
        // against a workspace that was never actually deployed.
        if (shouldPersistSingleComponentState(namedApplyResult, isDryRun)) {
          await persistSingleComponentState(
            projectRoot,
            getPersistableAppliedEntry('Deploy', name, namedApplyResult.applied[0]),
            furnacePaths
          );
        }

        return { kind: 'result', result: namedApplyResult };
      }

      const allResult = await applyAllComponents(projectRoot, isDryRun, {
        operationContext: ctx,
      });
      return { kind: 'result', result: allResult };
    },
    { dryRun: isDryRun }
  );

  if (applyOutcome.kind === 'stock') {
    applySpinner.stop('Apply skipped');
    warn(`"${name}" is a stock component. Stock components are not applied locally.`);
    outro(isDryRun ? 'Dry run complete (no files modified)' : 'Deploy complete');
    return;
  }

  const result = applyOutcome.result;

  applySpinner.stop(isDryRun ? 'Planned actions calculated' : 'Components applied');

  logApplyResult(result, isDryRun);

  // Keep the consumer jsconfig's chrome-module `paths` in step with the
  // deployed module set (field report D3). Only after a clean apply —
  // a rolled-back deploy must not advance the typecheck mapping either.
  if (result.errors.length === 0 && getStepFailureCount(result) === 0) {
    await reportJsconfigPathsSync(projectRoot, config, isDryRun);
  }

  // --- Step 2: Validate (read-only, runs even in dry-run to show what would fail) ---
  if (options.skipValidate) {
    const applyErrors = result.errors.length + getStepFailureCount(result);
    if (applyErrors > 0)
      throw new FurnaceError(buildDeployFailureMessage(applyErrors, 0, isDryRun));
    outro(
      isDryRun ? 'Dry run complete (validation skipped)' : 'Deploy complete (validation skipped)'
    );
    return;
  }

  const validateSpinner = spinner(isDryRun ? 'Validating (read-only)...' : 'Validating...');
  const failedComponents = getFailedComponentNames(result);
  const validation = await runDeployValidation(
    validateSpinner,
    name,
    config,
    furnacePaths,
    failedComponents,
    isDryRun,
    projectRoot,
    result.actions
  );
  if (validation.done) return;
  const { totalErrors, totalWarnings, componentCount, skippedValidationCount } = validation;

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
