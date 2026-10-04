// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import {
  assertEngineGenerationUnchanged,
  snapshotEngineGeneration,
} from '../core/engine-session-lock.js';
import { hasBuildArtifacts, hasRunnableBundle } from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import { ensureLaunchableBrowserNotRunning } from '../core/marionette-port.js';
import { waitForPreflight } from '../core/preflight-wait.js';
import {
  closeActiveRunLog,
  openRunLog,
  setActiveRunLog,
  writeToActiveRunLog,
} from '../core/run-log.js';
import { createPostRebuildFailureContext } from '../core/test-harness-output.js';
import {
  analyzeTestPathScopes,
  formatScopeNotice,
  type TestPathScope,
} from '../core/test-path-scope.js';
import {
  cleanupProfileFiles,
  type StagedProfileFiles,
  stageProfileFiles,
} from '../core/test-profile-files.js';
import { assertObjdirMatchesTreeMarker } from '../core/tree-store.js';
import { FireForgeError, GeneralError, PreflightRefusalError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, notice, warn } from '../utils/logger.js';
import { resolveWaitLockSeconds } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import {
  appendMarionetteForwardingArgs,
  ensureTestBrowserEnvironment,
  runDoctorPreflight,
} from './test-browser-preflight.js';
import { runTestBuildPhase } from './test-build-phase.js';
import { diagnoseShardOutcome, finalizeSingleRunOutcome } from './test-diagnose.js';
import {
  buildPerfSampleEnv,
  mergeHarnessEnv,
  resolveShuffleSeed,
  shuffleTestGroups,
} from './test-harness-env.js';
import { removePgidFile, setActivePgidFile } from './test-harness-teardown.js';
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
import { emitFailVerdict, resetVerdictEmission, verdictEmitted } from './test-verdict.js';

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
 * rejected before this point. A path-less "run all" or an explicit
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
 * an inner writer having emitted (the preflight ladder: missing engine or
 * build, config errors, stale-build and port gates, missing paths, and a
 * harness process that failed to start) emits `FAIL reason=preflight`,
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
  // Opened before any work so a preflight refusal is logged too. Those are
  // exactly the runs whose only output a `tail` throws away. Closed in
  // `finally`, after the verdict line has already read the path.
  setActiveRunLog(await openRunLog(projectRoot, 'test'));
  setActivePgidFile(options.pgidFile);
  let staged: StagedProfileFiles | undefined;
  try {
    if (options.profileFile?.length) {
      staged = await stageProfileFiles(projectRoot, options.profileFile);
      options = { ...options, machArg: [...(options.machArg ?? []), ...staged.args] };
    }
    await runTestCommandBody(projectRoot, testPaths, options, staged?.env);
  } catch (error: unknown) {
    if (!verdictEmitted()) {
      renderPreflightRefusal(error);
      emitFailVerdict('preflight', refusalNote(error));
    }
    throw error;
  } finally {
    // A run that ends under FireForge's control owns no harness group any
    // more; the file only outlives FireForge when FireForge was killed.
    const stagedRoot = staged?.root;
    const cleanups = [
      ...(stagedRoot === undefined ? [] : [() => cleanupProfileFiles(stagedRoot)]),
      () => removePgidFile(options.pgidFile),
      () => closeActiveRunLog(),
    ];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error: unknown) {
        warn(`Test cleanup failed: ${toError(error).message}`);
      }
    }
  }
}

/** The refusal class a preflight gate named, when it named one. */
function refusalNote(error: unknown): string | undefined {
  return error instanceof PreflightRefusalError ? error.note : undefined;
}

/**
 * Puts a preflight refusal's own text on the operator's channel before the
 * verdict line, and into the run log.
 *
 * Both halves matter, and neither happened before:
 *
 *  - `withErrorHandling` renders `error.userMessage` back in `cli.ts`, but
 *    by then `emitFailVerdict` has called `setStdoutSealed(true)`, the seal
 *    that keeps the verdict the last stdout write, so `logError` routes to
 *    stderr. A run captured with `> file` therefore kept the verdict and
 *    dropped the reason.
 *  - That same rendering happens after this function's caller returns, and
 *    the `finally` below has already closed the run log. So the artifact the
 *    verdict's own `log=` key points at did not contain the refusal either,
 *    which is what left `.fireforge/logs/test-*.log` holding only the
 *    pre-test build.
 *
 * Writing here, before the seal, fixes both without trading away the
 * contract: the refusal lands on stdout and in the log, and the verdict
 * line still comes last.
 */
