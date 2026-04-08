// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  buildArtifactMismatchMessage,
  generateMozconfig,
  hasBuildArtifacts,
  watchWithOutput,
} from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner } from '../utils/logger.js';
import { executableExists } from '../utils/process.js';

/**
 * Builds remediation guidance for objdirs configured before watchman was available.
 * @returns User-facing configure-time watchman guidance
 */
function buildWatchmanConfigureTimeMessage(): string {
  return (
    'Watch mode cannot use the current obj-* build because watchman was not available when Firefox was configured.\n\n' +
    'Install watchman, delete the current obj-* directory, run "fireforge build" again, then retry "fireforge watch".'
  );
}

/**
 * Builds the generic unsupported-watch failure message.
 * @param exitCode - Exit code returned by `mach watch`
 * @returns User-facing failure guidance
 */
function buildUnsupportedWatchMessage(exitCode: number): string {
  return (
    `Watch failed with exit code ${exitCode}. Check the output above for details.\n\n` +
    'Common causes:\n' +
    '  - watchman is not installed or not in PATH right now\n' +
    '  - watchman was installed only after the current obj-* directory was configured; delete obj-* and rebuild\n' +
    '  - mach watch is unsupported in the current objdir or build environment'
  );
}

/**
 * Detects the Firefox-side output produced when watchman was missing at configure time.
 * @param output - Combined stdout and stderr from the watch run
 * @returns True when the output matches the configure-time watchman failure mode
 */
function hasConfigureTimeWatchmanFailure(output: string): boolean {
  return (
    /watchman/i.test(output) &&
    /(configure time|configured|configuration time|when (?:this|the current) build was configured)/i.test(
      output
    )
  );
}

/**
 * Runs the watch command for auto-rebuilding.
 * @param projectRoot - Root directory of the project
 */
export async function watchCommand(projectRoot: string): Promise<void> {
  intro('FireForge Watch');

  // Load configuration
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  if (!(await executableExists('watchman'))) {
    throw new GeneralError(
      'Watch mode requires watchman to be installed and available in PATH.\n\n' +
        'Install watchman first, then rerun "fireforge watch".'
    );
  }

  // Check for build artifacts before starting watch
  const buildCheck = await hasBuildArtifacts(paths.engine);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  // Reject copied or relocated obj-* dirs whose mozinfo metadata (topsrcdir,
  // topobjdir, mozconfig) still points at a different source tree. Running mach
  // watch against stale metadata produces confusing build errors.
  const mismatchMessage = buildArtifactMismatchMessage(paths.engine, buildCheck, 'Watch mode');
  if (mismatchMessage) {
    throw new GeneralError(mismatchMessage);
  }
  if (!buildCheck.exists) {
    const detail = buildCheck.objDir
      ? `Build artifacts incomplete in ${buildCheck.objDir}/`
      : 'No build artifacts found (obj-*/ directory missing)';
    throw new GeneralError(
      `Watch mode requires a completed build. ${detail}\n\n` +
        "Run 'fireforge build' first to create the initial build, then run 'fireforge watch'."
    );
  }

  info(`Using build artifacts from ${buildCheck.objDir}/`);

  // Generate mozconfig (in case it's not up to date)
  const mozconfigSpinner = spinner('Generating mozconfig...');

  try {
    await generateMozconfig(paths.configs, paths.engine, config);
    mozconfigSpinner.stop('mozconfig generated');
  } catch (error: unknown) {
    mozconfigSpinner.error('Failed to generate mozconfig');
    throw error;
  }

  info('Starting watch mode...');
  info('Press Ctrl+C to stop\n');

  let result: Awaited<ReturnType<typeof watchWithOutput>>;

  try {
    result = await watchWithOutput(paths.engine);
  } catch (error: unknown) {
    throw new BuildError(
      'Watch process failed to start',
      'mach watch',
      error instanceof Error ? error : undefined
    );
  }

  if (result.exitCode !== 0 && result.exitCode !== 130) {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (hasConfigureTimeWatchmanFailure(combinedOutput)) {
      throw new GeneralError(buildWatchmanConfigureTimeMessage());
    }

    // 130 is SIGINT (Ctrl+C), which is expected
    throw new BuildError(buildUnsupportedWatchMessage(result.exitCode), 'mach watch');
  }

  outro('Watch mode stopped');
}

/** Registers the watch command on the CLI program. */
export function registerWatch(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('watch')
    .description('Watch for changes and auto-rebuild')
    .action(
      withErrorHandling(async () => {
        await watchCommand(getProjectRoot());
      })
    );
}
