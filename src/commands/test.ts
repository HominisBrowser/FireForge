// SPDX-License-Identifier: EUPL-1.2
import { join, resolve } from 'node:path';

import { readBuildBaseline, writeBuildBaseline } from '../core/build-baseline.js';
import type { TestPackagingCoverage } from '../core/build-baseline-types.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  assertEngineGenerationUnchanged,
  snapshotEngineGeneration,
} from '../core/engine-session-lock.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  hasRunnableBundle,
  runProtectedMachBuild,
  withBuildLock,
} from '../core/mach.js';
import {
  assertMarionettePortAvailable,
  ensureMarionettePortAvailable,
  extractForwardedMarionettePort,
  forwardedMachArgsIncludeMarionetteClient,
  shouldAutoForwardMarionettePortToMach,
} from '../core/marionette-port.js';
import {
  formatMarionettePreflightLine,
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../core/marionette-preflight.js';
import { buildHarnessCrashMessage } from '../core/test-harness-crash.js';
import { createPostRebuildFailureContext } from '../core/test-harness-output.js';
import {
  analyzeTestPathScopes,
  formatScopeNotice,
  type TestPathScope,
} from '../core/test-path-scope.js';
import { GeneralError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, success, verbose } from '../utils/logger.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { diagnoseShardOutcome, finalizeSingleRunOutcome } from './test-diagnose.js';
import {
  assertPathlessTestMode,
  assertTestModeCombinations,
  canaryTimeoutSeconds,
  classifyBeforeDispatch,
  type HarnessClassification,
  reportCanaryOutcome,
  resolveCanaryPath,
} from './test-modes.js';
import {
  DEFAULT_HARNESS_RETRIES,
  runShardedTests,
  runTestsWithRetries,
  type ShardGroup,
  type TestRunContext,
  type TestRunOutcome,
  type TestSuite,
} from './test-run.js';
import { enforceStaleBuildGate, enforceStaticComponentsGate } from './test-stale-gate.js';

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

/**
 * Picks the mach dispatch target for a (non-mixed) run. A single-suite run
 * auto-routes to the suite-specific command (`mach xpcshell-test` /
 * `mach mochitest`), which degrades a broken host resource monitor to a
 * warning instead of crashing generic `mach test` at startup (E1). Mixed runs
 * are rejected before this point; a path-less "run all" or an explicit
 * `--generic-mach-test` opt-out stays on the generic command.
 */
function resolveTestSuite(classification: HarnessClassification, forceGeneric: boolean): TestSuite {
  if (forceGeneric) return 'generic';
  if (classification.xpcshell.length > 0 && classification.nonXpcshell.length === 0) {
    return 'xpcshell';
  }
  if (classification.nonXpcshell.length > 0 && classification.xpcshell.length === 0) {
    return 'mochitest';
  }
  return 'generic';
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
  projectConfig: Awaited<ReturnType<typeof loadConfig>>,
  harnessRetries: number,
  testPackagingCoverage: TestPackagingCoverage
): Promise<void> {
  await withBuildLock(projectRoot, async () => {
    // Pass the previous baseline exactly like `fireforge build` does, so
    // auto-configure runs under the same conditions on both paths. The
    // pre-test build must never invalidate more of the objdir than a plain
    // `mach build faster` would (field incident: a failed pre-test build
    // was followed by a ~64-minute full rebuild where an incremental one
    // should have sufficed).
    const previousBaseline = await readBuildBaseline(projectRoot);
    await prepareBuildEnvironment(projectRoot, paths, projectConfig, { previousBaseline });
    const s = spinner('Running incremental build...');
    // The pre-test build routes through the same protected mach dispatch as
    // `fireforge build` / `build --ui`: in-venv resource-monitor guard plus
    // the uniform recognized-crash retry budget, with a fresh mach process
    // (and fresh guard install) per attempt. prepareBuildEnvironment runs
    // ONCE, outside the retry loop — retries never re-run mach configure.
    const result = await runProtectedMachBuild('faster', paths.engine, {
      retries: harnessRetries,
      onRetry: (signature, nextAttempt, maxAttempts) => {
        s.message(
          `Pre-test build hit a harness crash (${signature.reason}); ` +
            `retrying (attempt ${nextAttempt} of ${maxAttempts})...`
        );
      },
    });
    if (result.exitCode === 0) {
      s.stop('Build complete');
      // Same record, same failure tolerance as `fireforge build` /
      // `build --ui` (build.ts): a green pre-test build refreshes the
      // stale-build baseline so a later plain `fireforge test` over the
      // same files — in any invocation shape — is not refused. A failed
      // write never fails the run. The coverage claim is scoped to the
      // requested test paths, since a file-scoped `test --build` only
      // guarantees packaging for those manifests. The previous baseline is
      // passed through so a scoped write carries the static-components
      // anchor forward (a `mach build faster` does not rebake
      // components.conf into the compiled table).
      try {
        await writeBuildBaseline(
          projectRoot,
          paths.engine,
          projectConfig.binaryName,
          testPackagingCoverage,
          previousBaseline,
          testPackagingCoverage === 'full'
            ? 'fireforge test --build'
            : `fireforge test --build ${testPackagingCoverage.join(' ')}`
        );
      } catch (baselineError: unknown) {
        verbose(`Could not persist build baseline: ${toError(baselineError).message}`);
      }
      return;
    }
    s.error('Pre-test build failed');
    throw new BuildError(
      result.crashSignature
        ? buildHarnessCrashMessage(result.crashSignature, result.attempts, 'mach build faster')
        : 'Pre-test build failed',
      'mach build faster'
    );
  });
}

function logTestSelection(scopes: readonly TestPathScope[]): void {
  if (scopes.length > 0) {
    const labels = scopes.map((scope) =>
      scope.isDirectory && scope.testFileCount > 0
        ? `${scope.requestedPath} (${scope.testFileCount} test file${scope.testFileCount === 1 ? '' : 's'}, passed explicitly)`
        : scope.requestedPath
    );
    info(`Running tests: ${labels.join(', ')}`);
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
  forwardedPort: number | undefined,
  xpcshellOnly = false
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
  if (xpcshellOnly) {
    // Manifest classification says every requested path is xpcshell —
    // xpcshell ignores the browser Marionette path entirely, and the
    // mochitest client flags previously forwarded here made mach reject
    // the dispatch (FORGE F10).
    info(
      `--marionette-port=${options.marionettePort} applied to the preflight probe only: the requested paths are xpcshell-only, and xpcshell ignores the browser Marionette port. Not forwarding --setpref=marionette.port or --marionette to mach.`
    );
    return;
  }
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

async function ensureTestMarionettePortAvailable(
  port: number | undefined,
  binaryName: string,
  options: TestOptions,
  skip: { xpcshellOnly: boolean; doctor: boolean }
): Promise<void> {
  if (skip.xpcshellOnly && !skip.doctor) {
    // xpcshell does not bind the browser Marionette port, so a developer's
    // interactive browser holding 2828 must not kill an xpcshell run
    // (FORGE F10). --doctor keeps the preflight: its probe launches a
    // Marionette browser regardless of the requested harness.
    const message =
      'Skipping the Marionette stale-port preflight: all requested paths are xpcshell ' +
      '(xpcshell does not bind the browser Marionette port).';
    if (options.marionettePort !== undefined || options.killStaleMarionette === true) {
      info(message);
    } else {
      verbose(message);
    }
    return;
  }
  if (options.killStaleMarionette === true) {
    await ensureMarionettePortAvailable(port, { binaryName, killStaleBrowser: true });
    return;
  }
  await assertMarionettePortAvailable(port, { binaryName });
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
  assertPathlessTestMode(testPaths, options);

  const buildCheck = await assertTestBuildArtifacts(paths.engine);

  // Load the project config once so both the build and the port
  // probe have access to `binaryName` (the port probe uses it to
  // recognise a fork-branded browser holding the Marionette port).
  const projectConfig = await loadConfig(projectRoot);
  const canaryPath = resolveCanaryPath(options, projectConfig);
  assertTestModeCombinations(testPaths, options, canaryPath);

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

  const harnessRetries = options.harnessRetries ?? DEFAULT_HARNESS_RETRIES;

  // Normalized engine-relative request paths, hoisted above the build/stale
  // gate: the pre-test build records them as the packaging-coverage claim,
  // and the --allow-stale-build path checks the request against the
  // recorded coverage. (Existence is still asserted later, after the gate —
  // stale/coverage refusals keep precedence over missing-path errors.)
  const requestedPaths = canaryPath !== undefined ? [canaryPath] : testPaths;
  const normalizedPaths = requestedPaths.map((p) => stripEnginePrefix(p).trim());

  const { classification, xpcshellOnly } = await classifyBeforeDispatch(
    paths.engine,
    normalizedPaths
  );

  // Run incremental build if requested
  if (options.build) {
    // A path-less `test --build` runs (and packages for) the full suite;
    // a scoped invocation only vouches for the requested paths. A SCOPED
    // rebuild also cannot regenerate the compiled StaticComponents table,
    // so it runs the components.conf gate up-front (the path-less shape
    // refreshes the anchor itself and skips it).
    const coverage: TestPackagingCoverage = normalizedPaths.length === 0 ? 'full' : normalizedPaths;
    if (normalizedPaths.length > 0) {
      const previousBaseline = await readBuildBaseline(projectRoot);
      await enforceStaticComponentsGate(paths.engine, previousBaseline, options);
    }
    await runPreTestBuild(projectRoot, paths, projectConfig, harnessRetries, coverage);
    info('');
  } else {
    await enforceStaleBuildGate(projectRoot, paths.engine, options, normalizedPaths);
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
  await ensureTestMarionettePortAvailable(effectivePort, projectConfig.binaryName, options, {
    xpcshellOnly,
    doctor: options.doctor === true,
  });

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

  await assertTestPathsExist(paths.engine, normalizedPaths);
  const suite = resolveTestSuite(classification, options.genericMachTest === true);
  const forwardedMachArgs =
    options.machArg && options.machArg.length > 0
      ? filterRedundantXpcshellFlavorArgs(options.machArg, classification)
      : [];

  const extraArgs: string[] = [];

  if (options.headless) {
    extraArgs.push('--headless');
  }
  if (options.auto === true) {
    extraArgs.push('--auto');
  }
  if (canaryPath !== undefined) {
    extraArgs.push(`--timeout=${String(canaryTimeoutSeconds(projectConfig))}`);
  }

  // --mach-arg is a verbatim passthrough for upstream mach/xpcshell/mochitest
  // flags FireForge does not model directly (see the xpcshell appdir hint
  // above for the motivating case). Appended AFTER --headless so mach sees
  // the FireForge-managed flags first and the escape-valve ones last, which
  // keeps the override precedence predictable.
  if (forwardedMachArgs.length > 0) {
    extraArgs.push(...forwardedMachArgs);
  }

  appendMarionetteForwardingArgs(extraArgs, options, forwardedPort, xpcshellOnly);

  // Directory arguments mean EXACTLY that directory: mozbuild's test
  // resolver matches paths by string prefix, so a bare directory arg
  // silently swept in prefix-named siblings (152.0b7 → 153.0b8 drill:
  // `…/test/hominis` also ran `…/test/hominis-tiles`, 1224 tests instead
  // of ~200, with no indication the scope widened). Each directory
  // argument dispatches as its enumerated explicit test-file list — a
  // file list cannot prefix-match a sibling (0.35.0's trailing-`/`
  // normalization turned out to be cosmetic on Firefox 153's mach; field
  // verification showed the sibling still ran while the echo claimed it
  // was excluded). Any prefix-siblings are echoed so the narrowed scope
  // is visible. Classification above intentionally used the raw
  // argument forms; only the mach dispatch needs the exact-match shape.
  const scopes = await analyzeTestPathScopes(paths.engine, normalizedPaths);
  const dispatchGroups: ShardGroup[] = scopes.map((scope) => ({
    label: scope.requestedPath,
    paths: scope.dispatchPaths,
  }));
  for (const scope of scopes) {
    const notice = formatScopeNotice(scope);
    if (notice) info(notice);
  }

  // xpcshell appdir auto-injection happens per harness invocation inside
  // `runTestsWithRetries` (src/commands/test-run.ts) so sharded runs probe
  // the manifest for each file individually. See src/core/xpcshell-appdir.ts
  // for the full motivation.
  logTestSelection(scopes);

  const perfSampleEnv = buildPerfSampleEnv(
    projectRoot,
    projectConfig.binaryName,
    options.perfSamples
  );

  const runCtx: TestRunContext = {
    engineDir: paths.engine,
    objDir: buildCheck.objDir,
    classification,
    suite,
    baseExtraArgs: extraArgs,
    harnessRetries,
    headless: options.headless === true,
    ...(perfSampleEnv ? { env: perfSampleEnv } : {}),
  };
  const postRebuildContext = options.build
    ? createPostRebuildFailureContext('fireforge test --build', normalizedPaths)
    : undefined;

  // Multi-argument requests shard into sequential harness runs by default
  // (field report C3): one shared mochitest profile across files bleeds
  // pref/media-query state into later files. Sharding is per path
  // ARGUMENT — a directory argument keeps its enumerated files together
  // in one invocation, preserving the one-browser-instance semantics of
  // a directory run. --no-shard restores the combined invocation. The
  // default must not be SILENT (drill finding: a two-file cross-file
  // pollution repro "passed" because the headed comparison run was
  // sharded without saying so, briefly misattributing a suite-context
  // bug to an upstream headless regression), so a one-line notice states
  // what sharding does and does not exercise.
  if (canaryPath === undefined && dispatchGroups.length > 1 && options.shard !== false) {
    info(
      `Sharding: running ${dispatchGroups.length} test path arguments in isolated browser instances ` +
        '(one mach invocation per argument; a directory argument keeps its files in one instance). ' +
        'Cross-argument state is NOT exercised — pass --no-shard for a combined single-instance run.'
    );
    const generationBefore = await snapshotEngineGeneration(paths.engine);
    try {
      await runShardedTests(runCtx, dispatchGroups, (outcome, label) =>
        diagnoseShardOutcome(outcome, label, projectConfig.binaryName, postRebuildContext)
      );
    } finally {
      await assertEngineGenerationUnchanged(paths.engine, generationBefore);
    }
    return;
  }

  const combinedDispatchPaths = dispatchGroups.flatMap((group) => group.paths);
  let outcome: TestRunOutcome;
  const generationBefore = await snapshotEngineGeneration(paths.engine);
  try {
    outcome = await runTestsWithRetries(runCtx, combinedDispatchPaths);
  } catch (error: unknown) {
    throw new BuildError(
      'Test process failed to start',
      'mach test',
      error instanceof Error ? error : undefined
    );
  } finally {
    await assertEngineGenerationUnchanged(paths.engine, generationBefore);
  }

  if (canaryPath !== undefined) {
    reportCanaryOutcome(outcome);
    return;
  }

  finalizeSingleRunOutcome(
    outcome,
    normalizedPaths,
    projectConfig.binaryName,
    postRebuildContext,
    options.headless === true
  );
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