function renderPreflightRefusal(error: unknown): void {
  const text = error instanceof FireForgeError ? error.userMessage : toError(error).message;
  const block = `Preflight refused:\n${text}\n`;
  // Raw stdout rather than the clack logger: this must land on the captured
  // stream verbatim, and clack's renderer can drop output under non-TTY
  // capture, the same reason the verdict line is written this way.
  process.stdout.write(block);
  writeToActiveRunLog(block);
}

/**
 * Verifies `engine/` did not change under the run before any PASS verdict
 * may print. On failure the run's verdict is `FAIL reason=inconclusive`,
 * because the harness result exists but cannot be trusted (`preflight` would
 * misdescribe a run whose harness already executed). It is emitted here so the
 * guard's throw can never leave a stale or missing verdict line behind.
 */
async function verifyEngineGenerationOrEmitInconclusive(
  engineDir: string,
  before: string,
  powerChanged = false
): Promise<void> {
  try {
    await assertEngineGenerationUnchanged(engineDir, before);
    if (powerChanged)
      throw new GeneralError(
        'Perf power source changed during the run; repeat this sitting on a stable power source.'
      );
  } catch (error: unknown) {
    emitFailVerdict('inconclusive');
    throw error;
  }
}

async function guardBuildBrowser(
  engineDir: string,
  launchablePath: string | undefined,
  options: TestOptions
): Promise<void> {
  if ((options.build || options.buildOnly) && launchablePath) {
    await waitForPreflight(
      () =>
        ensureLaunchableBrowserNotRunning(join(engineDir, launchablePath), {
          killStaleBrowser: options.killStaleMarionette === true,
        }),
      options.waitBrowser === undefined ? undefined : resolveWaitLockSeconds(options.waitBrowser)
    );
  }
}

function prepareExtraMachArgs(
  options: TestOptions,
  shuffleSeed: number | undefined,
  canaryPath: string | undefined,
  projectConfig: FireForgeConfig,
  forwardedMachArgs: string[]
): string[] {
  const extraArgs: string[] = [];

  if (options.headless) {
    extraArgs.push('--headless');
  }
  if (shuffleSeed !== undefined) {
    extraArgs.push('--shuffle');
  }
  if (options.auto === true) {
    extraArgs.push('--auto');
  }
  if (canaryPath !== undefined) extraArgs.push(`--timeout=${canaryTimeoutSeconds(projectConfig)}`);

  // --mach-arg is a verbatim passthrough for upstream mach/xpcshell/mochitest
  // flags FireForge does not model directly (see the xpcshell appdir hint
  // above for why). Appended after --headless so mach sees
  // the FireForge-managed flags first and the escape-valve ones last, which
  // keeps the override precedence predictable.
  if (forwardedMachArgs.length > 0) extraArgs.push(...forwardedMachArgs);

  return extraArgs;
}

function prepareDispatchArguments(
  classification: HarnessClassification,
  options: TestOptions,
  canaryPath: string | undefined,
  projectConfig: FireForgeConfig
): { suite: TestSuite; shuffleSeed: number | undefined; extraArgs: string[] } {
  const suite = resolveTestSuite(classification, options.genericMachTest === true);
  const shuffleSeed = resolveShuffleSeed(options.shuffle, suite);
  const forwardedMachArgs =
    options.machArg && options.machArg.length > 0
      ? filterRedundantXpcshellFlavorArgs(options.machArg, classification)
      : [];

  const extraArgs = prepareExtraMachArgs(
    options,
    shuffleSeed,
    canaryPath,
    projectConfig,
    forwardedMachArgs
  );

  return { suite, shuffleSeed, extraArgs };
}

