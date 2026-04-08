// SPDX-License-Identifier: EUPL-1.2
import { getProjectPaths } from '../../core/config.js';
import { applyAllComponents } from '../../core/furnace-apply.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceApplyOptions } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, outro, spinner, success, warn } from '../../utils/logger.js';

/**
 * Runs the furnace apply command to apply all components to the engine.
 * @param projectRoot - Root directory of the project
 * @param options - Apply options
 */
export async function furnaceApplyCommand(
  projectRoot: string,
  options: FurnaceApplyOptions = {}
): Promise<void> {
  intro('Furnace Apply');

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

  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;

  if (overrideCount === 0 && customCount === 0) {
    info('No components to apply.');
    outro('Done');
    return;
  }

  const dryRun = options.dryRun ?? false;

  const applySpinner = dryRun ? undefined : spinner('Applying components to engine...');

  const result = await applyAllComponents(projectRoot, dryRun);

  if (applySpinner) {
    applySpinner.stop('Components applied');
  }

  // Report applied
  for (const applied of result.applied) {
    const prefix = dryRun ? '[dry-run] Would apply' : '';
    const label = dryRun
      ? `${prefix} ${applied.name} (${applied.type}) → ${applied.filesAffected.length} files`
      : `${applied.name} (${applied.type}) → ${applied.filesAffected.length} files`;
    if (dryRun) {
      info(label);
    } else {
      success(label);
    }
    if (applied.stepErrors && applied.stepErrors.length > 0) {
      for (const stepErr of applied.stepErrors) {
        warn(`${applied.name}: [${stepErr.step}] ${stepErr.error}`);
      }
    }
  }

  // Report skipped
  for (const skipped of result.skipped) {
    info(`${skipped.name} — ${skipped.reason}`);
  }

  // Report errors
  for (const err of result.errors) {
    error(`${err.name} — ${err.error}`);
  }

  const stepFailureCount = dryRun
    ? 0
    : result.applied.filter((entry) => (entry.stepErrors?.length ?? 0) > 0).length;
  const totalApplyFailures = result.errors.length + stepFailureCount;

  if (totalApplyFailures > 0) {
    throw new FurnaceError(
      `${totalApplyFailures} component${totalApplyFailures === 1 ? '' : 's'} failed to apply cleanly`
    );
  }

  const appliedCount = result.applied.length;
  const skippedCount = result.skipped.length;

  if (dryRun) {
    outro(`Dry run complete — would apply ${appliedCount}, skip ${skippedCount}`);
  } else {
    outro(`Applied ${appliedCount}, skipped ${skippedCount}`);
  }
}
