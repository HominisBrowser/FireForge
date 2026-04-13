// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared pre-flight logic for build and package commands:
 * story cleanup, branding setup, Furnace component application, and mozconfig generation.
 */

import { FurnaceError } from '../errors/furnace.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { spinner, warn } from '../utils/logger.js';
import { isBrandingSetup, setupBranding } from './branding.js';
import { applyAllComponents } from './furnace-apply.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';
import { runFurnaceMutation } from './furnace-operation.js';
import { cleanStories } from './furnace-stories.js';
import { generateMozconfig } from './mach.js';

/**
 * Result of the build preparation phase.
 */
export interface BuildPreparation {
  /** Number of Furnace components applied (0 if none or no furnace.json) */
  furnaceApplied: number;
}

/**
 * Runs the shared pre-flight steps for build and package commands:
 * 1. Cleans Furnace stories from engine (prevents leaking into production)
 * 2. Sets up branding directory if not already done
 * 3. Applies Furnace components if furnace.json exists
 * 4. Generates mozconfig
 *
 * @param projectRoot - Root directory of the project
 * @param paths - Resolved project paths
 * @param config - Loaded FireForge configuration
 * @returns Preparation results
 */
export async function prepareBuildEnvironment(
  projectRoot: string,
  paths: ProjectPaths,
  config: FireForgeConfig
): Promise<BuildPreparation> {
  // Block the build if Furnace has an unresolved repair marker. This prevents
  // building against an engine that may be in an inconsistent state after a
  // failed rollback.
  const furnaceStatePath = getFurnacePaths(projectRoot).furnaceState;
  if (await pathExists(furnaceStatePath)) {
    const furnaceState = await loadFurnaceState(projectRoot);
    if (furnaceState.pendingRepair) {
      throw new FurnaceError(
        `Furnace has an unresolved repair marker (from ${furnaceState.pendingRepair.operation}). ` +
          'Run "fireforge doctor --repair-furnace" to reconcile engine state before building.'
      );
    }
  }

  // Clean stories before build to ensure they don't leak into production binary
  await cleanStories(paths.engine);

  // Set up custom branding directory and patch moz.configure
  const brandingConfig = {
    name: config.name,
    vendor: config.vendor,
    appId: config.appId,
    binaryName: config.binaryName,
  };
  if (!(await isBrandingSetup(paths.engine, brandingConfig))) {
    const brandingSpinner = spinner('Setting up branding...');
    try {
      await setupBranding(paths.engine, brandingConfig);
      brandingSpinner.stop('Branding configured');
    } catch (error: unknown) {
      brandingSpinner.error('Failed to set up branding');
      throw error;
    }
  }

  // Apply Furnace components if furnace.json exists
  let furnaceApplied = 0;
  if (await furnaceConfigExists(projectRoot)) {
    const furnaceConfig = await loadFurnaceConfig(projectRoot);
    const hasComponents =
      Object.keys(furnaceConfig.overrides).length > 0 ||
      Object.keys(furnaceConfig.custom).length > 0;

    if (hasComponents) {
      const furnaceSpinner = spinner('Applying Furnace components...');
      let result: Awaited<ReturnType<typeof applyAllComponents>>;
      try {
        result = await runFurnaceMutation(projectRoot, 'apply-rollback', (ctx) =>
          applyAllComponents(projectRoot, false, { operationContext: ctx })
        );
      } catch (error: unknown) {
        furnaceSpinner.error('Failed to apply Furnace components');
        throw error;
      }

      furnaceApplied = result.applied.length;
      // Count entries that were "applied" but recorded step-level errors
      // mid-apply (e.g. a post-step failure after file writes succeeded).
      // These are distinct from `result.errors`, which captures
      // components that failed before reaching the applied list at all.
      // The sum of the two is the total count of failed components.
      const appliedWithStepErrorsCount = result.applied.filter(
        (entry) => (entry.stepErrors?.length ?? 0) > 0
      ).length;
      const totalApplyFailures = result.errors.length + appliedWithStepErrorsCount;

      if (totalApplyFailures > 0) {
        furnaceSpinner.error('Failed to apply Furnace components');
        for (const err of result.errors) {
          warn(`Furnace: ${err.name} — ${err.error}`);
        }
        for (const applied of result.applied) {
          if (applied.stepErrors && applied.stepErrors.length > 0) {
            for (const stepErr of applied.stepErrors) {
              warn(`Furnace: ${applied.name} [${stepErr.step}] ${stepErr.error}`);
            }
          }
        }
        throw new FurnaceError(
          `${totalApplyFailures} component${totalApplyFailures === 1 ? '' : 's'} failed to apply cleanly`
        );
      }

      if (furnaceApplied > 0) {
        furnaceSpinner.stop(
          `Applied ${furnaceApplied} component${furnaceApplied === 1 ? '' : 's'}`
        );
      } else {
        furnaceSpinner.stop('Components up to date');
      }
    }
  }

  // Generate mozconfig
  const mozconfigSpinner = spinner('Generating mozconfig...');
  try {
    await generateMozconfig(paths.configs, paths.engine, config);
    mozconfigSpinner.stop('mozconfig generated');
  } catch (error: unknown) {
    mozconfigSpinner.error('Failed to generate mozconfig');
    throw error;
  }

  return { furnaceApplied };
}
