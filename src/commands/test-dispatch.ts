// SPDX-License-Identifier: EUPL-1.2
/**
 * The dispatch half of one `fireforge test` run, split out of `test.ts`:
 * the engine-generation guard around the harness, and the choice between
 * one combined invocation, per-argument shards, `--shard-size` chunks and
 * `--jobs` parallel harness instances.
 */

import { createServer } from 'node:net';

import {
  assertEngineGenerationUnchanged,
  snapshotEngineGeneration,
} from '../core/engine-session-lock.js';
import { autoPortsRequested } from '../core/harness-port-fallback.js';
import { extractForwardedMarionettePort } from '../core/marionette-port.js';
import type { PostRebuildFailureContext } from '../core/test-harness-output.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { notice } from '../utils/logger.js';
import { diagnoseShardOutcome, finalizeSingleRunOutcome } from './test-diagnose.js';
import { shuffleTestGroups } from './test-harness-env.js';
import { reportCanaryOutcome } from './test-modes.js';
import { perfGenerationTolerance, runGenerationTolerance } from './test-perf-scope.js';
import { runTestsWithRetries, type TestRunContext, type TestRunOutcome } from './test-run.js';
import {
  chunkShardGroups,
  finalizeShardedOutcome,
  runShardedTests,
  type ShardedRunSummary,
  type ShardGroup,
  splitContiguous,
} from './test-shards.js';
import { emitFailVerdict, setVerdictRunAttribute } from './test-verdict.js';

/** Everything the dispatch half needs from the run body. */
export interface TestDispatchInputs {
  engineDir: string;
  runCtx: TestRunContext;
  dispatchGroups: ShardGroup[];
  options: TestOptions;
  projectConfig: FireForgeConfig;
  canaryPath: string | undefined;
  shuffleSeed: number | undefined;
  normalizedPaths: string[];
  xpcshellOnly: boolean;
  postRebuildContext: PostRebuildFailureContext | undefined;
}

/**
 * Refuses `--jobs`/`--shard-size` shapes that cannot work, before any lock
 * or build: both need explicit paths and a real dispatch, and parallel
 * instances cannot share one operator-pinned Marionette port.
 *
 * @param testPaths - Requested paths
 * @param options - Parsed options
 */
export function assertParallelTestUsage(testPaths: readonly string[], options: TestOptions): void {
  const parallel = (options.jobs ?? 1) > 1;
  const flags = [
    ...(parallel ? ['--jobs'] : []),
    ...(options.shardSize !== undefined ? ['--shard-size'] : []),
  ];
  if (flags.length === 0) return;
  const flag = flags.join('/');
  if (testPaths.length === 0 || options.canary !== undefined || options.auto === true) {
    throw new InvalidArgumentError(
      `${flag} splits explicit test paths, so it needs paths and cannot be combined with --canary or --auto.`,
      flags[0]
    );
  }
  if (options.buildOnly === true) {
    throw new InvalidArgumentError(`${flag} shapes a dispatch; --build-only runs none.`, flags[0]);
  }
  if (
    parallel &&
    (options.marionettePort !== undefined ||
      extractForwardedMarionettePort(options.machArg ?? []) !== undefined)
  ) {
    throw new InvalidArgumentError(
      '--jobs gives every harness instance its own Marionette port, so it cannot be combined with a pinned --marionette-port (or a forwarded one).',
      '--jobs'
    );
  }
}

/**
 * Verifies `engine/` did not change under the run in a way the run could
 * see before any PASS verdict may print. On failure the run's verdict is
 * `FAIL reason=inconclusive`, because the harness result exists but cannot
 * be trusted (`preflight` would misdescribe a run whose harness already
 * executed). It is emitted here so the guard's throw can never leave a
 * stale or missing verdict line behind.
 */
async function verifyEngineGenerationOrEmitInconclusive(
  engineDir: string,
  before: string,
  inputs: {
    powerChanged?: boolean;
    perfSamples?: string | undefined;
    requested: readonly string[];
  }
): Promise<void> {
  try {
    await assertEngineGenerationUnchanged(
      engineDir,
      before,
      inputs.perfSamples === undefined
        ? runGenerationTolerance(engineDir, inputs.requested, (count) => {
            setVerdictRunAttribute('drift-tolerated', String(count));
          })
        : perfGenerationTolerance(engineDir)
    );
    if (inputs.powerChanged === true)
      throw new GeneralError(
        'Perf power source changed during the run; repeat this sitting on a stable power source.'
      );
  } catch (error: unknown) {
    emitFailVerdict('inconclusive');
    throw error;
  }
}

/** A free TCP port on the loopback interface, for one harness instance. */
async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * The mochitest harness writes the dispatched test list to
 * `_tests/testing/mochitest/tests.json` and the browser fetches it from
 * there, so instances sharing the default name read each other's list (and
 * one instance's cleanup removes it under the other). Each instance names
 * its own file.
 */
function testRunManifestArg(index: number): string {
  return `--testrun-manifest-file=fireforge-tests-${process.pid}-job${index + 1}.json`;
}

/**
 * The context for `--jobs` instance `index` (0-based): its own output
 * prefix and test-list manifest, and from the second instance on its own
 * Marionette port, so browsers started at the same moment never race for
 * 2828. The mochitest server ports are left to the engine harness's
 * busy-port fallback, which `--jobs` requires (auto ports).
 */
