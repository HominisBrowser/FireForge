// SPDX-License-Identifier: EUPL-1.2
import { join, resolve } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import {
  assertEngineGenerationUnchanged,
  snapshotEngineGeneration,
} from '../core/engine-session-lock.js';
import { hasBuildArtifacts, hasRunnableBundle } from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import {
  assertMarionettePortAvailable,
  ensureLaunchableBrowserNotRunning,
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
import { ensureMochitestServerPortAvailable } from '../core/mochitest-server-port.js';
import { createPostRebuildFailureContext } from '../core/test-harness-output.js';
import {
  analyzeTestPathScopes,
  formatScopeNotice,
  type TestPathScope,
} from '../core/test-path-scope.js';
import { assertObjdirMatchesTreeMarker } from '../core/tree-store.js';
import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, notice, outro, verbose } from '../utils/logger.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { runTestBuildPhase } from './test-build-phase.js';
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
  finalizeShardedOutcome,
  runShardedTests,
  runTestsWithRetries,
  type ShardedRunSummary,
  type ShardGroup,
  type TestRunContext,
  type TestRunOutcome,
  type TestSuite,
} from './test-run.js';
import {
  emitFailVerdict,
  emitPassVerdict,
  resetVerdictEmission,
  verdictEmitted,
} from './test-verdict.js';

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
 * warning instead of crashing generic `mach test` at startup. Mixed runs are
 * rejected before this point; a path-less "run all" or an explicit
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
  // Non-TTY captures need the banner even if clack's renderer defers output
  // in pipe mode; TTY users need the clack framing. Gated rather than
  // written twice — the unconditional pair printed the same line twice on a
  // terminal.
  if (process.stdout.isTTY) {
    info('Running marionette preflight...');
  } else {
    process.stdout.write('Running marionette preflight...\n');
  }
  const preflight =
    effectivePort !== undefined
      ? await runMarionettePreflight(engineDir, { port: effectivePort })
      : await runMarionettePreflight(engineDir);
  // The authoritative PASS/FAIL line is written with `process.stdout.write`
  // as the first output after the probe returns, because clack's renderer
  // can drop the summary under non-TTY capture.
  //
  // Gated on non-TTY: unconditional, it stacks with the two clack renderings
  // below and the same line appears THREE times on a terminal. Captured
  // streams are exactly where this branch still fires.
  const directLine = formatMarionettePreflightLine(preflight);
  if (!process.stdout.isTTY) {
    process.stdout.write(`${directLine}\n`);
  }
  process.stdout.write(
    `Marionette preflight environment: objdir=${objDir ?? '(none)'}; binary=${binaryName}; app=${launchablePath ? `engine/${launchablePath}` : '(unknown)'}; port=${effectivePort ?? 2828}; elapsed=${preflight.durationMs}ms\n`
  );
  reportMarionettePreflight(preflight);
  if (!hasTestPaths) {
    if (!preflight.ok) {
      emitFailVerdict('preflight');
      throw new GeneralError('Marionette preflight reported FAIL — see output above.');
    }
    // Doctor-only runs end here, so they carry their own verdict line
    // (reason=preflight on failure); with test paths the verdict comes
    // from the actual harness run downstream.
    emitPassVerdict();
    outro('Test completed');
    return 'stop';
  }
  if (!preflight.ok) {
    emitFailVerdict('preflight');
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
  // Auto-forward the Marionette port to mach when `--marionette-port` is set.
  // `--setpref=marionette.port=<n>` configures where the browser listener
  // binds; `--marionette=127.0.0.1:<n>` tells the mochitest harness client to
  // connect there (default client is 127.0.0.1:2828). xpcshell ignores both
  // for browser Marionette.
  //
  // Skip setpref forwarding when the operator already supplied an equivalent
  // arg via `--mach-arg` — duplicates would confuse without changing
  // semantics. Skip when mach args explicitly request `--flavor=xpcshell` (or
  // `xpcshell-tests`): the preflight still honours `--marionette-port`, but
  // mach does not use the marionette.port pref on that harness. Any other arg
  // shape still forwards so toolkit widget paths and mixed suites stay
  // aligned with the probe without duplicate `--mach-arg` flags.
  //
  // Skip auto `--marionette=...` when `--mach-arg` already includes a client
  // `--marionette=...` (or two-token `--marionette host:port`).
  if (options.marionettePort === undefined) return;
  if (xpcshellOnly) {
    // Manifest classification says every requested path is xpcshell —
    // xpcshell ignores the browser Marionette path entirely, and forwarding
    // the mochitest client flags here makes mach reject the dispatch.
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
  // Refuse a stale listener before mach surfaces a generic bind failure.
  // This also recognizes a fork-branded browser via binaryName.
  if (skip.xpcshellOnly && !skip.doctor) {
    // xpcshell does not bind the browser Marionette port, so a developer's
    // interactive browser holding 2828 must not kill an xpcshell run.
    // --doctor keeps the preflight: its probe launches a
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

async function ensureTestBrowserEnvironment(
  engineDir: string,
  launchablePath: string | undefined,
  xpcshellOnly: boolean,
  binaryName: string,
  options: TestOptions
): Promise<{ forwardedPort: number | undefined; effectivePort: number | undefined }> {
  // A timed-out mochitest can leave the built app alive after its Marionette
  // listener has disappeared. The port probe cannot see that case, but the
  // survivor can still steal focus and wedge every later headed run.
  if (!xpcshellOnly && launchablePath) {
    await ensureLaunchableBrowserNotRunning(join(engineDir, launchablePath), {
      killStaleBrowser: options.killStaleMarionette === true,
    });
  }
  // A zombie mochitest httpd squatting the server port makes a fresh
  // browser connect to a server that cannot serve this run's manifest,
  // which surfaces as a 370s "Ran 0 checks" stall naming nothing. xpcshell
  // does not use the httpd, so an xpcshell-only run is never blocked by it.
  if (!xpcshellOnly) {
    await ensureMochitestServerPortAvailable(undefined, {
      killStaleServer: options.killStaleMarionette === true,
    });
  }
  const forwardedPort = options.machArg
    ? extractForwardedMarionettePort(options.machArg)
    : undefined;
  const effectivePort = options.marionettePort ?? forwardedPort;
  await ensureTestMarionettePortAvailable(effectivePort, binaryName, options, {
    xpcshellOnly,
    doctor: options.doctor === true,
  });
  return { forwardedPort, effectivePort };
}

/** Build-artifact preflight wording for `fireforge test`. */
const TEST_BUILD_PREFLIGHT = {
  label: 'Tests',
  requirement: 'Tests require a completed build.',
  remediation: "Run 'fireforge build' first, then run 'fireforge test'.",
  requireExisting: true,
} as const;

/**
 * Runs the test command to execute mach tests.
 *
 * Owns the run's exactly-one-`FIREFORGE-VERDICT:`-line guarantee: the sink
 * is re-armed at entry, and any failure that reaches this boundary without
 * an inner writer having emitted — the preflight ladder (missing engine or
 * build, config errors, stale-build and port gates, missing paths), and a
 * harness process that failed to start — emits `FAIL reason=preflight`,
 * since no harness classification exists for such a run. Writers closer to
 * the harness (doctor, canary, single, sharded, the engine-generation
 * guard) emit first and win.
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
  resetVerdictEmission();
  try {
    await runTestCommandBody(projectRoot, testPaths, options);
  } catch (error: unknown) {
    if (!verdictEmitted()) emitFailVerdict('preflight');
    throw error;
  }
}

/**
 * Verifies `engine/` did not change under the run before any PASS verdict
 * may print. On failure the run's verdict is `FAIL reason=inconclusive` —
 * the harness result exists but cannot be trusted (`preflight` would
 * misdescribe a run whose harness already executed) — emitted here so the
 * guard's throw can never leave a stale or missing verdict line behind.
 */
async function verifyEngineGenerationOrEmitInconclusive(
  engineDir: string,
  before: string
): Promise<void> {
  try {
    await assertEngineGenerationUnchanged(engineDir, before);
  } catch (error: unknown) {
    emitFailVerdict('inconclusive');
    throw error;
  }
}

async function runTestCommandBody(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions = {}
): Promise<void> {
  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  await assertEngineExists(paths.engine);
  assertPathlessTestMode(testPaths, options);

  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, TEST_BUILD_PREFLIGHT);
  // Inside a verification tree, only the objdir the marker records was
  // proven rewritten-and-reconfigured to the tree; refuse any other.
  await assertObjdirMatchesTreeMarker(projectRoot, buildCheck.objDir);

  // Load the project config once so both the build and the port
  // probe have access to `binaryName` (the port probe uses it to
  // recognise a fork-branded browser holding the Marionette port).
  const projectConfig = await loadConfig(projectRoot);
  const canaryPath = resolveCanaryPath(options, projectConfig);
  assertTestModeCombinations(testPaths, options, canaryPath);

  // `hasBuildArtifacts` only confirms `obj-*/dist/` exists; a partial build
  // (linker failed, packaging step interrupted) can satisfy that check
  // without ever writing the launchable binary the marionette preflight
  // needs to spawn. `fireforge run` already uses `hasRunnableBundle` to fail
  // fast with a precise message; mirroring it here makes `test --doctor`
  // against an incomplete build surface the missing-bundle path instead of a
  // cryptic `Browser process exited during spawn (exit code 1, signal none).
  // stderr tail: (empty)`.
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
    normalizedPaths,
    { allowMixed: options.buildOnly === true }
  );

  if (
    await runTestBuildPhase(projectRoot, paths, projectConfig, harnessRetries, options, {
      classification,
      normalizedPaths,
    })
  ) {
    return;
  }

  // Resolve the effective Marionette port. Operator precedence:
  //   1. `--marionette-port` (first-class option, parsed at the CLI layer)
  //   2. forwarded `--mach-arg --marionette-port=NNNN` /
  //      `--mach-arg --setpref=marionette.port=NNNN`
  //   3. fall back to `DEFAULT_MARIONETTE_PORT` semantics inside the probes
  //      (passed as `undefined`).
  // Without (2), an operator working around a stale listener via the
  // documented `--mach-arg --marionette-port=NNNN` route still hits the
  // wrapper preflight refusing on 2828 before the forwarded arg reaches
  // mach.
  const { forwardedPort, effectivePort } = await ensureTestBrowserEnvironment(
    paths.engine,
    launchablePath,
    xpcshellOnly,
    projectConfig.binaryName,
    options
  );

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
  // above for why). Appended AFTER --headless so mach sees
  // the FireForge-managed flags first and the escape-valve ones last, which
  // keeps the override precedence predictable.
  if (forwardedMachArgs.length > 0) {
    extraArgs.push(...forwardedMachArgs);
  }

  appendMarionetteForwardingArgs(extraArgs, options, forwardedPort, xpcshellOnly);

  // Directory arguments mean EXACTLY that directory: mozbuild's test
  // resolver matches paths by string prefix, so a bare directory arg
  // silently sweeps in prefix-named siblings — `…/test/hominis` also running
  // `…/test/hominis-tiles`, with no indication the scope widened. Each
  // directory argument therefore dispatches as its enumerated explicit
  // test-file list, which cannot prefix-match a sibling; a trailing-`/`
  // normalization does not work, as mach still sweeps the sibling in. Any
  // prefix-siblings are echoed so the narrowed scope is visible.
  // Classification above intentionally used the raw argument forms; only the
  // mach dispatch needs the exact-match shape.
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

  // Multi-argument requests shard into sequential harness runs by default:
  // one shared mochitest profile across files bleeds pref/media-query state
  // into later files. Sharding is per path ARGUMENT — a directory argument
  // keeps its enumerated files together in one invocation, preserving the
  // one-browser-instance semantics of a directory run. `--no-shard` restores
  // the combined invocation. The default must not be SILENT: a cross-file
  // pollution repro otherwise "passes" because the comparison run was
  // sharded without saying so, misattributing a suite-context bug upstream.
  // Hence the one-line notice stating what sharding does and does not
  // exercise.
  if (canaryPath === undefined && dispatchGroups.length > 1 && options.shard !== false) {
    notice(
      `Sharding: running ${dispatchGroups.length} test path arguments in isolated browser instances ` +
        '(one mach invocation per argument; a directory argument keeps its files in one instance). ' +
        'Cross-argument state is NOT exercised — pass --no-shard for a combined single-instance run.'
    );
    const generationBefore = await snapshotEngineGeneration(paths.engine);
    let summary: ShardedRunSummary;
    try {
      summary = await runShardedTests(runCtx, dispatchGroups, (outcome, label) =>
        diagnoseShardOutcome(outcome, label, projectConfig.binaryName, postRebuildContext)
      );
    } finally {
      // Runs BEFORE the aggregate verdict below: a mutated engine/ emits
      // `FAIL reason=inconclusive` and throws, so an invalidated run can
      // never print `PASS shards=N/N` first. (A throw here masks an
      // in-flight shard error, as the plain assert always did.)
      await verifyEngineGenerationOrEmitInconclusive(paths.engine, generationBefore);
    }
    finalizeShardedOutcome(summary);
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
    await verifyEngineGenerationOrEmitInconclusive(paths.engine, generationBefore);
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
 * Builds the perf-sample env contract for the harness run:
 * `--perf-samples <path>` exports `<BINARYNAME>_PERF_SAMPLE_JSON` naming the
 * artifact file a budget checker consumes after the run.
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
