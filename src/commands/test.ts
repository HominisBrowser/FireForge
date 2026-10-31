// SPDX-License-Identifier: EUPL-1.2
import { join, resolve } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import { readBuildId } from '../core/launchable-build.js';
import { hasBuildArtifacts } from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import { ensureLaunchableBrowserNotRunning } from '../core/marionette-port.js';
import { waitForPreflight } from '../core/preflight-wait.js';
import {
  closeActiveRunLog,
  keepRunLogCopy,
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
import {
  FireForgeError,
  GeneralError,
  LockContentionError,
  PreflightRefusalError,
} from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, warn } from '../utils/logger.js';
import { resolveWaitLockSeconds } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import {
  appendMarionetteForwardingArgs,
  ensureTestBrowserEnvironment,
  runDoctorPreflight,
} from './test-browser-preflight.js';
import { runTestBuildPhase } from './test-build-phase.js';
import { assertParallelTestUsage, dispatchTests } from './test-dispatch.js';
import { buildPerfSampleEnv, mergeHarnessEnv, resolveShuffleSeed } from './test-harness-env.js';
import { removePgidFile, setActivePgidFile } from './test-harness-teardown.js';
import {
  assertPathlessTestMode,
  assertTestModeCombinations,
  canaryTimeoutSeconds,
  classifyBeforeDispatch,
  type HarnessClassification,
  resolveCanaryPath,
  restartBetweenTestsArgs,
} from './test-modes.js';
import { orchestrateTestRuns, type TestRunHooks } from './test-orchestrate.js';
import {
  rearmSpentWaits,
  resolveLaunchablePathForTests,
  runTestPreLockPreflight,
  TEST_BUILD_PREFLIGHT,
} from './test-prelock.js';
import { resetTestResults, withRawLogDir, writeTestResults } from './test-results.js';
import { DEFAULT_HARNESS_RETRIES, type TestRunContext, type TestSuite } from './test-run.js';
import type { ShardGroup } from './test-shards.js';
import {
  emitFailVerdict,
  resetVerdictEmission,
  setVerdictRunAttribute,
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
 * The lock-free checks (launchable binary, named-file checkJs, the
 * `--wait-browser`/`--wait-port` budgets) run first, outside `underLock`,
 * so a run that would be refused or would only wait never holds a place in
 * the engine lock queue. See `test-prelock.ts`.
 * @param projectRoot - Root directory of the project
 * @param testPaths - Test file or directory paths
 * @param options - Test options
 * @param underLock - Runs the rest of the command under the engine session lock
 */
export async function testCommand(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions = {},
  underLock: (body: () => Promise<void>, mode?: 'exclusive' | 'shared') => Promise<void> = (body) =>
    body()
): Promise<void> {
  intro('FireForge Test');
  resetVerdictEmission();
  // Opened before any work so a preflight refusal is logged too. Those are
  // exactly the runs whose only output a `tail` throws away. Closed in
  // `finally`, after the verdict line has already read the path.
  setActiveRunLog(
    await keepRunLogCopy(await openRunLog(projectRoot, 'test'), options.keepLog, 'test')
  );
  setActivePgidFile(options.pgidFile);
  let staged: StagedProfileFiles | undefined;
  try {
    if (options.profileFile?.length) {
      staged = await stageProfileFiles(projectRoot, options.profileFile);
      options = { ...options, machArg: [...(options.machArg ?? []), ...staged.args] };
    }
    assertParallelTestUsage(testPaths, options);
    const lockedOptions = await runTestPreLockPreflight(projectRoot, testPaths, options);
    const profileEnv = staged?.env;
    // The pre-lock pass resolved `sharedLock` against config and the run's shape.
    const lockMode = lockedOptions.sharedLock === true ? 'shared' : 'exclusive';
    if (lockMode === 'shared') setVerdictRunAttribute('lock', 'shared');
    resetTestResults();
    if (options.results !== undefined) {
      setVerdictRunAttribute('results', resolve(projectRoot, options.results));
    }
    const orchestrate = (rawLogDir?: string): Promise<void> =>
      orchestrateTestRuns(
        projectRoot,
        testPaths,
        lockedOptions,
        (paths, runOptions, hooks) =>
          runTestCommandBody(projectRoot, paths, runOptions, profileEnv, {
            ...hooks,
            ...(rawLogDir === undefined ? {} : { rawLogDir }),
          }),
        (error) => {
          renderPreflightRefusal(error);
          emitFailVerdict('preflight', refusalNote(error));
        }
      );
    // `--jobs` always reads each dispatch's raw log, so a shard that ran
    // files other than its own fails instead of passing on their results.
    const collectsResults =
      options.results !== undefined || options.shardSize !== undefined || (options.jobs ?? 1) > 1;
    try {
      await underLock(
        () => (collectsResults ? withRawLogDir((dir) => orchestrate(dir)) : orchestrate()),
        lockMode
      );
    } finally {
      if (options.results !== undefined) {
        await writeResultsFile(resolve(projectRoot, options.results));
      }
    }
  } catch (error: unknown) {
    if (!verdictEmitted()) {
      if (error instanceof LockContentionError) {
        emitFailVerdict('lock-timeout');
      } else {
        renderPreflightRefusal(error);
        emitFailVerdict('preflight', refusalNote(error));
      }
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

/** Writes `--results`; a failure warns, since the run's verdict is already out. */
async function writeResultsFile(path: string): Promise<void> {
  try {
    await writeTestResults(path);
  } catch (error: unknown) {
    warn(`Could not write --results ${path}: ${toError(error).message}`);
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
  // A `--shard-size` chunk runs several files in one browser; mochitest
  // restarts it between them so a chunk judges each file as a shard would.
  const restart =
    options.shardSize !== undefined && suite === 'mochitest'
      ? { ...options, restartBetweenTests: true }
      : options;
  extraArgs.push(...restartBetweenTestsArgs(restart, suite, forwardedMachArgs));

  return { suite, shuffleSeed, extraArgs };
}

/**
 * Directory arguments mean exactly that directory: mozbuild's test resolver
 * matches paths by string prefix, so a bare directory arg silently sweeps in
 * prefix-named siblings, with `…/test/hominis` also running
 * `…/test/hominis-tiles`, with no indication the scope widened. Each
 * directory argument therefore dispatches as its enumerated explicit
 * test-file list, which cannot prefix-match a sibling. A trailing-`/`
 * normalization does not work, as mach still sweeps the sibling in. Any
 * prefix-siblings are echoed so the narrowed scope is visible.
 *
 * xpcshell appdir auto-injection happens per harness invocation inside
 * `runTestsWithRetries` (src/commands/test-run.ts) so sharded runs probe the
 * manifest for each file individually. See src/core/xpcshell-appdir.ts for
 * the full motivation.
 */
async function resolveDispatchGroups(
  engineDir: string,
  normalizedPaths: string[]
): Promise<ShardGroup[]> {
  const scopes = await analyzeTestPathScopes(engineDir, normalizedPaths);
  for (const scope of scopes) {
    const notice = formatScopeNotice(scope);
    if (notice) info(notice);
  }
  logTestSelection(scopes);
  return scopes.map((scope) => ({ label: scope.requestedPath, paths: scope.dispatchPaths }));
}

async function runTestCommandBody(
  projectRoot: string,
  testPaths: string[],
  options: TestOptions = {},
  profileEnv?: Record<string, string>,
  hooks: TestRunHooks = {}
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
    projectRoot,
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
  // A negative control on compiled source goes in here, so the build
  // compiles it (see negative-control-compiled.ts).
  await hooks.beforeBuild?.();
  if (
    await runTestBuildPhase(projectRoot, paths, projectConfig, harnessRetries, options, {
      classification,
      normalizedPaths: hooks.coveragePaths ?? normalizedPaths,
      ...(hooks.fullBuildReason === undefined ? {} : { fullBuildReason: hooks.fullBuildReason }),
      ...(hooks.controlBuild === undefined ? {} : { controlBuild: hooks.controlBuild }),
      ...(hooks.ownControlBuild === undefined ? {} : { ownControlBuild: hooks.ownControlBuild }),
      launchablePath,
    })
  ) {
    return;
  }
  // Which binary this run exercises, read after the pre-test build so it
  // names the build the tests actually ran against (`moz:buildID`).
  if (launchablePath !== undefined) {
    const buildId = await readBuildId(paths.engine, launchablePath);
    if (buildId !== undefined) setVerdictRunAttribute('build-id', buildId);
  }

  // After a pre-test build, a busy browser or port is a peer that started
  // during it; waiting it out keeps the build this run just paid for.
  const { forwardedPort, effectivePort } = await ensureTestBrowserEnvironment(
    paths.engine,
    launchablePath,
    xpcshellOnly,
    projectConfig,
    options.build === true ? rearmSpentWaits(options) : options,
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

  // Classification above intentionally used the raw argument forms. Only the
  // mach dispatch needs the exact-match shape.
  const dispatchGroups = await resolveDispatchGroups(paths.engine, normalizedPaths);

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
    ...(hooks.rawLogDir === undefined ? {} : { rawLogDir: hooks.rawLogDir }),
    ...(hooks.repetition === undefined ? {} : { repetition: hooks.repetition }),
  };
  const postRebuildContext = options.build
    ? createPostRebuildFailureContext('fireforge test --build', normalizedPaths)
    : undefined;

  // A negative control goes in here: after every gate and the build, so
  // packaging cannot overwrite it and stale-build cannot refuse it.
  await hooks.beforeDispatch?.();

  // Multi-argument requests shard into sequential harness runs by default:
  // one shared mochitest profile across files bleeds pref/media-query state
  // into later files. Sharding is per path argument: a directory argument
  // keeps its enumerated files together in one invocation, preserving the
  // one-browser-instance semantics of a directory run. `--no-shard` restores
  // the combined invocation; `--shard-size` and `--jobs` reshape it (see
  // test-dispatch.ts).
  await dispatchTests({
    engineDir: paths.engine,
    runCtx,
    dispatchGroups,
    options,
    projectConfig,
    canaryPath,
    shuffleSeed,
    normalizedPaths,
    xpcshellOnly,
    postRebuildContext,
  });
}
