// SPDX-License-Identifier: EUPL-1.2
/**
 * The `fireforge test` checks that run BEFORE the engine session lock.
 *
 * Everything here reads, never writes, so none of it needs the lock, and
 * each check used to cost a full place in the lock queue before it could
 * refuse:
 *
 *  - a missing launchable binary (a peer's interrupted build) refused only
 *    after the wait, in every session, with nothing naming the cause;
 *  - the named-file checkJs pass refused an `Element | null` after an
 *    eighteen-minute queue;
 *  - `--wait-browser` and `--wait-port` spent their budget holding the
 *    lock, so every peer queued behind a run that was doing nothing.
 *
 * The in-lock ladder in `test.ts` still runs in full afterwards. That is
 * the "re-check once under the lock": the waits this pass spent are
 * stripped from the options it returns, so the in-lock browser and port
 * checks probe once instead of waiting again.
 */

import { join } from 'node:path';

import { describeBuildRunState, readBuildRunState } from '../core/build-run-record.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import { hasBuildArtifacts, hasRunnableBundle } from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import {
  assertMarionettePortAvailable,
  ensureLaunchableBrowserNotRunning,
  extractForwardedMarionettePort,
} from '../core/marionette-port.js';
import { ensureMochitestServerPortAvailable } from '../core/mochitest-server-port.js';
import { waitBeforeLock } from '../core/preflight-wait.js';
import { PreflightRefusalError } from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { info } from '../utils/logger.js';
import { resolveWaitLockSeconds } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { checkRequestedTestTypes } from './test-checkjs.js';
import { assertPathlessTestMode, classifyBeforeDispatch, resolveCanaryPath } from './test-modes.js';

/**
 * Resolves the launchable binary a test run needs, or refuses naming why
 * it is missing. The cause comes from the build run record, which any
 * session's build writes, so a session that never ran the build can still
 * say "a peer's build was interrupted" rather than only "the binary is
 * missing".
 *
 * @param projectRoot - Project root
 * @param engineDir - Absolute engine directory
 * @param binaryName - Configured binary name
 * @param objDir - Active objdir, when one exists
 * @returns The engine-relative launchable path, or undefined without an objdir
 */
export async function resolveLaunchablePathForTests(
  projectRoot: string,
  engineDir: string,
  binaryName: string,
  objDir: string | undefined
): Promise<string | undefined> {
  if (!objDir) return undefined;
  const bundleCheck = await hasRunnableBundle(engineDir, binaryName, objDir);
  if (bundleCheck.runnable) return bundleCheck.expectedPath;
  const expectedSuffix = bundleCheck.expectedPath
    ? ` (expected at engine/${bundleCheck.expectedPath})`
    : '';
  const cause = describeBuildRunState(await readBuildRunState(projectRoot));
  throw new PreflightRefusalError(
    `Tests require a complete launchable build${expectedSuffix}. ` +
      'The obj-*/dist/ tree exists but the launchable binary is missing' +
      (cause !== undefined
        ? `.\n\n${cause}\n\n`
        : ' — typically the result of an interrupted or partially failed `fireforge build`.\n\n') +
      'Run "fireforge build" again and let it finish before retrying "fireforge test".',
    'no-launchable-binary'
  );
}

/** Build-artifact preflight wording for `fireforge test`. */
export const TEST_BUILD_PREFLIGHT = {
  label: 'Tests',
  requirement: 'Tests require a completed build.',
  remediation: "Run 'fireforge build' first, then run 'fireforge test'.",
  requireExisting: true,
} as const;

/**
 * The head of the in-lock ladder, run early: argument shape, engine, build
 * artifacts and config. Each refuses with exactly the message it gives
 * under the lock. Returns undefined when there is no objdir to check
 * further.
 */
async function loadPreLockContext(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions
): Promise<{ paths: ProjectPaths; config: FireForgeConfig; objDir: string } | undefined> {
  assertPathlessTestMode(testPaths, options);
  const paths = getProjectPaths(projectRoot);
  await assertEngineExists(paths.engine);
  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, TEST_BUILD_PREFLIGHT);
  const config = await loadConfig(projectRoot);
  return buildCheck.objDir === undefined ? undefined : { paths, config, objDir: buildCheck.objDir };
}

