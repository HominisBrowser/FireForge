// SPDX-License-Identifier: EUPL-1.2
import { Command, InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

import { validateBrandOverride } from '../core/brand-validation.js';
import { auditBuildArtifacts } from '../core/build-audit.js';
import { readBuildBaseline, writeBuildBaseline } from '../core/build-baseline.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  attemptMozinfoRewrite,
  build,
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  runMach,
} from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { BuildOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { checkDiskSpace, pathExists } from '../utils/fs.js';
import { error, info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { isPositiveInteger } from '../utils/validation.js';

function parseJobCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CommanderInvalidArgumentError('jobs must be a positive integer');
  }

  return parsed;
}

/**
 * Patches `mozinfo.json` under the active obj-* directory so its recorded
 * paths match the current engine checkout, then runs `mach configure` to
 * regenerate every other generated path alongside it. Throws with the
 * original mismatch guidance when the rewriter refuses to proceed — that
 * always covers the unsafe cases, so the operator still gets the correct
 * fallback recovery instruction.
 */
async function rewriteAndReconfigure(
  engineDir: string,
  objDir: string,
  mismatchMessage: string
): Promise<void> {
  const rewriteSpinner = spinner('Rewriting mozinfo.json paths...');
  let rewrite;
  try {
    rewrite = await attemptMozinfoRewrite(engineDir, objDir);
  } catch (rewriteError: unknown) {
    rewriteSpinner.error('mozinfo rewrite failed');
    throw new GeneralError(
      `${mismatchMessage}\n\nmozinfo rewrite failed: ${toError(rewriteError).message}`
    );
  }
  if (!rewrite.rewritten) {
    rewriteSpinner.error('mozinfo rewrite refused');
    throw new GeneralError(
      `${mismatchMessage}\n\nmozinfo rewrite refused: ${rewrite.reason ?? 'unspecified reason'}`
    );
  }
  rewriteSpinner.stop(`mozinfo.json patched (topsrcdir → ${rewrite.newTopsrcdir})`);

  const configureSpinner = spinner('Running mach configure against rewritten mozinfo.json...');
  let exitCode: number;
  try {
    exitCode = await runMach(['configure'], engineDir);
  } catch (configureError: unknown) {
    configureSpinner.error('mach configure failed');
    throw new BuildError(
      'mach configure failed after mozinfo rewrite',
      'mach configure',
      configureError instanceof Error ? configureError : undefined
    );
  }
  if (exitCode !== 0) {
    configureSpinner.error('mach configure exited non-zero');
    throw new BuildError(
      `mach configure exited non-zero (${exitCode}) after mozinfo rewrite; a clean rebuild is required.`,
      'mach configure'
    );
  }
  configureSpinner.stop('mach configure regenerated the backend');
  info('Backend path-rewrite complete; continuing with the build.');
}

function resolveJobCount(
  options: BuildOptions,
  configJobs: number | undefined
): number | undefined {
  const jobs = options.jobs ?? configJobs;
  if (jobs === undefined) {
    return undefined;
  }

  if (!isPositiveInteger(jobs)) {
    throw new GeneralError('Build jobs must be a positive integer');
  }

  return jobs;
}

/**
 * Runs the build command.
 * @param projectRoot - Root directory of the project
 * @param options - Build options
 */
