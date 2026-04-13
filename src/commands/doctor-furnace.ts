// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { applyAllComponents } from '../core/furnace-apply.js';
import { hasCustomEngineDrift, hasOverrideEngineDrift } from '../core/furnace-apply-helpers.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
} from '../core/furnace-config.js';
import { CUSTOM_ELEMENTS_JS, JAR_MN, resolveFtlDir } from '../core/furnace-constants.js';
import { runFurnaceMutation } from '../core/furnace-operation.js';
import { validateAllComponents } from '../core/furnace-validate.js';
import type {
  ApplyResult,
  FurnaceConfig,
  FurnacePendingRepairOperation,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import type { CheckResult, DoctorCheckDefinition } from './doctor.js';
import { failure, ok, warning } from './doctor.js';

const ENGINE_REPAIRABLE_OPERATIONS: readonly FurnacePendingRepairOperation[] = [
  'preview-teardown',
  'apply-rollback',
  'deploy-rollback',
  'remove-rollback',
];

function isEngineRepairableOperation(operation: FurnacePendingRepairOperation): boolean {
  return ENGINE_REPAIRABLE_OPERATIONS.includes(operation);
}

async function runRepairApply(projectRoot: string): Promise<ApplyResult> {
  return runFurnaceMutation(
    projectRoot,
    'apply-rollback',
    (ctx) => applyAllComponents(projectRoot, false, { operationContext: ctx }),
    { skipPendingRepairCheck: true }
  );
}

function countApplyFailures(applyResult: ApplyResult): number {
  const appliedWithStepErrors = applyResult.applied.filter(
    (entry) => (entry.stepErrors?.length ?? 0) > 0
  ).length;
  return applyResult.errors.length + appliedWithStepErrors;
}

function firstApplyFailure(applyResult: ApplyResult): string {
  return (
    applyResult.errors[0]?.error ??
    applyResult.applied
      .flatMap((entry) => entry.stepErrors ?? [])
      .map((step) => `${step.step}: ${step.error}`)[0] ??
    'unknown error'
  );
}

async function clearPendingRepairMarker(projectRoot: string): Promise<void> {
  await updateFurnaceState(projectRoot, (current) => {
    const next = { ...current };
    delete next.pendingRepair;
    return next;
  });
}

/**
 * Returns the subset of state-file checksum keys whose `type/name` prefix
 * does not match any component in `furnace.json`. Keys are structured as
 * `<type>/<name>/<file>` where type is one of `override`, `custom`, or
 * `stock` and name is the tag name.
 *
 * Stock components are never checksummed by apply, so they never appear
 * in the state file — any stock-prefixed entry is automatically stale.
 */
function collectStaleChecksumKeys(
  appliedChecksums: Record<string, string>,
  config: FurnaceConfig
): string[] {
  const stale: string[] = [];
  for (const key of Object.keys(appliedChecksums)) {
    const segments = key.split('/');
    if (segments.length < 2) {
      stale.push(key);
      continue;
    }
    const type = segments[0];
    const name = segments[1];
    if (type === undefined || name === undefined) {
      stale.push(key);
      continue;
    }
    if (type === 'override' && !(name in config.overrides)) {
      stale.push(key);
    } else if (type === 'custom' && !(name in config.custom)) {
      stale.push(key);
    } else if (type !== 'override' && type !== 'custom') {
      stale.push(key);
    }
  }
  return stale;
}

/**
 * Walks every override and custom component in the furnace config and asks
 * the drift oracles whether the engine still reflects the workspace source.
 * Returns the flat list of drifted component names so the doctor check can
 * decide whether a repair is needed.
 *
 * Components whose workspace directory is missing are treated as drifted:
 * the only consistent recovery is a re-run of apply which will surface the
 * missing-directory error through its own failure path.
 */
async function collectFurnaceDrift(
  projectRoot: string,
  engineDir: string,
  config: FurnaceConfig,
  ftlDir: string
): Promise<{ drifted: string[] }> {
  const drifted: string[] = [];
  const furnacePaths = getFurnacePaths(projectRoot);

  for (const [name, overrideConfig] of Object.entries(config.overrides)) {
    const componentDir = join(furnacePaths.overridesDir, name);
    if (!(await pathExists(componentDir))) {
      drifted.push(name);
      continue;
    }
    try {
      if (await hasOverrideEngineDrift(engineDir, componentDir, overrideConfig, ftlDir)) {
        drifted.push(name);
      }
    } catch {
      // Drift check throws on unreadable paths; treat as drift so the
      // operator is told to run apply rather than swallowing the error.
      drifted.push(name);
    }
  }

  for (const [name, customConfig] of Object.entries(config.custom)) {
    const componentDir = join(furnacePaths.customDir, name);
    if (!(await pathExists(componentDir))) {
      drifted.push(name);
      continue;
    }
    try {
      if (await hasCustomEngineDrift(projectRoot, name, componentDir, customConfig, ftlDir)) {
        drifted.push(name);
      }
    } catch {
      drifted.push(name);
    }
  }

  return { drifted };
}

/**
 * "Furnace configuration" check: load and parse `furnace.json`. Populates
 * `ctx.furnaceConfig` for the downstream furnace checks so they do not
 * re-parse the file.
 */
const furnaceConfigurationCheck: DoctorCheckDefinition = {
  name: 'Furnace configuration',
  // Silently skip when the project is not using furnace. Plenty of
  // projects are patch-only, and flagging the absence of furnace.json
  // would make `doctor` warn on every such project.
  skipIf: (ctx) => !ctx.furnaceConfigExists,
  run: async (ctx) => {
    try {
      ctx.furnaceConfig = await loadFurnaceConfig(ctx.projectRoot);
      return ok('Furnace configuration');
    } catch (err: unknown) {
      return failure(
        'Furnace configuration',
        `furnace.json is invalid: ${toError(err).message}`,
        'Fix the errors reported above in furnace.json and re-run "fireforge doctor".'
      );
    }
  },
};

/**
 * "Furnace state consistency" check: detect checksums keyed by components
 * that are no longer in `furnace.json`. Repair clears the stale entries.
 */
const furnaceStateConsistencyCheck: DoctorCheckDefinition = {
  name: 'Furnace state consistency',
  dependsOn: ['Furnace configuration'],
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig,
  run: async (ctx) => {
    const config = ctx.furnaceConfig;
    if (!config) {
      return [];
    }

    const state = await loadFurnaceState(ctx.projectRoot);
    if (!state.appliedChecksums && !state.engineChecksums) {
      return ok('Furnace state consistency');
    }

    // A "stale" entry is a checksum keyed by a component that is no
    // longer in furnace.json. These are harmless but misleading: status
    // and drift oracles read state independently and a stale entry
    // shows up as a ghost component in their reports.
    const staleApplied = state.appliedChecksums
      ? collectStaleChecksumKeys(state.appliedChecksums, config)
      : [];
    const staleEngine = state.engineChecksums
      ? collectStaleChecksumKeys(state.engineChecksums, config)
      : [];
    const staleKeys = [...new Set([...staleApplied, ...staleEngine])];
    if (staleKeys.length === 0) {
      return ok('Furnace state consistency');
    }

    const ghostSet = new Set<string>();
    for (const key of staleKeys) {
      // Keys look like "override/<name>/<file>" — the ghost component is
      // the first two segments joined for display purposes.
      const segments = key.split('/');
      if (segments.length >= 2) {
        ghostSet.add(`${segments[0]}/${segments[1]}`);
      }
    }
    const ghostList = [...ghostSet].sort();
    const message = `.fireforge/furnace-state.json records ${staleKeys.length} checksum entr${staleKeys.length === 1 ? 'y' : 'ies'} for component${ghostList.length === 1 ? '' : 's'} no longer in furnace.json (${ghostList.join(', ')}).`;

    if (!ctx.options.repairFurnace) {
      return warning(
        'Furnace state consistency',
        message,
        'Run "fireforge doctor --repair-furnace" to clear the stale entries.'
      );
    }

    try {
      await updateFurnaceState(ctx.projectRoot, (current) => {
        const result = { ...current };
        if (current.appliedChecksums) {
          result.appliedChecksums = Object.fromEntries(
            Object.entries(current.appliedChecksums).filter(([key]) => !staleKeys.includes(key))
          );
        }
        if (current.engineChecksums) {
          result.engineChecksums = Object.fromEntries(
            Object.entries(current.engineChecksums).filter(([key]) => !staleKeys.includes(key))
          );
        }
        return result;
      });
      return warning(
        'Furnace state consistency',
        `Cleared ${staleKeys.length} stale checksum entr${staleKeys.length === 1 ? 'y' : 'ies'} from .fireforge/furnace-state.json (${ghostList.join(', ')}).`
      );
    } catch (err: unknown) {
      return failure(
        'Furnace state consistency',
        `Could not clear stale furnace-state.json entries: ${toError(err).message}`,
        'Fix the underlying file I/O issue and retry the doctor command.'
      );
    }
  },
};

/**
 * "Furnace engine state" check: detect the `pendingRepair` marker set by
 * a failed preview teardown AND any on-disk drift between the workspace
 * and the engine. Repair runs `applyAllComponents` to reconcile and
 * clears the marker on success.
 */
const furnaceEngineStateCheck: DoctorCheckDefinition = {
  name: 'Furnace engine state',
  dependsOn: ['Furnace configuration'],
  // Requires both a furnace project AND an engine checkout — the drift
  // oracles resolve engine paths, so a missing engine dir would throw.
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig || !ctx.engineExists,
  run: async (ctx) => {
    const config = ctx.furnaceConfig;
    if (!config) {
      return [];
    }

    const state = await loadFurnaceState(ctx.projectRoot);
    const pendingRepair = state.pendingRepair;

    // Drift check: walks every override and custom component and asks
    // the same oracle apply's skip logic uses. A drifted component means
    // the engine no longer reflects what the state file claims was
    // deployed, so an apply is needed to reconcile.
    const driftReport = await collectFurnaceDrift(
      ctx.projectRoot,
      ctx.paths.engine,
      config,
      resolveFtlDir(config.ftlBasePath)
    );
    const driftedNames = driftReport.drifted;

    if (!pendingRepair && driftedNames.length === 0) {
      return ok('Furnace engine state');
    }

    const pendingMessage = pendingRepair
      ? `Pending repair marker set by ${pendingRepair.operation} at ${pendingRepair.timestamp}: ${pendingRepair.reason}.`
      : '';
    const driftMessage =
      driftedNames.length > 0
        ? `Engine is drifted for ${driftedNames.length} component${driftedNames.length === 1 ? '' : 's'} (${driftedNames.join(', ')}).`
        : '';
    const message = [pendingMessage, driftMessage].filter(Boolean).join(' ');

    if (!ctx.options.repairFurnace) {
      const guidance =
        pendingRepair && !isEngineRepairableOperation(pendingRepair.operation)
          ? 'Resolve or remove the partial component authoring changes, then run "fireforge doctor --repair-furnace" to re-validate and clear the repair marker.'
          : 'Run "fireforge doctor --repair-furnace" to re-run furnace apply and reconcile the engine.';
      return failure('Furnace engine state', message, guidance);
    }

    if (pendingRepair && !isEngineRepairableOperation(pendingRepair.operation)) {
      try {
        const validationResults = await validateAllComponents(ctx.projectRoot);
        const validationIssues = [...validationResults.values()].flat();
        const validationErrors = validationIssues.filter((issue) => issue.severity === 'error');
        const validationWarnings = validationIssues.filter(
          (issue) => issue.severity === 'warning'
        ).length;

        if (validationErrors.length > 0) {
          const firstError = validationErrors[0];
          const firstMessage = firstError
            ? `${firstError.component} [${firstError.check}] ${firstError.message}`
            : 'unknown validation error';
          return failure(
            'Furnace engine state',
            `Authoring rollback marker from ${pendingRepair.operation} is still unresolved: validation found ${validationErrors.length} error(s) (first: ${firstMessage}).`,
            'Inspect furnace.json and the affected component files, finish or remove the partial authoring change, then retry "fireforge doctor --repair-furnace".'
          );
        }

        let applyResult: ApplyResult | null = null;
        if (driftedNames.length > 0) {
          applyResult = await runRepairApply(ctx.projectRoot);
          const totalFailures = countApplyFailures(applyResult);
          if (totalFailures > 0) {
            return failure(
              'Furnace engine state',
              `Repair attempted after ${pendingRepair.operation}, but apply reported ${totalFailures} failure${totalFailures === 1 ? '' : 's'} (first: ${firstApplyFailure(applyResult)}).`,
              'Fix the underlying component issue, or remove the partial authoring change, and retry the doctor command.'
            );
          }
        }

        await clearPendingRepairMarker(ctx.projectRoot);

        const summary =
          driftedNames.length > 0 && applyResult
            ? `Reconciled engine drift after ${pendingRepair.operation} (${applyResult.applied.length} applied, ${applyResult.skipped.length} skipped) and cleared the repair marker.`
            : `Cleared the ${pendingRepair.operation} repair marker after validation passed${validationWarnings > 0 ? ` (${validationWarnings} warning${validationWarnings === 1 ? '' : 's'} remain)` : ''}.`;
        return warning('Furnace engine state', summary);
      } catch (err: unknown) {
        return failure(
          'Furnace engine state',
          `Repair failed: ${toError(err).message}`,
          'Inspect the error above, fix the partial authoring state, and retry the doctor command.'
        );
      }
    }

    // Repair path: run apply to reconcile the engine with the workspace
    // state, then clear the pendingRepair marker on success. We re-run
    // apply even when only the marker is set — the marker exists
    // specifically because the last mutation could not clean up, so the
    // cheapest honest thing we can do is re-reconcile end-to-end.
    try {
      const applyResult = await runRepairApply(ctx.projectRoot);
      const totalFailures = countApplyFailures(applyResult);

      if (totalFailures > 0) {
        return failure(
          'Furnace engine state',
          `Repair attempted but apply reported ${totalFailures} failure${totalFailures === 1 ? '' : 's'} (first: ${firstApplyFailure(applyResult)}).`,
          'Fix the underlying component issue and retry the doctor command.'
        );
      }

      // Apply succeeded — clear the pendingRepair marker so subsequent
      // doctor runs stop reporting the issue. updateFurnaceState merges
      // its return value via `validateFurnaceState` which simply writes
      // whatever object we return, so dropping the key from the spread
      // copy is enough to persist the cleared marker.
      if (pendingRepair) {
        await clearPendingRepairMarker(ctx.projectRoot);
      }

      const summary =
        driftedNames.length > 0
          ? `Reconciled ${applyResult.applied.length} component${applyResult.applied.length === 1 ? '' : 's'} (${driftedNames.join(', ')} re-applied).`
          : `Reconciled via furnace apply (${applyResult.applied.length} applied, ${applyResult.skipped.length} skipped).`;
      return warning('Furnace engine state', summary);
    } catch (err: unknown) {
      return failure(
        'Furnace engine state',
        `Repair failed: ${toError(err).message}`,
        'Inspect the error above, fix the underlying issue, and retry the doctor command.'
      );
    }
  },
};

/**
 * Furnace operations read from a handful of Firefox-internal paths that are
 * hardcoded in `furnace-constants.ts` and `furnace-scanner.ts`. If upstream
 * renames or restructures any of them, furnace will silently fail instead
 * of diagnosing the change. This check verifies each expected path exists
 * so the operator gets a targeted "this path moved" message rather than a
 * confusing downstream error.
 */
const furnaceEnginePathsCheck: DoctorCheckDefinition = {
  name: 'Furnace engine paths',
  dependsOn: ['Furnace configuration'],
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig || !ctx.engineExists,
  run: async (ctx): Promise<CheckResult> => {
    const expectedPaths: readonly string[] = [
      CUSTOM_ELEMENTS_JS,
      JAR_MN,
      'toolkit/content/widgets',
      resolveFtlDir(ctx.furnaceConfig?.ftlBasePath),
      'browser/base/content/browser.xhtml',
    ];
    const missing: string[] = [];
    for (const relative of expectedPaths) {
      const absolute = join(ctx.paths.engine, relative);
      if (!(await pathExists(absolute))) {
        missing.push(relative);
      }
    }

    if (missing.length === 0) {
      return ok('Furnace engine paths');
    }

    return warning(
      'Furnace engine paths',
      `${missing.length} expected engine path${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}. Firefox may have restructured its source tree — furnace operations that depend on these paths will fail.`,
      'Re-run "fireforge download" to update the engine. If the paths have genuinely moved, file an issue so Furnace can be updated.'
    );
  },
};

/**
 * Furnace Storybook backend check: verifies that the engine contains the
 * Storybook workspace required by `furnace preview`. Missing Storybook
 * support is a warning, not a failure, since furnace works fine without
 * preview — but operators should know upfront rather than discovering it
 * mid-command.
 */
const furnaceStorybookCheck: DoctorCheckDefinition = {
  name: 'Furnace Storybook backend',
  dependsOn: ['Furnace configuration'],
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig || !ctx.engineExists,
  run: async (ctx): Promise<CheckResult> => {
    const storybookRoot = join(ctx.paths.engine, 'browser', 'components', 'storybook');
    if (await pathExists(storybookRoot)) {
      return ok('Furnace Storybook backend');
    }

    return warning(
      'Furnace Storybook backend',
      'browser/components/storybook not found in the engine. "fireforge furnace preview" will not work.',
      'Re-run "fireforge download" to get a complete engine checkout. If you do not need Storybook preview, this warning can be ignored.'
    );
  },
};

/**
 * "Furnace component validation" check: runs the full validation suite
 * across all override and custom components. Surfaces structural,
 * accessibility, compatibility, and registration issues that would
 * otherwise go unnoticed until `furnace validate` is run explicitly.
 */
const furnaceComponentValidationCheck: DoctorCheckDefinition = {
  name: 'Furnace component validation',
  dependsOn: ['Furnace configuration'],
  // Requires a furnace project, a valid config, and an engine checkout.
  // Skip when there are no override/custom components to validate.
  skipIf: (ctx) => {
    if (!ctx.furnaceConfigExists || !ctx.furnaceConfig || !ctx.engineExists) return true;
    const config = ctx.furnaceConfig;
    return Object.keys(config.overrides).length === 0 && Object.keys(config.custom).length === 0;
  },
  run: async (ctx) => {
    const config = ctx.furnaceConfig;
    if (!config) {
      return [];
    }

    try {
      const results = await validateAllComponents(ctx.projectRoot);
      const allIssues = [...results.values()].flat();
      const errors = allIssues.filter((issue) => issue.severity === 'error');
      const warnings = allIssues.filter((issue) => issue.severity === 'warning');

      if (errors.length === 0 && warnings.length === 0) {
        return ok('Furnace component validation');
      }

      const summary =
        `${errors.length} error${errors.length === 1 ? '' : 's'}, ` +
        `${warnings.length} warning${warnings.length === 1 ? '' : 's'} ` +
        `across ${results.size} component${results.size === 1 ? '' : 's'}`;

      if (errors.length > 0) {
        const first = errors[0];
        const detail = first
          ? ` (first: ${first.component} [${first.check}] ${first.message})`
          : '';
        return failure(
          'Furnace component validation',
          `${summary}${detail}`,
          'Run "fireforge furnace validate" for the full report, then fix the errors.'
        );
      }

      return warning(
        'Furnace component validation',
        summary,
        'Run "fireforge furnace validate" for details.'
      );
    } catch (err: unknown) {
      return failure(
        'Furnace component validation',
        `Validation failed: ${toError(err).message}`,
        'Run "fireforge furnace validate" directly to diagnose.'
      );
    }
  },
};

/**
 * The ordered furnace check group. Exported as an array so `doctor.ts`
 * can splice it into the main registry at the right position. The order
 * here matters: `Furnace configuration` must run before the consumers
 * that read `ctx.furnaceConfig`.
 */
export const FURNACE_DOCTOR_CHECKS: readonly DoctorCheckDefinition[] = [
  furnaceConfigurationCheck,
  furnaceStateConsistencyCheck,
  furnaceEnginePathsCheck,
  furnaceStorybookCheck,
  furnaceEngineStateCheck,
  furnaceComponentValidationCheck,
];
