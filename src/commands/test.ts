// SPDX-License-Identifier: EUPL-1.2
import { join, resolve } from 'node:path';

import { Command } from 'commander';

import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  hasRunnableBundle,
  withBuildLock,
} from '../core/mach.js';
import {
  assertMarionettePortAvailable,
  extractForwardedMarionettePort,
  forwardedMachArgsIncludeMarionetteClient,
  shouldAutoForwardMarionettePortToMach,
} from '../core/marionette-port.js';
import {
  formatMarionettePreflightLine,
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../core/marionette-preflight.js';
import { createPostRebuildFailureContext } from '../core/test-harness-output.js';
import { checkStaleBuildForTest, formatStaleBuildWarning } from '../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../core/xpcshell-appdir.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import type { TestOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { diagnoseShardOutcome, finalizeSingleRunOutcome } from './test-diagnose.js';
import {
  DEFAULT_HARNESS_RETRIES,
  runShardedTests,
  runTestsWithRetries,
  type TestRunContext,
  type TestRunOutcome,
} from './test-run.js';

async function assertTestPathsExist(engineDir: string, testPaths: string[]): Promise<void> {
  const missingPaths: string[] = [];

  for (const testPath of testPaths) {
    if (!(await pathExists(join(engineDir, testPath)))) {
      missingPaths.push(testPath);
    }
  }

  if (missingPaths.length === 0) {
    return;
  }

  throw new GeneralError(
    `Test path${missingPaths.length === 1 ? '' : 's'} not found under engine/: ${missingPaths.join(', ')}\n\n` +
      'If you expected these files to come from your patch stack, run "fireforge import" first.'
  );
}

interface HarnessClassification {
  xpcshell: string[];
  nonXpcshell: string[];
}

async function classifyTestHarnesses(
  engineDir: string,
  normalizedPaths: readonly string[]
): Promise<HarnessClassification> {
  const result: HarnessClassification = { xpcshell: [], nonXpcshell: [] };
  for (const testPath of normalizedPaths) {
    const manifest = await findNearestXpcshellManifest(engineDir, testPath);
    if (manifest) {
      result.xpcshell.push(testPath);
    } else {
      result.nonXpcshell.push(testPath);
    }
  }
  return result;
}

function buildMixedHarnessMessage(classification: HarnessClassification): string {
  return (
    'FireForge cannot run xpcshell and browser/mochitest paths in the same mach invocation.\n\n' +
    'Split this into separate `fireforge test` commands so each manifest selects its own harness:\n' +
    `  - xpcshell: ${classification.xpcshell.join(', ')}\n` +
    `  - browser/mochitest: ${classification.nonXpcshell.join(', ')}`
  );
}

function filterRedundantXpcshellFlavorArgs(
  machArgs: readonly string[],
  classification: HarnessClassification
): string[] {
  if (classification.xpcshell.length === 0 || classification.nonXpcshell.length > 0) {
    return [...machArgs];
  }

  const filtered: string[] = [];
  for (let i = 0; i < machArgs.length; i += 1) {
    const arg = machArgs[i] ?? '';
    if (/^--flavor=xpcshell(?:-tests)?$/.test(arg)) {
      continue;
    }
    if (arg === '--flavor' && /^xpcshell(?:-tests)?$/.test(machArgs[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

async function resolveLaunchablePathForTests(
  engineDir: string,
  binaryName: string,
  objDir: string | undefined
): Promise<string | undefined> {
  if (!objDir) return undefined;
  const bundleCheck = await hasRunnableBundle(engineDir, binaryName, objDir);
  if (!bundleCheck.runnable) {
    const expectedSuffix = bundleCheck.expectedPath
      ? ` (expected at engine/${bundleCheck.expectedPath})`
      : '';
    throw new GeneralError(
      `Tests require a complete launchable build${expectedSuffix}. ` +
        'The obj-*/dist/ tree exists but the launchable binary is missing — typically the result of an interrupted or partially failed `fireforge build`.\n\n' +
        'Run "fireforge build" again and let it finish before retrying "fireforge test".'
    );
  }
  return bundleCheck.expectedPath;
}

async function runPreTestBuild(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  projectConfig: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  await withBuildLock(projectRoot, async () => {
    await prepareBuildEnvironment(projectRoot, paths, projectConfig);
    const s = spinner('Running incremental build...');
    const buildResult = await buildUI(paths.engine);
    if (buildResult.exitCode !== 0) {
      s.error('Pre-test build failed');
      throw new BuildError('Pre-test build failed', 'mach build faster');
    }
    s.stop('Build complete');
  });
}

function logTestSelection(normalizedPaths: readonly string[]): void {
  if (normalizedPaths.length > 0) {
    info(`Running tests: ${normalizedPaths.join(', ')}`);
  } else {
    info('Running all tests...');
  }
  info('');
}

/**
 * Validates the build-artifact preconditions for running tests: rejects
 * ambiguous multi-objdir checkouts, platform-mismatched artifacts, and
 * missing/incomplete builds with the actionable message for each. Returns
 * the successful artifact probe for downstream objdir use.
 */
async function assertTestBuildArtifacts(
  engineDir: string
): Promise<Awaited<ReturnType<typeof hasBuildArtifacts>>> {
  const buildCheck = await hasBuildArtifacts(engineDir);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  const mismatchMessage = buildArtifactMismatchMessage(engineDir, buildCheck, 'Tests');
  if (mismatchMessage) {
    throw new GeneralError(mismatchMessage);
  }
  if (!buildCheck.exists) {
    const detail = buildCheck.objDir
      ? `Build artifacts incomplete in ${buildCheck.objDir}/`
      : 'No build artifacts found (obj-*/ directory missing)';
    throw new GeneralError(
      `Tests require a completed build. ${detail}\n\n` +
        "Run 'fireforge build' first, then run 'fireforge test'."
    );
  }

  return buildCheck;
}

/**
 * Runs the `--doctor` marionette handshake probe. With no test paths the
 * probe is the entire command (returns `'stop'` after reporting); with
 * paths it gates the mach invocation — a FAIL throws before mach runs.
 */
async function runDoctorPreflight(args: {
  engineDir: string;
  effectivePort: number | undefined;
  hasTestPaths: boolean;
  objDir: string | undefined;
  binaryName: string;
  launchablePath: string | undefined;
}): Promise<'stop' | 'continue'> {
  const { engineDir, effectivePort, hasTestPaths, objDir, binaryName, launchablePath } = args;
  // Write the "Running marionette preflight..." banner via
  // `process.stdout.write` directly before `info()` so non-TTY captures
  // always see the banner even if clack's renderer defers output in
  // pipe mode. `info()` is still called so TTY users keep the normal
  // clack box-drawing framing.
  process.stdout.write('Running marionette preflight...\n');
  info('Running marionette preflight...');
  const preflight =
    effectivePort !== undefined
      ? await runMarionettePreflight(engineDir, { port: effectivePort })
      : await runMarionettePreflight(engineDir);
  // 2026-04-24 eval Finding 7: the pre-0.18.1 code used
  // `success()` + `outro()` + a direct `process.stdout.write` as a
  // belt-and-suspenders but still reproducibly dropped the PASS summary
  // under non-TTY capture (observed: `tee`-wrapped eval output saw only
  // the intro). The fix writes the authoritative PASS/FAIL line via
  // `process.stdout.write` as the very first output after the probe
  // returns, so the captured stream has an unambiguous summary no
  // matter what clack does on top. The clack-rendered banner
  // (`info`/`warn`) is retained so TTY users keep the visual framing.
  const directLine = formatMarionettePreflightLine(preflight);
  process.stdout.write(`${directLine}\n`);
  process.stdout.write(
    `Marionette preflight environment: objdir=${objDir ?? '(none)'}; binary=${binaryName}; app=${launchablePath ? `engine/${launchablePath}` : '(unknown)'}; port=${effectivePort ?? 2828}; elapsed=${preflight.durationMs}ms\n`
  );
  reportMarionettePreflight(preflight);
  if (!hasTestPaths) {
    if (!preflight.ok) {
      throw new GeneralError('Marionette preflight reported FAIL — see output above.');
    }
    success(directLine);
    outro('Test completed');
    return 'stop';
  }
  if (!preflight.ok) {
    throw new GeneralError(
      'Marionette preflight reported FAIL — see output above. Aborting before mach test runs.'
    );
  }
  return 'continue';
}

/**
 * Auto-forwards `--marionette-port` to mach (`--setpref=marionette.port`
 * for the listener, `--marionette=127.0.0.1:<n>` for the mochitest
 * client), skipping each piece the operator already forwarded via
 * `--mach-arg` and the xpcshell flavor that ignores the pref entirely.
 * Mutates `extraArgs` in place.
 */
function appendMarionetteForwardingArgs(
  extraArgs: string[],
  options: TestOptions,
  forwardedPort: number | undefined
): void {
  // Auto-forward the Marionette port to mach when `--marionette-port` is
  // set. `--setpref=marionette.port=<n>` configures where the browser
  // listener binds; `--marionette=127.0.0.1:<n>` tells the mochitest harness
  // client to connect there (default client is 127.0.0.1:2828). xpcshell
  // ignores both for browser Marionette.
  //
  // Skip setpref forwarding when the operator already supplied an equivalent
  // arg via `--mach-arg` — duplicates would be confusing without changing
  // semantics. Skip when mach args explicitly request `--flavor=xpcshell`
  // (or `xpcshell-tests`): the preflight still honours `--marionette-port`,
  // but mach does not use the marionette.port pref on that harness. Any
  // other arg shape still forwards so toolkit widget paths and mixed suites
  // stay aligned with the probe without duplicate `--mach-arg` flags.
  //
  // Skip auto `--marionette=...` when `--mach-arg` already includes a client
  // `--marionette=...` (or two-token `--marionette host:port`).
  if (options.marionettePort === undefined) return;
  {
    const operatorAlreadyForwarded = forwardedPort !== undefined;
    const machArgs = options.machArg ?? [];
    if (operatorAlreadyForwarded) {
      info(
        `--marionette-port=${options.marionettePort} set, but the same port is already forwarded via --mach-arg; skipping auto-forward.`
      );
    } else if (shouldAutoForwardMarionettePortToMach(machArgs)) {
      extraArgs.push(`--setpref=marionette.port=${options.marionettePort}`);
    } else {
      info(
        `--marionette-port=${options.marionettePort} applied to the preflight probe, but --flavor=xpcshell is set — mach is not auto-configured with --setpref=marionette.port or --marionette (xpcshell ignores the browser Marionette path). Pass --mach-arg --setpref=marionette.port=${options.marionettePort} explicitly if you still need mach to see the port.`
      );
    }

    if (
      shouldAutoForwardMarionettePortToMach(machArgs) &&
      !forwardedMachArgsIncludeMarionetteClient(machArgs)
    ) {
      extraArgs.push(`--marionette=127.0.0.1:${options.marionettePort}`);
    }
  }
}

/**
 * Runs the test command to execute mach tests.
 * @param projectRoot - Root directory of the project
 * @param testPaths - Test file or directory paths
 * @param options - Test options
 */
export async function testCommand(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions = {}
): Promise<void> {
  intro('FireForge Test');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  const buildCheck = await assertTestBuildArtifacts(paths.engine);

  // Load the project config once so both the build and the port
  // probe have access to `binaryName` (the port probe uses it to
  // recognise a fork-branded browser holding the Marionette port).
  const projectConfig = await loadConfig(projectRoot);

  // `hasBuildArtifacts` only confirms `obj-*/dist/` exists; a partial
  // build (linker failed, packaging step interrupted, etc.) can satisfy
  // that check without ever writing the launchable binary the marionette
  // preflight needs to spawn. `fireforge run` already uses
  // `hasRunnableBundle` to fail fast with a precise message; mirror that
  // here so `test --doctor` against an incomplete build surfaces the
  // missing-bundle path instead of a cryptic `Browser process exited
  // during spawn (exit code 1, signal none). stderr tail: (empty)`.
  const launchablePath = await resolveLaunchablePathForTests(
    paths.engine,
    projectConfig.binaryName,
    buildCheck.objDir
  );

  // Run incremental build if requested
  if (options.build) {
    await runPreTestBuild(projectRoot, paths, projectConfig);
    info('');
  } else {
    // Stale-build preflight — when --build was NOT requested, detect
    // packageable engine edits since the last successful `fireforge build`
    // and warn UP-FRONT. Without this, edits to chrome / packaged resources
    // surface only as a cryptic `NS_ERROR_FILE_NOT_FOUND` inside xpcshell
    // after mach test has already launched (see motivating case in
    // `core/test-stale-check.ts`). The check is warn-only so a fork that
    // rebuilt out-of-band (no FireForge-recorded baseline update) is not
    // blocked from running tests.
    const stale = await checkStaleBuildForTest(projectRoot, paths.engine);
    if (stale.stale) {
      warn(formatStaleBuildWarning(stale));
    }
  }

  // Resolve the effective Marionette port. Operator precedence:
  //   1. `--marionette-port` (first-class option, parsed at the CLI layer)
  //   2. forwarded `--mach-arg --marionette-port=NNNN` /
  //      `--mach-arg --setpref=marionette.port=NNNN`
  //   3. fall back to `DEFAULT_MARIONETTE_PORT` semantics inside the probes
  //      (passed as `undefined`).
  // Without (2), an operator working around a stale listener via the
  // documented `--mach-arg --marionette-port=NNNN` workaround would still
  // hit the wrapper preflight refusing on 2828 before the forwarded arg
  // ever reached mach.
  const forwardedPort = options.machArg
    ? extractForwardedMarionettePort(options.machArg)
    : undefined;
  const effectivePort = options.marionettePort ?? forwardedPort;

  // Stale-browser probe: an interrupted earlier test run can leave a
  // Firefox/ForgeFresh/fork instance listening on the Marionette
  // control port, which breaks the next mach test launch with a
  // bind error that points nowhere near the real cause. Raise a
  // targeted refusal up front instead of letting mach surface the
  // generic bind failure. 2026-04-21 eval (Finding #20): a stale
  // `-marionette` process from `fresh/` poisoned a later test run in
  // the sibling `mybrowser/` workspace.
  await assertMarionettePortAvailable(effectivePort, { binaryName: projectConfig.binaryName });

  if (options.doctor) {
    const doctorOutcome = await runDoctorPreflight({
      engineDir: paths.engine,
      effectivePort,
      hasTestPaths: testPaths.length > 0,
      objDir: buildCheck.objDir,
      binaryName: projectConfig.binaryName,
      launchablePath,
    });
    if (doctorOutcome === 'stop') return;
  }

  const normalizedPaths = testPaths.map((p) => stripEnginePrefix(p).trim());
  await assertTestPathsExist(paths.engine, normalizedPaths);
  const classification = await classifyTestHarnesses(paths.engine, normalizedPaths);
  if (classification.xpcshell.length > 0 && classification.nonXpcshell.length > 0) {
    throw new GeneralError(buildMixedHarnessMessage(classification));
  }
  const forwardedMachArgs =
    options.machArg && options.machArg.length > 0
      ? filterRedundantXpcshellFlavorArgs(options.machArg, classification)
      : [];

  const extraArgs: string[] = [];

  if (options.headless) {
    extraArgs.push('--headless');
  }

  // --mach-arg is a verbatim passthrough for upstream mach/xpcshell/mochitest
  // flags FireForge does not model directly (see the xpcshell appdir hint
  // above for the motivating case). Appended AFTER --headless so mach sees
  // the FireForge-managed flags first and the escape-valve ones last, which
  // keeps the override precedence predictable.
  if (forwardedMachArgs.length > 0) {
    extraArgs.push(...forwardedMachArgs);
  }

  appendMarionetteForwardingArgs(extraArgs, options, forwardedPort);

  // xpcshell appdir auto-injection happens per harness invocation inside
  // `runTestsWithRetries` (src/commands/test-run.ts) so sharded runs probe
  // the manifest for each file individually. See src/core/xpcshell-appdir.ts
  // for the full motivation.
  logTestSelection(normalizedPaths);

  const perfSampleEnv = buildPerfSampleEnv(
    projectRoot,
    projectConfig.binaryName,
    options.perfSamples
  );

  const runCtx: TestRunContext = {
    engineDir: paths.engine,
    objDir: buildCheck.objDir,
    classification,
    baseExtraArgs: extraArgs,
    harnessRetries: options.harnessRetries ?? DEFAULT_HARNESS_RETRIES,
    ...(perfSampleEnv ? { env: perfSampleEnv } : {}),
  };
  const postRebuildContext = options.build
    ? createPostRebuildFailureContext('fireforge test --build', normalizedPaths)
    : undefined;

  // Multi-file requests shard into sequential single-file harness runs by
  // default (field report C3): one shared mochitest profile across files
  // bleeds pref/media-query state into later files. --no-shard restores
  // the combined invocation.
  if (normalizedPaths.length > 1 && options.shard !== false) {
    await runShardedTests(runCtx, normalizedPaths, (outcome, path) =>
      diagnoseShardOutcome(outcome, path, projectConfig.binaryName, postRebuildContext)
    );
    return;
  }

  let outcome: TestRunOutcome;
  try {
    outcome = await runTestsWithRetries(runCtx, normalizedPaths);
  } catch (error: unknown) {
    throw new BuildError(
      'Test process failed to start',
      'mach test',
      error instanceof Error ? error : undefined
    );
  }

  finalizeSingleRunOutcome(outcome, normalizedPaths, projectConfig.binaryName, postRebuildContext);
}

/**
 * Builds the perf-sample env contract for the harness run (field report
 * C4): `--perf-samples <path>` exports `<BINARYNAME>_PERF_SAMPLE_JSON`
 * naming the artifact file a budget checker consumes after the run.
 */
function buildPerfSampleEnv(
  projectRoot: string,
  binaryName: string,
  perfSamples: string | undefined
): Record<string, string> | undefined {
  if (!perfSamples) return undefined;
  const envName = `${binaryName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PERF_SAMPLE_JSON`;
  const artifactPath = resolve(projectRoot, perfSamples);
  info(`Perf sample contract: ${envName}=${artifactPath}`);
  return { [envName]: artifactPath };
}

/** Registers the test command on the CLI program. */
export function registerTest(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('test [paths...]')
    .description('Run tests via mach test')
    .option('--headless', 'Run tests in headless mode')
    .option('--build', 'Run incremental UI build before testing')
    .option(
      '--doctor',
      'Run a marionette handshake preflight before tests (exit 1 on FAIL). With no paths, runs the preflight only.'
    )
    .option(
      '--mach-arg <arg>',
      'Forward this argument verbatim to `mach test` (repeatable). Escape valve for upstream xpcshell/mochitest flags FireForge does not model.',
      (value: string, acc: string[]) => {
        acc.push(value);
        return acc;
      },
      [] as string[]
    )
    .option(
      '--harness-retries <n>',
      `Retry budget for recognized harness crashes (resource-monitor tracebacks, pre-test hangs, post-green shutdown re-entry). 0 disables retries. Default: ${String(DEFAULT_HARNESS_RETRIES)}.`,
      (raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0 || n > 10) {
          throw new GeneralError(`--harness-retries must be an integer in 0..10 (got "${raw}")`);
        }
        return n;
      }
    )
    .option(
      '--no-shard',
      'Run multiple test paths in one combined mach invocation instead of sequential per-file shards'
    )
    .option(
      '--perf-samples <path>',
      'Publish a perf-sample artifact path to the harness via <BINARYNAME>_PERF_SAMPLE_JSON (resolved against the project root)'
    )
    .option(
      '--marionette-port <port>',
      'Override the Marionette control port (default 2828) for the stale-browser probe, the --doctor preflight, and (unless --mach-arg includes --flavor=xpcshell) auto-forwarded mach args: --setpref=marionette.port=<n> (browser listener) and --marionette=127.0.0.1:<n> (mochitest client). Omits the client flag when --mach-arg already sets --marionette. Use when 2828 is busy or CI assigns another port.',
      (raw: string) => {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1 || n > 65535) {
          throw new GeneralError(`--marionette-port must be an integer in 1..65535 (got "${raw}")`);
        }
        return n;
      }
    )
    .action(
      withErrorHandling(
        async (
          paths: string[],
          options: {
            headless?: boolean;
            build?: boolean;
            doctor?: boolean;
            machArg?: string[];
            marionettePort?: number;
            harnessRetries?: number;
            shard?: boolean;
            perfSamples?: string;
          }
        ) => {
          await testCommand(getProjectRoot(), paths, pickDefined(options));
        }
      )
    );
}
