// SPDX-License-Identifier: EUPL-1.2
import { delimiter, dirname } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import { warnIfFurnaceStale } from '../core/furnace-staleness.js';
import type { MachCommandResult } from '../core/mach.js';
import {
  generateMozconfig,
  hasBuildArtifacts,
  hasRunnableBundle,
  watchWithOutput,
} from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import { toError } from '../utils/errors.js';
import { info, intro, outro, spinner, verbose } from '../utils/logger.js';
import { exec, findExecutable } from '../utils/process.js';

const WATCHMAN_PROBE_TIMEOUT_MS = 5000;

/**
 * Probes watchman by running `watchman --version`. A binary that exists
 * in PATH but cannot respond (corrupt install, server crashed mid-session,
 * permission denied on the state directory) would otherwise surface as a
 * confusing mid-watch failure. Returns the trimmed version string when
 * the probe succeeds. Throws a {@link GeneralError} with actionable
 * remediation when it does not.
 */
async function probeWatchman(): Promise<string> {
  try {
    const result = await exec('watchman', ['--version'], {
      timeout: WATCHMAN_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new GeneralError(
        `Watchman is installed but "watchman --version" exited ${result.exitCode}.\n\n` +
          (result.stderr.trim() ? `Output:\n${result.stderr.trim()}\n\n` : '') +
          'Re-install or repair watchman, then rerun "fireforge watch".'
      );
    }
    const version = result.stdout.trim();
    if (!version) {
      throw new GeneralError(
        'Watchman is installed but "watchman --version" produced no output. ' +
          'Re-install or repair watchman, then rerun "fireforge watch".'
      );
    }
    return version;
  } catch (error: unknown) {
    if (error instanceof GeneralError) throw error;
    throw new GeneralError(
      `Watchman is installed but did not respond within ${WATCHMAN_PROBE_TIMEOUT_MS}ms.\n\n` +
        `Underlying cause: ${toError(error).message}\n\n` +
        'Common fixes:\n' +
        '  - Restart watchman: "watchman shutdown-server" then retry\n' +
        "  - Check filesystem permissions on watchman's state directory\n" +
        '  - Re-install watchman if the binary is corrupt'
    );
  }
}

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

function hasWatchPermissionFailure(output: string): boolean {
  return /Operation not permitted|EPERM|EACCES/i.test(output);
}

/**
 * Builds the generic unsupported-watch failure message.
 *
 * @param exitCode - Exit code returned by `mach watch`
 * @param watchmanPath - Optional absolute path to the resolved watchman
 *   binary, surfaced in the guidance so the operator can see whether
 *   FireForge actually found one.
 * @returns User-facing failure guidance
 */
function buildUnsupportedWatchMessage(
  exitCode: number,
  watchmanPath: string | undefined,
  output = ''
): string {
  const watchmanLine = watchmanPath
    ? `  - FireForge resolved watchman at ${watchmanPath} and prepended its directory to the mach subprocess PATH. If mach still did not see it, ensure that path is stable between runs.\n`
    : '';
  const permissionLine = hasWatchPermissionFailure(output)
    ? '  - macOS may be blocking watchman or Terminal/Codex from reading the engine directory. Grant Full Disk Access or Files and Folders access to your terminal app and watchman, then restart watchman with "watchman shutdown-server".\n'
    : '';
  return (
    `Watch failed with exit code ${exitCode}. Check the output above for details.\n\n` +
    'Common causes:\n' +
    '  - watchman is not installed or not in PATH right now\n' +
    '  - watchman was installed only after the current obj-* directory was configured; delete obj-* and rebuild\n' +
    permissionLine +
    '  - mach watch is unsupported in the current objdir or build environment\n' +
    watchmanLine +
    '\n' +
    'If the failure referenced `watch-project` / `FasterBuildException: timed out`, watchman is likely reachable via `which watchman` from your shell but missing from the subprocess PATH. FireForge now prepends the resolved watchman directory automatically; confirm your watchman install is on a stable path (e.g. /opt/homebrew/bin/watchman on macOS).'
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
  await assertEngineExists(paths.engine);

  // Resolve the watchman binary to an absolute path up-front so we can (a)
  // refuse fast when it is missing and (b) prepend its directory to the mach
  // subprocess PATH. On macOS, `which watchman` from an interactive shell
  // returns `/opt/homebrew/bin/watchman`, but the Node subprocess PATH
  // frequently omits `/opt/homebrew/bin`, so the shell probe passes and
  // mach's `watch-project` call then times out on its own failed PATH
  // lookup. Threading the directory through the subprocess env fixes it.
  const watchmanPath = await findExecutable('watchman');
  if (!watchmanPath) {
    throw new GeneralError(
      'Watch mode requires watchman to be installed and available in PATH.\n\n' +
        'Install watchman first, then rerun "fireforge watch".'
    );
  }

  // Verify watchman actually responds: a binary that is in PATH but
  // unable to respond (broken install, crashed server, bad state dir
  // permissions) would otherwise surface as a confusing mid-build failure
  // instead of an actionable preflight error.
  await probeWatchman();

  // Check for build artifacts before starting watch
  // The mismatch rung rejects copied or relocated obj-* dirs whose mozinfo
  // metadata (topsrcdir, topobjdir, mozconfig) still points at a different
  // source tree. mach watch against stale metadata produces confusing errors.
  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, {
    label: 'Watch mode',
    requirement: 'Watch mode requires a completed build.',
    remediation:
      "Run 'fireforge build' first to create the initial build, then run 'fireforge watch'.",
    requireExisting: true,
  });

  // Report bundle state alongside the "Using build artifacts..." banner
  // so an operator watching a mid-build tree can see why `fireforge run`
  // would refuse right now while watch is still going. Watch remains
  // permissive (it exists to drive rebuilds), so this is informational.
  // The `hasBuildArtifacts` check already passed at this point, so
  // `objDir` is always defined.
  const bundleCheck = buildCheck.objDir
    ? await hasRunnableBundle(paths.engine, config.binaryName, buildCheck.objDir)
    : { runnable: false };
  const bundleSuffix = bundleCheck.runnable
    ? ' (bundle: runnable)'
    : ' (bundle: pending — watch will rebuild)';
  info(`Using build artifacts from ${buildCheck.objDir}/${bundleSuffix}`);

  // Advisory: warn when Furnace components have drifted since the last
  // apply so the user doesn't launch watch-mode builds with stale
  // components baked in. Mirrors the check in `fireforge run`: without
  // it, users editing a component then running `watch` would see their
  // change never surface in the rebuilt browser.
  await warnIfFurnaceStale(projectRoot);

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

  // Compose the subprocess env: start from the parent process env, then
  // prepend the resolved watchman directory to PATH so the mach subprocess
  // sees the same binary the probe just validated. Without it, a watchman
  // install under `/opt/homebrew/bin` is absent from the PATH Node inherits
  // on spawn and `mach watch` fails at the `watch-project` subscription
  // step.
  const watchmanDir = dirname(watchmanPath);
  const existingPath = process.env['PATH'] ?? '';
  const pathSegments = existingPath.split(delimiter).filter((segment) => segment.length > 0);
  // Both arms filter identically. The cast this replaced laundered
  // `string | undefined` on one arm while the other built the annotated shape
  // honestly.
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) baseEnv[key] = value;
  }
  const watchmanEnv: Record<string, string> = pathSegments.includes(watchmanDir)
    ? baseEnv
    : {
        ...baseEnv,
        PATH: [watchmanDir, ...pathSegments].join(delimiter),
      };
  verbose(`watch: resolved watchman at ${watchmanPath}; forwarding directory in subprocess PATH.`);

  let result: MachCommandResult;

  try {
    result = await watchWithOutput(paths.engine, { env: watchmanEnv });
  } catch (error: unknown) {
    throw new BuildError(
      'Watch process failed to start',
      'mach watch',
      error instanceof Error ? error : undefined
    );
  }

  // On Ctrl+C the bin signal handler now waits for the mach child to shut
  // down (waitForActiveChildShutdown) before exiting, so this continuation
  // can run and whitelist the SIGINT exit code, though the bin may still
  // win the race and terminate first. Both outcomes are acceptable.
  if (result.exitCode !== 0 && result.exitCode !== 130) {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (hasConfigureTimeWatchmanFailure(combinedOutput)) {
      throw new GeneralError(buildWatchmanConfigureTimeMessage());
    }

    // 130 is SIGINT (Ctrl+C), which is expected
    throw new BuildError(
      buildUnsupportedWatchMessage(result.exitCode, watchmanPath, combinedOutput),
      'mach watch'
    );
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
