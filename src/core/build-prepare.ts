// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared pre-flight logic for build and package commands:
 * story cleanup, branding setup, Furnace component application, and mozconfig generation.
 */

import { FurnaceError } from '../errors/furnace.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, spinner, verbose, warn } from '../utils/logger.js';
import { isBrandingSetup, setupBranding } from './branding.js';
import type { BuildBaseline } from './build-baseline.js';
import { applyAllComponents } from './furnace-apply.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';
import { runFurnaceMutation } from './furnace-operation.js';
import { cleanStories } from './furnace-stories.js';
import { hasChanges, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';
import { generateMozconfig, runMach } from './mach.js';

/**
 * Result of the build preparation phase.
 */
export interface BuildPreparation {
  /** Number of Furnace components applied (0 if none or no furnace.json) */
  furnaceApplied: number;
  /** True when `mach configure` was auto-run to refresh a stale backend. */
  reconfigured: boolean;
}

/** Options for {@link prepareBuildEnvironment}. */
export interface PrepareBuildOptions {
  /**
   * Previous successful-build baseline, used to detect `moz.build` /
   * `moz.configure` / `Makefile.in` changes that require a fresh
   * `mach configure` before the build. When undefined, the auto-configure
   * step is skipped — there's no reference point for what "changed since"
   * means.
   */
  previousBaseline?: BuildBaseline | undefined;
}

/** Path fragments of files whose edits invalidate the recursive-make backend. */
const BACKEND_INVALIDATING_SUFFIXES = ['moz.build', 'moz.configure', 'Makefile.in'];

/**
 * Returns true when the file path matches a pattern that forces
 * `mach configure` to regenerate the backend. Exported for testing.
 */
export function isBackendInvalidatingFile(path: string): boolean {
  for (const suffix of BACKEND_INVALIDATING_SUFFIXES) {
    if (path === suffix || path.endsWith(`/${suffix}`)) return true;
  }
  return false;
}

/**
 * Collects engine-relative paths of files changed since the baseline's HEAD
 * SHA plus any workdir modifications. Defensive — git failures surface as
 * verbose lines and return the files collected so far. An empty result
 * means "no drift we can prove" rather than "no drift occurred".
 */
async function collectBackendRelevantChanges(
  engineDir: string,
  baseline: BuildBaseline
): Promise<string[]> {
  const collected = new Set<string>();

  if (baseline.engineHeadSha) {
    try {
      const diff = await git(['diff', '--name-only', `${baseline.engineHeadSha}..HEAD`], engineDir);
      for (const line of diff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
    } catch (error: unknown) {
      if (!isMissingHeadError(error)) {
        verbose(
          `Auto-configure: could not diff engine against baseline — ${toError(error).message}`
        );
      }
    }
  }

  try {
    if (await hasChanges(engineDir)) {
      const worktreeDiff = await git(['diff', '--name-only', 'HEAD'], engineDir);
      for (const line of worktreeDiff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
      for (const file of await getUntrackedFiles(engineDir)) {
        collected.add(file);
      }
    }
  } catch (error: unknown) {
    verbose(`Auto-configure: could not enumerate workdir changes — ${toError(error).message}`);
  }

  return [...collected];
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
  config: FireForgeConfig,
  options: PrepareBuildOptions = {}
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

  // Auto-configure: if any backend-invalidating file (moz.build, moz.configure,
  // Makefile.in) changed since the last successful build, run `mach configure`
  // before the build step. Prevents incremental builds from silently skipping
  // work against a stale recursive-make backend.
  let reconfigured = false;
  if (options.previousBaseline) {
    const changed = await collectBackendRelevantChanges(paths.engine, options.previousBaseline);
    const invalidating = changed.filter(isBackendInvalidatingFile);
    if (invalidating.length > 0) {
      info(
        `Backend config changed; running mach configure first... (${invalidating.length} file${invalidating.length === 1 ? '' : 's'} touched)`
      );
      const configureSpinner = spinner('Running mach configure...');
      try {
        const exitCode = await runMach(['configure'], paths.engine);
        if (exitCode !== 0) {
          configureSpinner.error('mach configure exited non-zero; continuing with build anyway');
        } else {
          configureSpinner.stop('Backend regenerated');
          reconfigured = true;
        }
      } catch (error: unknown) {
        configureSpinner.error('mach configure failed; continuing with build anyway');
        verbose(`Auto-configure error: ${toError(error).message}`);
      }
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
        const appliedNames = result.applied.map((entry) => entry.name).join(', ');
        furnaceSpinner.stop(
          `Applied ${furnaceApplied} component${furnaceApplied === 1 ? '' : 's'}`
        );
        // Loud banner: the build operator needs to see that engine/ was
        // updated before this build, otherwise a silent re-apply is
        // indistinguishable from a build that shipped stale components.
        info(
          `Furnace: source → engine sync wrote ${furnaceApplied} component${furnaceApplied === 1 ? '' : 's'} before build (${appliedNames}). engine/ now matches components/.`
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

  return { furnaceApplied, reconfigured };
}
