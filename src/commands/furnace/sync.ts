// SPDX-License-Identifier: EUPL-1.2
import { getProjectPaths, loadConfig } from '../../core/config.js';
import { applyAllComponents } from '../../core/furnace-apply.js';
import { logApplyResult } from '../../core/furnace-apply-output.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { reportJsconfigPathsSync } from '../../core/furnace-jsconfig.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceSyncOptions } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, spinner, warn } from '../../utils/logger.js';
import { furnaceRefreshCommand } from './refresh.js';

/**
 * Runs the furnace sync command: detects overrides with baseVersion drift,
 * refreshes them (three-way merge), and re-applies all components.
 *
 * This is the recommended single command to run after `fireforge download`
 * updates the Firefox source.
 *
 * @param projectRoot - Root directory of the project
 * @param options - Sync options
 */
export async function furnaceSyncCommand(
  projectRoot: string,
  options: FurnaceSyncOptions = {}
): Promise<void> {
  intro('Furnace Sync');

  // Pre-flight checks
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'No furnace.json found. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  const config = await loadFurnaceConfig(projectRoot);
  const forgeConfig = await loadConfig(projectRoot);

  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;

  if (overrideCount === 0 && customCount === 0) {
    info('No components to sync.');
    outro('Done');
    return;
  }

  // Phase 1: Detect and report baseVersion drift
  const driftEntries = findOverrideBaseVersionDrift(config, forgeConfig.firefox.version);
  if (driftEntries.length > 0) {
    info(`Found ${driftEntries.length} override(s) with baseVersion drift:`);
    for (const entry of driftEntries) {
      warn(formatOverrideBaseVersionDriftWarning(entry));
    }

    // Phase 2: Refresh drifted overrides via three-way merge
    info('\nRefreshing drifted overrides...');
    await furnaceRefreshCommand(projectRoot, undefined, {
      all: true,
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
    });
  } else {
    info('All overrides are up-to-date with the current Firefox version.');
  }

  // Phase 3: Re-apply all components to the engine
  if (!options.dryRun) {
    info('\nApplying all components to engine...');
    const applySpinner = spinner('Applying components...');

    const result = await runFurnaceMutation(
      projectRoot,
      'apply-rollback',
      (ctx) => applyAllComponents(projectRoot, false, { operationContext: ctx }),
      { dryRun: false }
    );

    applySpinner.stop('Components applied');
    logApplyResult(result, false);

    const appliedWithStepErrorsCount = result.applied.filter(
      (entry) => (entry.stepErrors?.length ?? 0) > 0
    ).length;
    const totalFailures = result.errors.length + appliedWithStepErrorsCount;

    if (totalFailures > 0) {
      throw new FurnaceError(
        `${totalFailures} component${totalFailures === 1 ? '' : 's'} failed to apply cleanly`
      );
    }

    await reportJsconfigPathsSync(projectRoot, config, false);

    outro(`Sync complete — ${result.applied.length} applied, ${result.skipped.length} skipped`);
  } else {
    outro('Dry run complete');
  }
}
