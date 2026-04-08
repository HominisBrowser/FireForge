// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { buildArtifactMismatchMessage, hasBuildArtifacts, run } from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import { toError } from '../utils/errors.js';
import { pathExists, removeDir, removeFile } from '../utils/fs.js';
import { info, intro, verbose } from '../utils/logger.js';

/**
 * Cleans the dev profile to prevent stale-state startup failures.
 *
 * Removes two things:
 * 1. **startupCache/** — Firefox caches compiled chrome JS bytecode here.
 *    When chrome scripts change between builds, the stale cache causes silent
 *    crashes on startup.
 * 2. **.parentlock** — A zero-byte lock file that persists if the previous
 *    session was killed (Ctrl-C, crash, `kill`). Firefox checks this on
 *    startup and silently exits if it exists, assuming another instance owns
 *    the profile.
 *
 * @param engineDir - Path to the engine directory
 */
async function cleanDevProfile(engineDir: string): Promise<void> {
  try {
    const entries = await readdir(engineDir);
    const objDirs = entries.filter((e) => e.startsWith('obj-'));
    if (objDirs.length === 0) {
      return;
    }

    for (const objDir of objDirs) {
      const profileDir = join(engineDir, objDir, 'tmp', 'profile-default');

      const cachePath = join(profileDir, 'startupCache');
      if (await pathExists(cachePath)) {
        await removeDir(cachePath);
      }

      const lockPath = join(profileDir, '.parentlock');
      if (await pathExists(lockPath)) {
        await removeFile(lockPath);
      }
    }
  } catch (error: unknown) {
    verbose(`Non-fatal dev profile cleanup failure: ${toError(error).message}`);
  }
}

/**
 * Runs the run command to launch the built browser.
 * @param projectRoot - Root directory of the project
 */
export async function runCommand(projectRoot: string): Promise<void> {
  intro('FireForge Run');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  const buildCheck = await hasBuildArtifacts(paths.engine);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  const mismatchMessage = buildArtifactMismatchMessage(paths.engine, buildCheck, 'Run');
  if (mismatchMessage) {
    throw new GeneralError(mismatchMessage);
  }
  if (!buildCheck.exists) {
    const detail = buildCheck.objDir
      ? `Build artifacts incomplete in ${buildCheck.objDir}/`
      : 'No build artifacts found (obj-*/ directory missing)';
    throw new GeneralError(
      `Run requires a completed build. ${detail}\n\n` +
        "Run 'fireforge build' first, then rerun 'fireforge run'."
    );
  }

  // Clean stale profile state to prevent silent startup failures
  await cleanDevProfile(paths.engine);

  info('Launching browser...\n');

  const exitCode = await run(paths.engine);

  if (exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
    throw new BuildError(`Browser exited with code ${exitCode}`, 'mach run');
  }
}

/** Registers the run command on the CLI program. */
export function registerRun(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('run')
    .description('Launch the built browser')
    .action(
      withErrorHandling(async () => {
        await runCommand(getProjectRoot());
      })
    );
}