async function runTestCommandBody(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions = {},
  profileEnv?: Record<string, string>
): Promise<void> {
  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  await assertEngineExists(paths.engine);
  assertPathlessTestMode(testPaths, options);

  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, TEST_BUILD_PREFLIGHT);
  // Inside a verification tree, only the objdir the marker records was
  // proven rewritten-and-reconfigured to the tree. Refuse any other.
  await assertObjdirMatchesTreeMarker(projectRoot, buildCheck.objDir);

  // Load the project config once so both the build and the port
  // probe have access to `binaryName` (the port probe uses it to
  // recognise a fork-branded browser holding the Marionette port).
  const projectConfig = await loadConfig(projectRoot);
  const canaryPath = resolveCanaryPath(options, projectConfig);
  assertTestModeCombinations(testPaths, options, canaryPath);

  // `hasBuildArtifacts` only confirms `obj-*/dist/` exists. A partial build
  // (linker failed, packaging step interrupted) can satisfy that check
  // without ever writing the launchable binary the marionette preflight
  // needs to spawn. `fireforge run` already uses `hasRunnableBundle` to fail
  // fast with a precise message. Mirroring it here makes `test --doctor`
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
  // recorded coverage. (Existence is still asserted later, after the gate,
  // so stale/coverage refusals keep precedence over missing-path errors.)
  const requestedPaths = canaryPath !== undefined ? [canaryPath] : testPaths;
  const normalizedPaths = requestedPaths.map((p) => stripEnginePrefix(p).trim());

  const { classification, xpcshellOnly } = await classifyBeforeDispatch(
    paths.engine,
    normalizedPaths,
    { allowMixed: options.buildOnly === true }
  );

  await guardBuildBrowser(paths.engine, launchablePath, options);
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
  if (
    await runTestBuildPhase(projectRoot, paths, projectConfig, harnessRetries, options, {
      classification,
      normalizedPaths,
    })
  ) {
    return;
  }

  const { forwardedPort, effectivePort } = await ensureTestBrowserEnvironment(
    paths.engine,
    launchablePath,
    xpcshellOnly,
    projectConfig,
    options,
    buildCheck.objDir
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
  const { suite, shuffleSeed, extraArgs } = prepareDispatchArguments(
    classification,
    options,
    canaryPath,
    projectConfig
  );
  appendMarionetteForwardingArgs(extraArgs, options, forwardedPort, xpcshellOnly);

  // Directory arguments mean exactly that directory: mozbuild's test
  // resolver matches paths by string prefix, so a bare directory arg
  // silently sweeps in prefix-named siblings, with `…/test/hominis` also
  // running `…/test/hominis-tiles`, with no indication the scope widened. Each
  // directory argument therefore dispatches as its enumerated explicit
  // test-file list, which cannot prefix-match a sibling. A trailing-`/`
  // normalization does not work, as mach still sweeps the sibling in. Any
  // prefix-siblings are echoed so the narrowed scope is visible.
  // Classification above intentionally used the raw argument forms. Only the
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

  const harnessEnv = mergeHarnessEnv(
    buildPerfSampleEnv(projectRoot, projectConfig.binaryName, options.perfSamples),
    profileEnv,
    shuffleSeed === undefined ? undefined : { FIREFORGE_SHUFFLE_SEED: String(shuffleSeed) }
  );

  const runCtx: TestRunContext = {
    engineDir: paths.engine,
    objDir: buildCheck.objDir,
    classification,
    suite,
    baseExtraArgs: extraArgs,
    harnessRetries,
    headless: options.headless === true,
    ...(options.fullOutput === true ? { fullOutput: true } : {}),
    ...(harnessEnv ? { env: harnessEnv } : {}),
    pgidFile: options.pgidFile,
  };
  const postRebuildContext = options.build
    ? createPostRebuildFailureContext('fireforge test --build', normalizedPaths)
    : undefined;

  // Multi-argument requests shard into sequential harness runs by default:
  // one shared mochitest profile across files bleeds pref/media-query state
  // into later files. Sharding is per path argument: a directory argument
  // keeps its enumerated files together in one invocation, preserving the
  // one-browser-instance semantics of a directory run. `--no-shard` restores
  // the combined invocation. The default must not be silent: a cross-file
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
      const orderedGroups =
        shuffleSeed === undefined ? dispatchGroups : shuffleTestGroups(dispatchGroups, shuffleSeed);
      summary = await runShardedTests(runCtx, orderedGroups, (outcome, label) =>
        diagnoseShardOutcome(outcome, label, projectConfig.binaryName, postRebuildContext)
      );
    } finally {
      // Runs before the aggregate verdict below: a mutated engine/ emits
      // `FAIL reason=inconclusive` and throws, so an invalidated run can
      // never print `PASS shards=N/N` first. (A throw here masks an
      // in-flight shard error, as the plain assert always did.)
      await verifyEngineGenerationOrEmitInconclusive(
        paths.engine,
        generationBefore,
        runCtx.powerChanged
      );
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
    await verifyEngineGenerationOrEmitInconclusive(
      paths.engine,
      generationBefore,
      runCtx.powerChanged
    );
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
