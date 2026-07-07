// SPDX-License-Identifier: EUPL-1.2
/**
 * Run orchestration for `fireforge test`: bounded harness-crash retries
 * (field reports C1/C2) and sequential per-file sharding of multi-path
 * invocations (field report C3).
 *
 * Sharding exists because passing several browser-chrome files to one
 * mach invocation destabilizes later files — cross-file profile/pref
 * bleed in the shared mochitest profile made the second file time out at
 * window-open while each file passed in isolation. Sequential single-file
 * harness runs cost startup time but make results reproducible; the
 * combined invocation stays available via `--no-shard`.
 */

import {
  type MachCommandResult,
  mochitestWithOutput,
  testWithOutput,
  xpcshellTestWithOutput,
} from '../core/mach.js';
import {
  buildHarnessCrashMessage,
  classifyHarnessRun,
  type HarnessRunVerdict,
} from '../core/test-harness-crash.js';
import { retryAfterXpcshellSymlinkRepair, type TestDispatch } from '../core/test-xpcshell-retry.js';
import { BuildError } from '../errors/build.js';
import { info, note, warn } from '../utils/logger.js';
import { maybeInjectAppdirArg } from './test-appdir.js';

/** Default bounded retry budget for recognized harness crashes. */
export const DEFAULT_HARNESS_RETRIES = 2;

/**
 * Which mach command a run dispatches to. Single-suite runs use the
 * suite-specific command (`mach xpcshell-test` / `mach mochitest`), which
 * skips the mozlog resource monitor that crashes generic `mach test` on a
 * broken host (field report E1). `generic` is the historical `mach test`
 * path (mixed/all-tests runs, or the `--generic-mach-test` opt-out).
 */
export type TestSuite = 'xpcshell' | 'mochitest' | 'generic';

/** Resolves the capturing mach dispatcher for a suite. */
function dispatchForSuite(suite: TestSuite): TestDispatch {
  if (suite === 'xpcshell') return xpcshellTestWithOutput;
  if (suite === 'mochitest') return mochitestWithOutput;
  return testWithOutput;
}

/** Inputs shared by every harness invocation in one `fireforge test` run. */
export interface TestRunContext {
  engineDir: string;
  objDir: string | undefined;
  classification: { xpcshell: string[]; nonXpcshell: string[] };
  /** Suite-specific dispatch target for this run (E1). */
  suite: TestSuite;
  /** Extra mach args before per-shard appdir injection. */
  baseExtraArgs: readonly string[];
  /** Bounded harness-crash retry budget (0 disables retries). */
  harnessRetries: number;
  /** Extra environment variables for the mach process. */
  env?: Record<string, string>;
}

/** Outcome of one (possibly retried) harness invocation. */
export interface TestRunOutcome {
  result: MachCommandResult;
  verdict: HarnessRunVerdict;
  attempts: number;
  /** Whether xpcshell appdir injection was attempted for this invocation. */
  appdirInjectionAttempted: boolean;
}

/**
 * Runs one mach test invocation for `paths`, retrying recognized harness
 * crashes up to the configured budget. Every attempt goes through the
 * stale-xpcshell-symlink repair path the single-run flow already used.
 */
