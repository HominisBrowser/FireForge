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

import { type MachCommandResult, testWithOutput } from '../core/mach.js';
import {
  buildHarnessCrashMessage,
  classifyHarnessRun,
  type HarnessRunVerdict,
} from '../core/test-harness-crash.js';
import { retryAfterXpcshellSymlinkRepair } from '../core/test-xpcshell-retry.js';
import { BuildError } from '../errors/build.js';
import { info, note, warn } from '../utils/logger.js';
import { maybeInjectAppdirArg } from './test-appdir.js';

/** Default bounded retry budget for recognized harness crashes. */
export const DEFAULT_HARNESS_RETRIES = 2;

/** Inputs shared by every harness invocation in one `fireforge test` run. */
export interface TestRunContext {
  engineDir: string;
  objDir: string | undefined;
  classification: { xpcshell: string[]; nonXpcshell: string[] };
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

  const maxAttempts = Math.max(1, ctx.harnessRetries + 1);
  let attempts = 0;
  let result: MachCommandResult;
  let verdict: HarnessRunVerdict;

  for (;;) {
    attempts += 1;
    result = ctx.env
      ? await testWithOutput(ctx.engineDir, paths, extraArgs, ctx.env)
      : await testWithOutput(ctx.engineDir, paths, extraArgs);
    result = await retryAfterXpcshellSymlinkRepair(
      ctx.engineDir,
      ctx.objDir,
      result,
      ctx.classification,
      paths,
      extraArgs,
      ctx.env
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

/** Per-shard summary entry. */
export interface ShardOutcome {
  path: string;
  outcome: TestRunOutcome;
}

const SHARD_STATUS_LABEL: Record<HarnessRunVerdict['kind'], string> = {
  'tests-ran-ok': 'PASS',
  'test-failures': 'FAIL',
  'harness-crash': 'CRASH',
  'no-tests': 'NO-TESTS',
};

/**
 * Runs each requested path as its own sequential harness invocation and
 * prints an aggregate report. Per-shard failures are diagnosed via
 * `diagnoseShardFailure` (which receives the throwing diagnosis chain from
 * the command layer) but downgraded to warnings so every shard runs; a
 * single aggregate error is thrown at the end when any shard did not pass.
 */
export async function runShardedTests(
  ctx: TestRunContext,
  paths: string[],
  diagnoseShardFailure: (outcome: TestRunOutcome, path: string) => string | undefined
): Promise<void> {
  const shards: ShardOutcome[] = [];
  for (const [index, path] of paths.entries()) {
    info(`— Shard ${index + 1}/${paths.length}: ${path}`);
    const outcome = await runTestsWithRetries(ctx, [path]);
    shards.push({ path, outcome });

    if (outcome.verdict.kind === 'harness-crash' && outcome.verdict.signature) {
      warn(buildHarnessCrashMessage(outcome.verdict.signature, outcome.attempts));
    } else if (outcome.verdict.kind !== 'tests-ran-ok') {
      const diagnosis = diagnoseShardFailure(outcome, path);
      if (diagnosis) warn(diagnosis);
    }
  }

  const lines = shards.map(
    ({ path, outcome }) =>
      `${SHARD_STATUS_LABEL[outcome.verdict.kind].padEnd(8)} ${path}` +
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
        `${failing.map(({ path }) => path).join(', ')}. ` +
        'See the per-shard diagnosis above. Use --no-shard to reproduce the combined single-invocation behaviour.',
      'mach test'
    );
  }
}