export async function buildCommand(projectRoot: string, options: BuildOptions): Promise<void> {
  const buildType = options.ui ? 'UI-only' : 'Full';
  const brandInfo = options.brand ? ` [${options.brand}]` : '';
  intro(`FireForge Build (${buildType}${brandInfo})`);

  // Load configuration
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  validateBrandOverride(config.binaryName, options.brand);

  // Disk space pre-flight: a full Firefox build can be ~20 GB
  await checkDiskSpace(projectRoot, 20 * 1024 * 1024 * 1024, warn);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  const buildCheck = await hasBuildArtifacts(paths.engine);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  const mismatchMessage = buildArtifactMismatchMessage(paths.engine, buildCheck, 'Build');
  if (mismatchMessage) {
    if (options.rewriteMozinfo && buildCheck.objDir) {
      // Safe-relocation rewrite path: patch mozinfo.json paths in place so
      // `mach configure` can regenerate the backend without scrubbing the
      // whole obj tree. The rewriter refuses anything that is not a pure
      // prefix-move; on refusal we surface the refusal reason alongside
      // the original mismatch guidance and abort.
      await rewriteAndReconfigure(paths.engine, buildCheck.objDir, mismatchMessage);
    } else {
      throw new GeneralError(mismatchMessage);
    }
  }

  // Log brand info if specified
  if (options.brand) {
    verbose(`Building with brand: ${options.brand}`);
    // Future: Load brand-specific config from fireforge.json brands section
    info(`Brand: ${options.brand}`);
  }

  // Read the previous build baseline BEFORE prepareBuildEnvironment so the
  // auto-configure step there can detect moz.build-family changes since the
  // last successful build. The post-build audit below reuses the same
  // baseline to diff engine changes against dist artifacts.
  const previousBaseline = await readBuildBaseline(projectRoot);

  // Shared pre-flight: branding, Furnace, mozconfig, auto-configure
  await prepareBuildEnvironment(projectRoot, paths, config, { previousBaseline });

  const jobs = resolveJobCount(options, config.build?.jobs);

  // Run build
  info(`Starting ${buildType.toLowerCase()} build...`);
  if (jobs !== undefined) {
    info(`Using ${jobs} parallel jobs`);
  }
  info(''); // Empty line before build output

  const startTime = Date.now();
  let exitCode: number;

  try {
    if (options.ui) {
      exitCode = await buildUI(paths.engine);
    } else {
      exitCode = await build(paths.engine, jobs);
    }
  } catch (error: unknown) {
    throw new BuildError(
      'Build process failed to start',
      options.ui ? 'mach build faster' : 'mach build',
      error instanceof Error ? error : undefined
    );
  }

  const duration = Date.now() - startTime;
  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  if (exitCode !== 0) {
    error(`Build failed after ${timeStr}`);
    throw new BuildError(
      `Build failed with exit code ${exitCode}`,
      options.ui ? 'mach build faster' : 'mach build'
    );
  }

  // Warn-only post-build audit: surfaces silent packaging drops (files
  // edited in engine/ but never registered for packaging) against the
  // previous-build baseline. Never fails the build; the worst case is a
  // warning an operator chooses to investigate.
  try {
    await auditBuildArtifacts(projectRoot, paths.engine, previousBaseline);
  } catch (auditError: unknown) {
    verbose(`Audit skipped: ${toError(auditError).message}`);
  }

  // Record a fresh baseline only on clean success so the next run audits
  // against this build's HEAD. A failed build keeps the prior baseline so
  // the next attempt still catches long-standing packaging drops.
  try {
    await writeBuildBaseline(projectRoot, paths.engine, config.binaryName);
  } catch (baselineError: unknown) {
    verbose(`Could not persist build baseline: ${toError(baselineError).message}`);
  }

  outro(`Build completed in ${timeStr}!`);
}

/** Registers the build command on the CLI program. */
export function registerBuild(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('build')
    .description('Build the browser (auto-applies Furnace components first)')
    .option('--ui', 'Fast UI-only rebuild')
    .option('-j, --jobs <n>', 'Number of parallel jobs', parseJobCount)
    .option('--brand <name>', 'Build specific brand')
    .option(
      '--rewrite-mozinfo',
      'On a mozinfo path mismatch, patch mozinfo.json paths in place and run mach configure instead of aborting with a clean-rebuild instruction. Refuses anything that is not a pure prefix-move.'
    )
    .addHelpText(
      'after',
      [
        '',
        'Furnace apply runs automatically before the build step, so edits in',
        'components/custom/ and components/overrides/ are propagated to the',
        'engine/ tree every time. The command prints a banner listing the',
        'components synced during the current invocation.',
        '',
        'If you want to preview the engine state without triggering a build,',
        'run `fireforge furnace apply` directly. For source-change-driven',
        'rebuild loops during development, use `fireforge watch`.',
        '',
        '--rewrite-mozinfo: when a workspace is moved to a new path, mozinfo.json',
        'still records the old topsrcdir/topobjdir and the build aborts with a',
        'delete-and-rebuild instruction. This flag patches those paths in place',
        'and runs mach configure — preserving up to ~20 GB of obj-* artefacts on',
        'a relocation. The rewriter refuses any change that is not a pure prefix',
        'move, in which case a clean rebuild is still required.',
      ].join('\n')
    )
    .action(
      withErrorHandling(
        async (options: {
          ui?: boolean;
          jobs?: number;
          brand?: string;
          rewriteMozinfo?: boolean;
        }) => {
          await buildCommand(getProjectRoot(), pickDefined(options));
        }
      )
    );
}
