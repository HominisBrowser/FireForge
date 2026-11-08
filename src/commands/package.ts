// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { validateBrandOverride } from '../core/brand-validation.js';
import { assertNoPendingFurnaceRepair } from '../core/build-prepare.js';
import { assessBuildProvenance } from '../core/build-provenance.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { listStaleFurnaceComponents } from '../core/furnace-staleness.js';
import {
  hasBuildArtifacts,
  type MachCommandResult,
  machPackageCapture,
  withBuildLock,
} from '../core/mach.js';
import { assertBuildArtifacts, hasRunnableBundle } from '../core/mach-build-artifacts.js';
import { explainMachError } from '../core/mach-error-hints.js';
import { ensureLaunchableBrowserNotRunning } from '../core/marionette-port.js';
import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { PackageOptions } from '../types/commands/index.js';
import { elapsedSince } from '../utils/elapsed.js';
import { error, info, intro, outro, verbose, warn } from '../utils/logger.js';
import { pickDefined, resolveWaitLockSeconds } from '../utils/options.js';
import { packageRelease } from './package-release.js';

/** Package options, plus the acceptance of a build the tree has moved past. */
type PackageCommandOptions = PackageOptions & { allowStaleBuild?: boolean; recipe?: string };

/**
 * Packaging ships the objdir as the last build left it and changes nothing
 * first: a Furnace apply or a regenerated mozconfig here would rewrite engine
 * files the dist does not contain. So the build must be the tree's, and a binary
 * that still carries a negative control never ships, whatever the flags say.
 */
async function assertShippableBuild(
  projectRoot: string,
  engineDir: string,
  launchablePath: string | undefined,
  allowStaleBuild: boolean
): Promise<void> {
  await assertNoPendingFurnaceRepair(projectRoot);
  const pendingFurnace = await listStaleFurnaceComponents(projectRoot);
  const findings = await assessBuildProvenance(projectRoot, engineDir, launchablePath);
  if (findings.controlBuilt !== undefined) {
    throw new GeneralError(`Refusing to package: ${findings.controlBuilt}`);
  }
  const problems = [
    ...(findings.noBaseline === undefined ? [] : [findings.noBaseline]),
    ...(findings.stale ?? []),
    ...(pendingFurnace.length === 0
      ? []
      : [
          `Furnace components have undeployed edits the build does not contain: ${pendingFurnace.join(', ')}.`,
        ]),
  ];
  if (problems.length === 0) return;
  const report = problems.join('\n\n');
  if (allowStaleBuild) {
    warn(report);
    return;
  }
  throw new GeneralError(
    `Refusing to package a build that does not match the tree:\n\n${report}\n\n` +
      'Run "fireforge build" first. --allow-stale-build packages the objdir as it stands.'
  );
}

/**
 * Runs the package command to create a distribution package.
 * @param projectRoot - Root directory of the project
 * @param options - Package options
 */
export async function packageCommand(
  projectRoot: string,
  options: PackageCommandOptions & { waitLock?: number | boolean }
): Promise<void> {
  await withEngineSessionLock(
    projectRoot,
    'package',
    () => withBuildLock(projectRoot, () => packageUnderLocks(projectRoot, options)),
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock) }
  );
}

async function packageUnderLocks(
  projectRoot: string,
  options: PackageCommandOptions
): Promise<void> {
  if (options.recipe !== undefined) {
    if (options.recipe !== 'release') throw new GeneralError('The only package recipe is release');
    await packageRelease(projectRoot);
    return;
  }
  const brandInfo = options.brand ? ` [${options.brand}]` : '';
  intro(`FireForge Package${brandInfo}`);

  // Load configuration
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  validateBrandOverride(config.binaryName, options.brand);

  // Check if engine exists
  await assertEngineExists(paths.engine);

  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, {
    label: 'Package',
    requirement: 'Packaging requires a completed build.',
    remediation: "Run 'fireforge build' first, then rerun 'fireforge package'.",
    requireExisting: true,
  });
  const bundle =
    buildCheck.objDir === undefined
      ? undefined
      : await hasRunnableBundle(paths.engine, config.binaryName, buildCheck.objDir);
  if (bundle?.expectedPath === undefined)
    throw new BuildError(
      'Cannot establish the browser path for packaging preflight; complete a build first.',
      'mach package'
    );
  await ensureLaunchableBrowserNotRunning(join(paths.engine, bundle.expectedPath));

  // Log brand info if specified
  if (options.brand) {
    verbose(`Packaging with brand: ${options.brand}`);
    info(`Brand: ${options.brand}`);
  }

  await assertShippableBuild(
    projectRoot,
    paths.engine,
    bundle.expectedPath,
    options.allowStaleBuild === true
  );

  // Run package
  info('Creating distribution package...');
  info('This may take a while.\n');

  const startTime = Date.now();
  let result: MachCommandResult;

  try {
    // `machPackageCapture` streams output live and captures the tail for
    // post-run diagnostics. An inherit-only dispatch leaves the hint
    // translator unable to see the failure text. The captured stderr is fed
    // through `explainMachError` below so recognised failure modes get an
    // actionable hint prepended to the raw mach output.
    result = await machPackageCapture(paths.engine);
  } catch (error: unknown) {
    throw new BuildError(
      'Package process failed to start',
      'mach package',
      error instanceof Error ? error : undefined
    );
  }

  const timeStr = elapsedSince(startTime);

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
    .option('--recipe <name>', 'Build and package by a declared recipe, in a job: release')
    .option(
      '--allow-stale-build',
      'Package a build the tree has moved past, or one with no recorded build. A binary that still carries a negative control is refused regardless'
    )
    .action(
      withErrorHandling(
        async (options: { brand?: string; allowStaleBuild?: boolean; recipe?: string }) => {
          await packageCommand(getProjectRoot(), pickDefined(options));
        }
      )
    );
}
