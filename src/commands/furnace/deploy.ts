// SPDX-License-Identifier: EUPL-1.2
import { loadConfig } from '../../core/config.js';
import { applyAllComponents, type ApplyAllComponentsResult } from '../../core/furnace-apply.js';
import { formatSkipBreakdown, logApplyResult } from '../../core/furnace-apply-output.js';
import { getFurnacePaths } from '../../core/furnace-config.js';
import { assertDeployOverwritesOwnedBy } from '../../core/furnace-deploy-owner.js';
import { reportJsconfigPathsSync } from '../../core/furnace-jsconfig.js';
import { runFurnaceMutation, waitLockMutationOptions } from '../../core/furnace-operation.js';
import { assertFurnaceReady } from '../../core/furnace-precondition.js';
import { getStepFailureCount } from '../../core/furnace-state-persist.js';
import { hasBlockingStepErrors } from '../../core/furnace-step-errors.js';
import type { OverrideVersionDrift } from '../../core/furnace-version-drift.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftError,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceDeployOptions } from '../../types/commands/index.js';
import { info, intro, note, notice, outro, spinner, warn } from '../../utils/logger.js';
import { formatFragmentIncluderNotice } from './deploy-fragment-includers.js';
import { deployNamedComponents, type NamedDeployOutcome } from './deploy-named.js';
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
      `Applied ${appliedCount}, skipped ${skippedCount}${formatSkipBreakdown(result.skipped)}\n` +
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
  scopedDrift: OverrideVersionDrift[],
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
 * Normalises the positional argument: a single name (programmatic callers)
 * or the variadic list commander passes. An empty list means "deploy all".
 */
function normalizeDeployNames(names: string | readonly string[] | undefined): string[] {
  if (names === undefined) return [];
  return typeof names === 'string' ? [names] : [...names];
}

/**
 * Runs the furnace deploy command: apply components then validate in one step.
 * @param projectRoot - Root directory of the project
 * @param names - Component name(s) to deploy, all under one lock hold
 *   (deploys all when omitted or empty)
 * @param options - Command options
 */
export async function furnaceDeployCommand(
  projectRoot: string,
  names?: string | readonly string[],
  options: FurnaceDeployOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun ?? false;
  const requested = normalizeDeployNames(names);

  intro(isDryRun ? 'Furnace Deploy (dry run)' : 'Furnace Deploy');

  const { config } = await assertFurnaceReady(projectRoot);
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
  const scopedDrift =
    requested.length > 0
      ? driftEntries.filter((entry) => requested.includes(entry.name))
      : driftEntries;
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
    ): Promise<NamedDeployOutcome | { kind: 'all'; result: ApplyAllComponentsResult }> => {
      // Judged under the lock, before the first component is applied, so
      // a refusal leaves every component of the deploy unwritten.
      if (options.owner !== undefined) {
        await assertDeployOverwritesOwnedBy({
          root: projectRoot,
          config,
          names: requested,
          owner: options.owner,
        });
      }
      if (requested.length > 0) {
        return deployNamedComponents({
          projectRoot,
          names: requested,
          config,
          furnacePaths,
          isDryRun,
          operationContext: ctx,
        });
      }
      const allResult = await applyAllComponents(projectRoot, isDryRun, {
        operationContext: ctx,
      });
      return { kind: 'all', result: allResult };
    },
    { dryRun: isDryRun, ...waitLockMutationOptions(options.waitLockSeconds) }
  );

  const warnStock = (): void => {
    for (const stockName of applyOutcome.kind === 'all' ? [] : applyOutcome.stock) {
      warn(`"${stockName}" is a stock component. Stock components are not applied locally.`);
    }
  };
  if (applyOutcome.kind === 'stock') {
    applySpinner.stop('Apply skipped');
    warnStock();
    outro(isDryRun ? 'Dry run complete (no files modified)' : 'Deploy complete');
    return;
  }

  const result = applyOutcome.result;

  applySpinner.stop(isDryRun ? 'Planned actions calculated' : 'Components applied');
  warnStock();

  logApplyResult(result, isDryRun);
  if (applyOutcome.kind === 'result') {
    for (const line of formatFragmentIncluderNotice(applyOutcome.includers, isDryRun)) {
      notice(line);
    }
  }

  // Keep the consumer jsconfig's chrome-module `paths` in step with the
  // deployed module set. Only after a clean apply: a rolled-back deploy
  // must not advance the typecheck mapping either.
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
  // A named deploy validates every named component that applied, then the
  // includers it refreshed. The first clean name leads (the validation
  // runner skips the whole named branch when its lead failed), and every
  // failed name is counted as skipped.
  const deployed = applyOutcome.kind === 'result' ? applyOutcome.deployed : [];
  const failedNamed = deployed.filter((tag) => failedComponents.has(tag));
  const lead = deployed.find((tag) => !failedComponents.has(tag)) ?? deployed[0];
  const validation = await runDeployValidation({
    validateSpinner,
    name: lead,
    config,
    furnacePaths,
    failedComponents,
    isDryRun,
    projectRoot,
    dryRunActions: result.actions,
    alsoValidate:
      applyOutcome.kind === 'result'
        ? [...deployed.filter((tag) => tag !== lead), ...applyOutcome.includers.refreshed]
        : [],
  });
  if (validation.done) return;
  const { totalErrors, totalWarnings, componentCount } = validation;
  // The runner counts a failed lead itself; failed extras it drops silently.
  const skippedValidationCount =
    lead !== undefined && failedComponents.has(lead)
      ? failedNamed.length
      : validation.skippedValidationCount + failedNamed.length;

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
