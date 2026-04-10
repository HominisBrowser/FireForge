// SPDX-License-Identifier: EUPL-1.2
import { Command, InvalidArgumentError as CommanderInvalidArgumentError } from 'commander';

import { validateBrandOverride } from '../core/brand-validation.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { build, buildArtifactMismatchMessage, buildUI, hasBuildArtifacts } from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { BuildOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { error, info, intro, outro, verbose } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { isPositiveInteger } from '../utils/validation.js';

function parseJobCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CommanderInvalidArgumentError('jobs must be a positive integer');
  }

  return parsed;
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
    throw new GeneralError(mismatchMessage);
  }

  // Log brand info if specified
  if (options.brand) {
    verbose(`Building with brand: ${options.brand}`);
    // Future: Load brand-specific config from fireforge.json brands section
    info(`Brand: ${options.brand}`);
  }

  // Shared pre-flight: branding, Furnace, mozconfig
  await prepareBuildEnvironment(projectRoot, paths, config);

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

  outro(`Build completed in ${timeStr}!`);
}

/** Registers the build command on the CLI program. */
export function registerBuild(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('build')
    .description('Build the browser')
    .option('--ui', 'Fast UI-only rebuild')
    .option('-j, --jobs <n>', 'Number of parallel jobs', parseJobCount)
    .option('--brand <name>', 'Build specific brand')
    .action(
      withErrorHandling(async (options: { ui?: boolean; jobs?: number; brand?: string }) => {
        await buildCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
