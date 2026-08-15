// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { validateBrandOverride } from '../core/brand-validation.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { hasBuildArtifacts, machPackageCapture } from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import { explainMachError } from '../core/mach-error-hints.js';
import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { PackageOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { error, info, intro, outro, verbose } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Runs the package command to create a distribution package.
 * @param projectRoot - Root directory of the project
 * @param options - Package options
 */
export async function packageCommand(projectRoot: string, options: PackageOptions): Promise<void> {
  const brandInfo = options.brand ? ` [${options.brand}]` : '';
  intro(`FireForge Package${brandInfo}`);

  // Load configuration
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  validateBrandOverride(config.binaryName, options.brand);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, {
    label: 'Package',
    requirement: 'Packaging requires a completed build.',
    remediation: "Run 'fireforge build' first, then rerun 'fireforge package'.",
    requireExisting: true,
  });

  // Log brand info if specified
  if (options.brand) {
    verbose(`Packaging with brand: ${options.brand}`);
    info(`Brand: ${options.brand}`);
  }

  // Shared pre-flight: branding, Furnace, mozconfig
  await prepareBuildEnvironment(projectRoot, paths, config);

  // Run package
  info('Creating distribution package...');
  info('This may take a while.\n');

  const startTime = Date.now();
  let result: Awaited<ReturnType<typeof machPackageCapture>>;

  try {
    // `machPackageCapture` streams output live AND captures the tail for
    // post-run diagnostics. Previously `machPackage` inherited stdio
    // only, so a targeted hint translator could not see the failure text.
    // The captured stderr is fed through `explainMachError` below so
    // recognised failure modes (notably the `packager.py` NoneType trip
    // the evaluator hit on `mybrowser/`) get an actionable hint prepended
    // to the raw mach output the operator already saw.
    result = await machPackageCapture(paths.engine);
  } catch (error: unknown) {
    throw new BuildError(
      'Package process failed to start',
      'mach package',
      error instanceof Error ? error : undefined
    );
  }

  const duration = Date.now() - startTime;
  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  if (result.exitCode !== 0) {
    error(`Packaging failed after ${timeStr}`);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const hints = explainMachError(combinedOutput);
    const hintBlock = hints.length > 0 ? `\n\nHint:\n${hints.map((h) => `  ${h}`).join('\n')}` : '';
    throw new BuildError(
      `Packaging failed with exit code ${result.exitCode}.${hintBlock}`,
      'mach package'
    );
  }

  info(`\nPackage created in obj-*/dist/`);
  outro(`Packaging completed in ${timeStr}!`);
}

/** Registers the package command on the CLI program. */
export function registerPackage(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('package')
    .description('Create distribution package')
    .option('--brand <name>', 'Package specific brand')
    .action(
      withErrorHandling(async (options: { brand?: string }) => {
        await packageCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