async function instanceContext(
  base: TestRunContext,
  index: number,
  xpcshellOnly: boolean
): Promise<TestRunContext> {
  const ctx: TestRunContext = { ...base, outputPrefix: `[job ${index + 1}] ` };
  if (xpcshellOnly) return ctx;
  const own = [...base.baseExtraArgs, testRunManifestArg(index)];
  if (index === 0) return { ...ctx, baseExtraArgs: own };
  const port = await allocateLoopbackPort();
  return {
    ...ctx,
    baseExtraArgs: [...own, `--setpref=marionette.port=${port}`, `--marionette=127.0.0.1:${port}`],
  };
}

/** The shards to run, or undefined for one combined invocation. */
function planShards(inputs: TestDispatchInputs): ShardGroup[] | undefined {
  const { dispatchGroups, options, canaryPath, shuffleSeed } = inputs;
  if (canaryPath !== undefined) return undefined;
  const ordered =
    shuffleSeed === undefined ? dispatchGroups : shuffleTestGroups(dispatchGroups, shuffleSeed);
  if (options.shardSize !== undefined) return chunkShardGroups(ordered, options.shardSize);
  const jobs = options.jobs ?? 1;
  if (jobs > 1 && (options.shard === false || ordered.length === 1)) {
    return splitContiguous(
      ordered.flatMap((group) => group.paths),
      jobs
    );
  }
  if (ordered.length > 1 && options.shard !== false) return ordered;
  return undefined;
}

/**
 * Runs the planned dispatch and finalizes its verdict.
 *
 * @param inputs - See {@link TestDispatchInputs}
 */
export async function dispatchTests(inputs: TestDispatchInputs): Promise<void> {
  const { engineDir, runCtx, options, projectConfig, normalizedPaths } = inputs;
  const jobs = options.jobs ?? 1;
  if (jobs > 1 && !inputs.xpcshellOnly && !autoPortsRequested(options, projectConfig)) {
    throw new InvalidArgumentError(
      '--jobs runs several browsers at once, which needs auto ports (--auto-ports or ' +
        'test.mochitestPorts: "auto") so the harness can move each instance to free server ports.',
      '--jobs'
    );
  }
  const guard = {
    perfSamples: options.perfSamples,
    requested: normalizedPaths,
  } as const;
  const shards = planShards(inputs);
  if (shards !== undefined) {
    notice(describeSharding(shards.length, options, jobs));
    const base = jobs > 1 ? await instanceContext(runCtx, 0, inputs.xpcshellOnly) : runCtx;
    if (jobs > 1) setVerdictRunAttribute('jobs', String(jobs));
    const generationBefore = await snapshotEngineGeneration(engineDir);
    let summary: ShardedRunSummary;
    try {
      summary = await runShardedTests(
        base,
        shards,
        (outcome, label) =>
          diagnoseShardOutcome(outcome, label, projectConfig.binaryName, inputs.postRebuildContext),
        {
          jobs,
          contextFor: (index) => instanceContext(runCtx, index, inputs.xpcshellOnly),
          perFile: options.shardSize !== undefined,
        }
      );
    } finally {
      // Runs before the aggregate verdict below: a mutated engine/ emits
      // `FAIL reason=inconclusive` and throws, so an invalidated run can
      // never print `PASS shards=N/N` first. (A throw here masks an
      // in-flight shard error, as the plain assert always did.)
      await verifyEngineGenerationOrEmitInconclusive(engineDir, generationBefore, {
        ...guard,
        ...(base.powerChanged === true || runCtx.powerChanged === true
          ? { powerChanged: true }
          : {}),
      });
    }
    finalizeShardedOutcome(summary);
    return;
  }

  const combinedDispatchPaths = inputs.dispatchGroups.flatMap((group) => group.paths);
  let outcome: TestRunOutcome;
  const generationBefore = await snapshotEngineGeneration(engineDir);
  try {
    outcome = await runTestsWithRetries(runCtx, combinedDispatchPaths);
  } catch (error: unknown) {
    throw new BuildError(
      'Test process failed to start',
      'mach test',
      error instanceof Error ? error : undefined
    );
  } finally {
    await verifyEngineGenerationOrEmitInconclusive(engineDir, generationBefore, {
      ...guard,
      ...(runCtx.powerChanged === true ? { powerChanged: true } : {}),
    });
  }

  if (inputs.canaryPath !== undefined) {
    reportCanaryOutcome(outcome);
    return;
  }

  finalizeSingleRunOutcome(
    outcome,
    normalizedPaths,
    projectConfig.binaryName,
    inputs.postRebuildContext,
    options.headless === true
  );
}

/**
 * The sharding notice. The default must not be silent: a cross-file
 * pollution repro otherwise "passes" because the comparison run was
 * sharded without saying so, misattributing a suite-context bug upstream.
 */
function describeSharding(count: number, options: TestOptions, jobs: number): string {
  const instances =
    jobs > 1 ? ` on ${jobs} harness instances at once (each with its own ports and profile)` : '';
  if (options.shardSize !== undefined) {
    return (
      `Sharding: running ${count} chunk(s) of up to ${options.shardSize} file(s)${instances}, ` +
      'each chunk one mach invocation with a browser restart between files; results are judged ' +
      'per file from the structured log.'
    );
  }
  if (jobs > 1 && options.shard === false) {
    return (
      `Sharding: --jobs splits the combined request into ${count} contiguous chunk(s) in order` +
      `${instances}. Cross-chunk state is NOT exercised.`
    );
  }
  return (
    `Sharding: running ${count} test path arguments in isolated browser instances${instances} ` +
    '(one mach invocation per argument; a directory argument keeps its files in one instance). ' +
    'Cross-argument state is NOT exercised — pass --no-shard for a combined single-instance run.'
  );
}