/**
 * Runs the lock-free checks and waits, and returns the options the in-lock
 * run should use: with `waitBrowser`/`waitPort` removed when their budget
 * was already spent here.
 *
 * @param projectRoot - Project root
 * @param testPaths - Requested test paths
 * @param options - Parsed test options
 */
export async function runTestPreLockPreflight(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions
): Promise<TestOptions> {
  const context = await loadPreLockContext(projectRoot, testPaths, options);
  if (context === undefined) return options;
  const { paths, config, objDir } = context;

  let launchablePath: string | undefined;
  try {
    launchablePath = await resolveLaunchablePathForTests(
      projectRoot,
      paths.engine,
      config.binaryName,
      objDir
    );
  } catch (error: unknown) {
    // A build in progress holds the engine lock and relinks the bundle
    // before it lets go, so this run queues behind it rather than refusing.
    if ((await readBuildRunState(projectRoot)).kind !== 'running') throw error;
    info('The launchable binary is missing while a build runs; queueing behind it.');
  }

  const canaryPath = resolveCanaryPath(options, config);
  const normalizedPaths = (canaryPath !== undefined ? [canaryPath] : testPaths).map((path) =>
    stripEnginePrefix(path).trim()
  );
  if (options.build === true || options.buildOnly === true) {
    await checkRequestedTestTypes(paths, config, normalizedPaths);
  }

  return waitForResourcesBeforeLock(paths.engine, config, options, {
    launchablePath,
    normalizedPaths,
  });
}

/** `options` without one wait budget, which this pass already spent. */
function withoutOption(options: TestOptions, key: 'waitBrowser' | 'waitPort'): TestOptions {
  const rest = { ...options };
  if (key === 'waitBrowser') delete rest.waitBrowser;
  else delete rest.waitPort;
  return rest;
}

/**
 * Spends `--wait-browser` and `--wait-port` before the lock, mirroring
 * which in-lock checks would apply to this run, and strips each budget it
 * spent from the returned options.
 */
async function waitForResourcesBeforeLock(
  engineDir: string,
  config: FireForgeConfig,
  options: TestOptions,
  request: { launchablePath: string | undefined; normalizedPaths: string[] }
): Promise<TestOptions> {
  if (options.waitBrowser === undefined && options.waitPort === undefined) return options;
  let xpcshellOnly: boolean;
  try {
    ({ xpcshellOnly } = await classifyBeforeDispatch(engineDir, request.normalizedPaths, {
      allowMixed: true,
    }));
  } catch {
    return options;
  }
  const kill = options.killStaleMarionette === true;
  let result = options;

  const building = options.build === true || options.buildOnly === true;
  if (
    options.waitBrowser !== undefined &&
    request.launchablePath !== undefined &&
    (building || !xpcshellOnly)
  ) {
    const binary = join(engineDir, request.launchablePath);
    await waitBeforeLock(
      () => ensureLaunchableBrowserNotRunning(binary),
      resolveWaitLockSeconds(options.waitBrowser),
      // A stale browser the run may reap is not worth waiting out; the
      // in-lock check terminates it.
      kill ? ['stale-browser'] : []
    );
    result = withoutOption(result, 'waitBrowser');
  }

  // Port waits stay under the lock with --kill-stale-marionette: a stale
  // listener reads as busy until the in-lock pass reaps it, so waiting it
  // out here would only burn the budget.
  if (options.waitPort !== undefined && options.buildOnly !== true && !kill) {
    const seconds = resolveWaitLockSeconds(options.waitPort);
    if (!xpcshellOnly) {
      await waitBeforeLock(
        () => ensureMochitestServerPortAvailable(undefined, { engineDir }),
        seconds
      );
    }
    if (!xpcshellOnly || options.doctor === true) {
      const port = options.marionettePort ?? extractForwardedMarionettePort(options.machArg ?? []);
      await waitBeforeLock(
        () => assertMarionettePortAvailable(port, { binaryName: config.binaryName }),
        seconds
      );
    }
    result = withoutOption(result, 'waitPort');
  }
  return result;
}
