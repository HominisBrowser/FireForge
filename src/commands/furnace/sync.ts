// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../../core/config.js';
import { applyAllComponents } from '../../core/furnace-apply.js';
import { logApplyResult } from '../../core/furnace-apply-output.js';
import { getFurnacePaths, loadFurnaceConfig } from '../../core/furnace-config.js';
import { reportJsconfigPathsSync } from '../../core/furnace-jsconfig.js';
import { runFurnaceMutation, waitLockMutationOptions } from '../../core/furnace-operation.js';
import { assertFurnaceReady } from '../../core/furnace-precondition.js';
import { countEntriesWithBlockingStepErrors } from '../../core/furnace-step-errors.js';
import { containsMergeConflictMarkers } from '../../core/furnace-validate-structure.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceSyncOptions } from '../../types/commands/index.js';
import { pathExists, readText } from '../../utils/fs.js';
import { info, intro, outro, spinner, warn } from '../../utils/logger.js';
import { furnaceRefreshCommand } from './refresh.js';

/**
 * Scans every configured override/custom component workspace for files
 * carrying unresolved merge conflict markers. Returns the component names
 * (sorted, unique) that must be resolved before an apply may run.
 */
async function findComponentsWithConflictMarkers(
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>
): Promise<string[]> {
  const conflicted = new Set<string>();

  const componentDirs: Array<{ name: string; dir: string }> = [
    ...Object.keys(config.overrides).map((name) => ({
      name,
      dir: join(furnacePaths.overridesDir, name),
    })),
    ...Object.keys(config.custom).map((name) => ({
      name,
      dir: join(furnacePaths.customDir, name),
    })),
  ];

  for (const { name, dir } of componentDirs) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        !entry.name.endsWith('.mjs') &&
        !entry.name.endsWith('.css') &&
        !entry.name.endsWith('.ftl')
      ) {
        continue;
      }
      if (containsMergeConflictMarkers(await readText(join(dir, entry.name)))) {
        conflicted.add(name);
        break;
      }
    }
  }

  return [...conflicted].sort();
}

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

  const { config } = await assertFurnaceReady(projectRoot);
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

  // Phase 2.5: post-refresh gates. Refresh deliberately leaves conflict
  // markers in workspace files and does NOT bump baseVersion on conflict —
  // so without this gate sync warns about conflicts and then copies the
  // marker-laden files straight into the engine via Phase 3, producing a
  // broken build from the one command whose whole purpose is a safe upgrade.
  // Apply and deploy both enforce a drift gate; sync must not be the back
  // door around it.
  if (!options.dryRun) {
    const refreshedConfig = await loadFurnaceConfig(projectRoot);
    const furnacePaths = getFurnacePaths(projectRoot);

    const conflicted = await findComponentsWithConflictMarkers(furnacePaths, refreshedConfig);
    const remainingDrift = findOverrideBaseVersionDrift(
      refreshedConfig,
      forgeConfig.firefox.version
    );

    if (conflicted.length > 0 || remainingDrift.length > 0) {
      if (conflicted.length > 0) {
        warn(`Unresolved merge conflicts in: ${conflicted.join(', ')}`);
      }
      for (const entry of remainingDrift) {
        warn(formatOverrideBaseVersionDriftWarning(entry));
      }
      throw new FurnaceError(
        'Sync stopped before applying: ' +
          (conflicted.length > 0
            ? `${conflicted.length} component(s) contain unresolved merge conflict markers` +
              (remainingDrift.length > 0 ? ' and ' : '')
            : '') +
          (remainingDrift.length > 0
            ? `${remainingDrift.length} override(s) still have baseVersion drift`
            : '') +
          '. Resolve the conflicts in the component workspace files, re-run ' +
          '"fireforge furnace refresh <name>" to update baseVersion, then run ' +
          '"fireforge furnace sync" again. Nothing was applied to the engine.'
      );
    }
  }

  // Phase 3: Re-apply all components to the engine
  if (!options.dryRun) {
    info('\nApplying all components to engine...');
    const applySpinner = spinner('Applying components...');

    const result = await runFurnaceMutation(
      projectRoot,
      'apply-rollback',
      (ctx) => applyAllComponents(projectRoot, false, { operationContext: ctx }),
      { dryRun: false, ...waitLockMutationOptions(options.waitLockSeconds) }
    );

    applySpinner.stop('Components applied');
    logApplyResult(result, false);

    const appliedWithStepErrorsCount = countEntriesWithBlockingStepErrors(result.applied);
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