export async function runTestsWithRetries(
  ctx: TestRunContext,
  paths: string[]
): Promise<TestRunOutcome> {
  const extraArgs = [...ctx.baseExtraArgs];
  const appdirInjectionAttempted = await maybeInjectAppdirArg(
    ctx.engineDir,
    paths,
    ctx.objDir,
    extraArgs
  );

  const dispatch = dispatchForSuite(ctx.suite);
  const maxAttempts = Math.max(1, ctx.harnessRetries + 1);
  let attempts = 0;
  let result: MachCommandResult;
  let verdict: HarnessRunVerdict;

  for (;;) {
    attempts += 1;
    result = ctx.env
      ? await dispatch(ctx.engineDir, paths, extraArgs, ctx.env)
      : await dispatch(ctx.engineDir, paths, extraArgs);
    result = await retryAfterXpcshellSymlinkRepair(
      ctx.engineDir,
      ctx.objDir,
      result,
      ctx.classification,
      paths,
      extraArgs,
      ctx.env,
      dispatch
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    verdict = classifyHarnessRun(result.exitCode, combined, paths);
    if (verdict.kind !== 'harness-crash' || attempts >= maxAttempts) break;
    warn(
      `Harness crash detected (${verdict.signature?.reason ?? 'unknown shape'}): ` +
        `${verdict.signature?.line ?? ''}\n` +
        `Retrying (attempt ${attempts + 1} of ${maxAttempts})...`
    );
  }

  return { result, verdict, attempts, appdirInjectionAttempted };
}

/**
 * One sequential harness invocation of a sharded run: a requested path
 * argument and the mach paths dispatched for it. A file argument is a
 * group of one; a directory argument groups its enumerated test files so
 * the whole directory still runs in ONE browser instance (cross-file
 * state carries within a directory run exactly like the pre-enumeration
 * behavior).
 */
export interface ShardGroup {
  /** The path argument as the operator passed it (display label). */
  label: string;
  /** The mach dispatch paths for this argument. */
  paths: string[];
}

/** Per-shard summary entry. */
export interface ShardOutcome {
  label: string;
  outcome: TestRunOutcome;
}

const SHARD_STATUS_LABEL: Record<HarnessRunVerdict['kind'], string> = {
  'tests-ran-ok': 'PASS',
  'test-failures': 'FAIL',
  'harness-crash': 'CRASH',
  'no-tests': 'NO-TESTS',
};

/**
 * Runs each requested path argument as its own sequential harness
 * invocation (a directory argument's enumerated files stay together in
 * one invocation — see {@link ShardGroup}) and prints an aggregate
 * report. Per-shard failures are diagnosed via `diagnoseShardFailure`
 * (which receives the throwing diagnosis chain from the command layer)
 * but downgraded to warnings so every shard runs; a single aggregate
 * error is thrown at the end when any shard did not pass.
 */
export async function runShardedTests(
  ctx: TestRunContext,
  groups: ShardGroup[],
  diagnoseShardFailure: (outcome: TestRunOutcome, label: string) => string | undefined
): Promise<void> {
  const shards: ShardOutcome[] = [];
  for (const [index, group] of groups.entries()) {
    info(`— Shard ${index + 1}/${groups.length}: ${group.label}`);
    const outcome = await runTestsWithRetries(ctx, group.paths);
    shards.push({ label: group.label, outcome });

    if (outcome.verdict.kind === 'harness-crash' && outcome.verdict.signature) {
      warn(buildHarnessCrashMessage(outcome.verdict.signature, outcome.attempts));
    } else if (outcome.verdict.kind !== 'tests-ran-ok') {
      const diagnosis = diagnoseShardFailure(outcome, group.label);
      if (diagnosis) warn(diagnosis);
    }
  }

  const lines = shards.map(
    ({ label, outcome }) =>
      `${SHARD_STATUS_LABEL[outcome.verdict.kind].padEnd(8)} ${label}` +
      (outcome.attempts > 1 ? `  (${outcome.attempts} attempts)` : '')
  );
  const failing = shards.filter(({ outcome }) => outcome.verdict.kind !== 'tests-ran-ok');
  note(
    `${lines.join('\n')}\n\n${shards.length - failing.length}/${shards.length} shard(s) passed`,
    'Sharded Test Summary'
  );

  if (failing.length > 0) {
    throw new BuildError(
      `${failing.length} of ${shards.length} sharded test run(s) did not pass: ` +
        `${failing.map(({ label }) => label).join(', ')}. ` +
        'See the per-shard diagnosis above. Use --no-shard to reproduce the combined single-invocation behaviour.',
      'mach test'
    );
  }
}
