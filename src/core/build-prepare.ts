// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared pre-flight logic for build and package commands:
 * story cleanup, branding setup, Furnace component application, and mozconfig generation.
 */

import { constants as osConstants } from 'node:os';

import { BuildError } from '../errors/build.js';
import { FurnaceError } from '../errors/furnace.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, spinner, verbose, warn } from '../utils/logger.js';
import { isBrandingSetup, setupBranding } from './branding.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { collectChangedEnginePaths } from './engine-changes.js';
import { applyAllComponents } from './furnace-apply.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';
import { runFurnaceMutation } from './furnace-operation.js';
import { countEntriesWithBlockingStepErrors } from './furnace-step-errors.js';
import { cleanStories } from './furnace-stories.js';
import { generateMozconfig, type MachCommandResult, runMachCapture } from './mach.js';
import { explainMachError } from './mach-error-hints.js';

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
 * Extracts the tail of captured `mach configure` output so the underlying
 * mozbuild failure (e.g. `mozbuild.util.UnsortedError: ... is not in sorted
 * order`) is carried into the thrown `BuildError` instead of being reduced to
 * a bare exit code. mozbuild writes the error and its traceback to stderr;
 * stdout is included as a fallback for shells that interleave the streams.
 * Returns an empty string when nothing useful was captured.
 */
function extractMachConfigureError(result: MachCommandResult): string {
  const combined = `${result.stderr}\n${result.stdout}`.trim();
  if (!combined) return '';
  return combined.split('\n').slice(-40).join('\n').trim();
}

/**
 * Describes an exit code in the shell's 128+N signal convention. Truncated
 * configure/build logs with a signal-shaped exit (e.g. 144 = 128+16, SIGURG
 * on macOS) are environmental interruptions, not compiler failures — naming
 * that in the failure text saves the operator a fruitless log hunt
 * (FORGE F16). Returns undefined for codes <= 128 (regular failures) and
 * for codes past the conventional signal range, so callers append nothing.
 */
export function describeSignalShapedExit(exitCode: number): string | undefined {
  if (exitCode <= 128 || exitCode > 192) return undefined;
  const signalNumber = exitCode - 128;
  const names = Object.entries(osConstants.signals)
    .filter(([, value]) => value === signalNumber)
    .map(([name]) => name);
  const label = names.length > 0 ? names.join('/') : `signal ${signalNumber}`;
  return (
    `Exit ${exitCode} is signal-shaped (${exitCode} - 128 = ${signalNumber}, ${label} on this host): ` +
    'the process was likely interrupted externally (OOM-killer, terminal disconnect, ' +
    'display/session teardown) rather than failing on its own, and the log may be ' +
    'truncated mid-step.'
  );
}

/**
 * Builds the `BuildError` for a non-zero auto-configure exit: the output
 * tail (so the underlying mozbuild failure survives), any matched
 * mach-error hints (so e.g. a toolchain minimum that moved with a source
 * hop names `fireforge bootstrap` on this path too, exactly like the
 * protected build dispatch), and the stop rationale.
 */
function buildConfigureFailureError(captured: MachCommandResult): BuildError {
  const detail = extractMachConfigureError(captured);
  const hints = explainMachError(`${captured.stderr}\n${captured.stdout}`);
  const signalNote = describeSignalShapedExit(captured.exitCode);
  return new BuildError(
    `Backend regeneration failed: mach configure exited with code ${captured.exitCode}.` +
      (detail ? `\n\nmach configure output (tail):\n${detail}` : '') +
      (signalNote ? `\n\n${signalNote}` : '') +
      (hints.length > 0 ? `\n\n${hints.map((hint) => `Hint: ${hint}`).join('\n')}` : '') +
      '\n\nBuild stopped because continuing would hide the real configure failure.',
    'mach configure'
  );
}

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
    const changed = await collectChangedEnginePaths(
      paths.engine,
      options.previousBaseline,
      'Auto-configure'
    );
    const invalidating = changed.filter(isBackendInvalidatingFile);
    if (invalidating.length > 0) {
      info(
        `Backend config changed; running backend regeneration first (${invalidating.length} file${invalidating.length === 1 ? '' : 's'} touched).`
      );
      info(`Backend command: mach configure`);
      const configureSpinner = spinner('Running mach configure...');
      try {
        const captured = await runMachCapture(['configure'], paths.engine);
        const exitCode = captured.exitCode;
        if (exitCode !== 0) {
          configureSpinner.error(`mach configure failed with exit code ${exitCode}`);
          // Surface the underlying mozbuild error (e.g. UnsortedError) instead
          // of a bare exit code — the generic message hid the actual cause —
          // plus any matched mach-error hints (see the helper).
          throw buildConfigureFailureError(captured);
        } else {
          configureSpinner.stop('Backend regenerated successfully (mach configure exit code 0)');
          info('Backend regeneration succeeded; continuing with build.');
          reconfigured = true;
        }
      } catch (error: unknown) {
        if (error instanceof BuildError) {
          throw error;
        }
        configureSpinner.error('mach configure failed');
        verbose(`Auto-configure error: ${toError(error).message}`);
        throw new BuildError(
          `Backend regeneration failed while running mach configure: ${toError(error).message}. Build stopped because continuing would hide the real configure failure.`,
          'mach configure',
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  // Clean stories before build to ensure they don't leak into production binary
  await cleanStories(paths.engine);

  // Set up custom branding directory and patch moz.configure. Thread the
  // project license through so `buildConfigureScriptContent` /
  // `buildBrandPropertiesContent` / `buildBrandFtlContent` stamp the
  // generated files with a matching SPDX header — otherwise `patch-lint`
  // flags them with `missing-license-header` on every subsequent export
  // when the project is not MPL-2.0 (the eval finding: a 0BSD-licensed
  // fork's first export failed `lint` on its own generated branding).
  const brandingConfig = {
    name: config.name,
    vendor: config.vendor,
    appId: config.appId,
    binaryName: config.binaryName,
    ...(config.license !== undefined ? { license: config.license } : {}),
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
      const appliedWithStepErrorsCount = countEntriesWithBlockingStepErrors(result.applied);
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
