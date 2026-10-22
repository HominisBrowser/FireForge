// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge build --wait-browser` spends its budget before the engine
 * session lock, not while holding it.
 *
 * A build queued behind a running objdir browser (a demo batch, an
 * end-to-end harness) that waited inside `withEngineSessionLock` would queue
 * every peer's build, test and re-export behind a run that was doing
 * nothing. The wait happens first, and the in-lock objdir preflight
 * re-checks once (the spent budget is stripped from the options it gets).
 */

import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { hasBuildArtifacts, hasRunnableBundle } from '../core/mach.js';
import { ensureLaunchableBrowserNotRunning } from '../core/marionette-port.js';
import { waitBeforeLock } from '../core/preflight-wait.js';
import type { BuildOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { resolveWaitLockSeconds } from '../utils/options.js';

/**
 * Waits for this objdir's browser before the lock when `--wait-browser`
 * was given and there is a launchable bundle to watch.
 *
 * @param projectRoot - Project root
 * @param options - Parsed build options
 * @returns The options the in-lock run should use
 */
export async function waitForBuildBrowserBeforeLock(
  projectRoot: string,
  options: BuildOptions
): Promise<BuildOptions> {
  const { waitBrowser, ...rest } = options;
  if (waitBrowser === undefined) return options;
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) return options;
  const { objDir } = await hasBuildArtifacts(paths.engine);
  if (objDir === undefined) return options;
  let binaryName: string;
  try {
    ({ binaryName } = await loadConfig(projectRoot));
  } catch {
    return options;
  }
  const bundle = await hasRunnableBundle(paths.engine, binaryName, objDir);
  const expectedPath = bundle.expectedPath;
  if (!bundle.runnable || expectedPath === undefined) return options;
  await waitBeforeLock(
    () => ensureLaunchableBrowserNotRunning(join(paths.engine, expectedPath)),
    resolveWaitLockSeconds(waitBrowser)
  );
  return rest;
}
