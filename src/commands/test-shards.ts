// SPDX-License-Identifier: EUPL-1.2
/**
 * Sharded `fireforge test` runs: one harness invocation per shard, run in
 * order on one harness instance, or on a pool of `--jobs <n>` instances.
 *
 * Each finished shard prints a `FIREFORGE-SHARD:` line, and the aggregate
 * verdict names the shards that did not pass as `failed-shards=`. Before,
 * the failing shards were named only in the prose of the aggregate error
 * and the human summary box, so a wrapper that reruns failed shards had to
 * parse a sentence that a reworded message would silently break.
 *
 * Under `--shard-size <n>` a shard is a chunk of n files, and the run is
 * judged per file from each dispatch's raw log: `shards=` then counts files
 * and `failed-shards=` names the files that failed.
 */

import { getActiveRunLogPath, writeToActiveRunLog } from '../core/run-log.js';
import {
  buildHarnessCrashMessage,
  formatFireforgeVerdictLine,
  type HarnessRunVerdict,
  headedNoOutputTimeoutHint,
} from '../core/test-harness-crash.js';
import { TestFailureError } from '../errors/build.js';
import { info, note, warn } from '../utils/logger.js';
import { getPlatform } from '../utils/platform.js';
import { runTestsWithRetries, type TestRunContext, type TestRunOutcome } from './test-run.js';
import { emitHarnessVerdict } from './test-verdict.js';

/**
 * One harness invocation of a sharded run: a requested path argument and
 * the mach paths dispatched for it. A file argument is a group of one. A
 * directory argument groups its enumerated test files so the whole
 * directory still runs in ONE browser instance, keeping cross-file state
 * behaviour within a directory run. A `--shard-size` chunk is a group of
 * up to n files.
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
  /** The shard's dispatch paths (per-file judging). */
  paths?: string[];
}

const SHARD_STATUS_LABEL: Record<HarnessRunVerdict['kind'], string> = {
  'tests-ran-ok': 'PASS',
  'test-failures': 'FAIL',
  'harness-crash': 'CRASH',
  'no-tests': 'NO-TESTS',
  'harness-arguments': 'ARGUMENTS',
};

/** Aggregate result of a sharded run, verdict emission deferred to the caller. */
export interface ShardedRunSummary {
  shards: ShardOutcome[];
  passed: number;
  total: number;
  /** What did not pass: shard labels, or file paths when judged per file. */
  failed: string[];
  /** Aggregate classifier verdict. See {@link deriveAggregateShardVerdict}. */
  aggregate: HarnessRunVerdict;
}

/** How {@link runShardedTests} schedules and judges its shards. */
export interface ShardRunOptions {
  /** Harness instances to run shards on at once (`--jobs`). Default 1. */
  jobs?: number;
  /**
   * The context for instance `index` (0-based). Instance 0 must be the
   * base context; others carry their own ports and output prefix.
   */
  contextFor?: (index: number) => Promise<TestRunContext> | TestRunContext;
  /** Judge per file from the raw log (`--shard-size`). */
  perFile?: boolean;
}

/**
 * Derives the aggregate classification for a sharded run: all-green is
 * `tests-ran-ok`. Otherwise the most structural failure wins. A crashed
 * shard makes the whole run `harness-crash`, then `no-tests`, then plain
 * `test-failures`, so the aggregate `reason=` keeps the classifier-driven
 * contract instead of collapsing every failure to `test-failures`.
 */
export function deriveAggregateShardVerdict(shards: ShardOutcome[]): HarnessRunVerdict {
  const kinds = new Set(shards.map(({ outcome }) => outcome.verdict.kind));
  if (kinds.has('harness-arguments')) return { kind: 'harness-arguments' };
  if (kinds.has('harness-crash')) return { kind: 'harness-crash' };
  if (kinds.has('no-tests')) return { kind: 'no-tests' };
  if (kinds.has('test-failures')) return { kind: 'test-failures' };
  return { kind: 'tests-ran-ok' };
}

/**
 * The `FIREFORGE-SHARD:` line for one finished shard: the verdict it would
 * have printed alone, plus `shard=<i>/<n>` and `path=<label>`. Never a
 * `FIREFORGE-VERDICT:` line, so the run keeps exactly one.
 */
export function formatShardLine(
  shard: ShardOutcome,
  index: number,
  total: number,
  failedFiles?: readonly string[]
): string {
  const body = formatFireforgeVerdictLine(shard.outcome.verdict).slice(
    'FIREFORGE-VERDICT: '.length
  );
  const files =
    failedFiles !== undefined && failedFiles.length > 0
      ? ` failed-files=${failedFiles.join(',')}`
      : '';
  return `FIREFORGE-SHARD: ${body} shard=${index + 1}/${total} path=${shard.label.replace(/\s+/g, '_')}${files}`;
}

function writeShardLine(line: string): void {
  process.stdout.write(`${line}\n`);
  writeToActiveRunLog(`${line}\n`);
}

/** True when a raw-log test id names the dispatched path. */
function namesPath(test: string, path: string): boolean {
  return test === path || test.endsWith(`/${path}`) || path.endsWith(`/${test}`);
}

/**
 * The files of one shard that did not pass, judged from its raw log. A file
 * with no `test_end` failed (it never started, or never finished). Returns
 * undefined when the shard wrote no raw log, so the caller judges the
 * shard as a whole.
 */
export function failedFilesOf(shard: ShardOutcome): string[] | undefined {
  const results = shard.outcome.fileResults;
  if (results === undefined || shard.paths === undefined) return undefined;
  return shard.paths.filter((path) => {
    const result = results.find((entry) => namesPath(entry.test, path));
    return result === undefined || result.unexpected;
  });
}

function reportShardFailure(
  ctx: TestRunContext,
  outcome: TestRunOutcome,
  label: string,
  diagnoseShardFailure: (outcome: TestRunOutcome, label: string) => string | undefined
): void {
  if (outcome.verdict.kind === 'harness-crash' && outcome.verdict.signature) {
    const base = buildHarnessCrashMessage(outcome.verdict.signature, outcome.attempts);
    const hint = headedNoOutputTimeoutHint(outcome.verdict.signature, {
      headless: ctx.headless,
      platform: getPlatform(),
      ...(outcome.displayState !== undefined ? { displayState: outcome.displayState } : {}),
    });
    warn(hint ? `${base}\n\n${hint}` : base);
  } else if (outcome.verdict.kind !== 'tests-ran-ok') {
    const diagnosis = diagnoseShardFailure(outcome, label);
    if (diagnosis) warn(diagnosis);
  }
}

/**
 * Runs `count` items on up to `jobs` workers at once. Worker `w` handles
 * the items it takes in order, and results keep item order.
 */
async function runPool<T>(
  count: number,
  jobs: number,
  worker: (item: number, workerIndex: number) => Promise<T>
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, count)) }, async (_, w) => {
    while (next < count) {
      const item = next;
      next += 1;
      results[item] = await worker(item, w);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Runs each shard as its own harness invocation and prints an aggregate
 * report. Per-shard failures are diagnosed via `diagnoseShardFailure`
 * (which receives the throwing diagnosis chain from the command layer)
 * but downgraded to warnings so every shard runs. The aggregate verdict
 * line and the aggregate error are not produced here: the caller runs
 * the engine-generation integrity check first and then calls
 * {@link finalizeShardedOutcome}, so a run invalidated by a concurrent
 * `engine/` mutation can never print `PASS` before the check fails.
 */
export async function runShardedTests(
  ctx: TestRunContext,
  groups: ShardGroup[],
  diagnoseShardFailure: (outcome: TestRunOutcome, label: string) => string | undefined,
  options: ShardRunOptions = {}
): Promise<ShardedRunSummary> {
  const jobs = options.jobs ?? 1;
  const contexts = new Map<number, TestRunContext>([[0, ctx]]);
  const contextFor = async (index: number): Promise<TestRunContext> => {
    const known = contexts.get(index);
    if (known !== undefined) return known;
    const made = options.contextFor === undefined ? ctx : await options.contextFor(index);
    contexts.set(index, made);
    return made;
  };
  let finished = 0;
  const shards = await runPool(groups.length, jobs, async (index, workerIndex) => {
    const group = groups[index] as ShardGroup;
    const instance = await contextFor(workerIndex);
    info(
      `— Shard ${index + 1}/${groups.length}${jobs > 1 ? ` [job ${workerIndex + 1}]` : ''}: ${group.label}`
    );
    const outcome = await runTestsWithRetries(instance, group.paths, group.label);
    // Perf power-source changes are recorded on the instance's context.
    if (instance.powerChanged === true) ctx.powerChanged = true;
    const shard: ShardOutcome = { label: group.label, outcome, paths: group.paths };
    reportShardFailure(instance, outcome, group.label, diagnoseShardFailure);
    finished += 1;
    writeShardLine(
      formatShardLine(
        shard,
        index,
        groups.length,
        options.perFile === true ? failedFilesOf(shard) : undefined
      )
    );
    reportProgress(finished, groups.length, jobs);
    return shard;
  });

  return summarizeShards(shards, options.perFile === true);
}

function reportProgress(finished: number, total: number, jobs: number): void {
  if (jobs > 1) info(`${finished}/${total} shard(s) finished.`);
}

/**
 * Builds the summary box and the counts. Per-file judging counts every
 * dispatched file of a shard that wrote a raw log; a shard without one
 * counts as a whole.
 */
function summarizeShards(shards: ShardOutcome[], perFile: boolean): ShardedRunSummary {
  const lines = shards.map(
    ({ label, outcome }) =>
      `${SHARD_STATUS_LABEL[outcome.verdict.kind].padEnd(8)} ${label}` +
      (outcome.attempts > 1 ? `  (${outcome.attempts} attempts)` : '')
  );
  const failingShards = shards.filter(({ outcome }) => outcome.verdict.kind !== 'tests-ran-ok');
  let passed = shards.length - failingShards.length;
  let total = shards.length;
  let failed = failingShards.map(({ label }) => label);
  if (perFile) {
    passed = 0;
    total = 0;
    failed = [];
    for (const shard of shards) {
      const files = failedFilesOf(shard);
      const ok = shard.outcome.verdict.kind === 'tests-ran-ok';
      if (files === undefined) {
        total += 1;
        if (ok) passed += 1;
        else failed.push(shard.label);
        continue;
      }
      const dispatched = shard.paths ?? [];
      total += dispatched.length;
      // A red shard whose log names no failing file still failed: count
      // every file of it, so a crash cannot read as all-green.
      const red = files.length === 0 && !ok ? dispatched : files;
      passed += dispatched.length - red.length;
      failed.push(...red);
    }
  }
  note(
    `${lines.join('\n')}\n\n${passed}/${total} ${perFile ? 'file(s)' : 'shard(s)'} passed`,
    'Sharded Test Summary'
  );
  return { shards, passed, total, failed, aggregate: deriveAggregateShardVerdict(shards) };
}

/**
 * Emits the aggregate FIREFORGE-VERDICT line for a sharded run, then
 * throws the aggregate error when any shard did not pass, the same
 * emit-then-throw shape as `finalizeSingleRunOutcome`. Called only after
 * the engine-generation check succeeded.
 */
export function finalizeShardedOutcome(summary: ShardedRunSummary): void {
  emitHarnessVerdict(summary.aggregate, {
    passed: summary.passed,
    total: summary.total,
    failed: summary.failed.map((label) => label.replace(/\s+/g, '_')),
  });
  if (summary.passed < summary.total) {
    throw new TestFailureError(
      `${summary.failed.length} of ${summary.total} sharded test run(s) did not pass: ` +
        `${summary.failed.join(', ')}. ` +
        'See the per-shard diagnosis above. Use --no-shard to reproduce the combined single-invocation behaviour.',
      'mach test',
      undefined,
      getActiveRunLogPath()
    );
  }
}

/**
 * Splits the dispatch paths of every group into consecutive chunks of at
 * most `size` files (`--shard-size`). Order is kept, and a chunk never
 * mixes groups' order: it is the flattened request, cut every `size`
 * files.
 */
export function chunkShardGroups(groups: readonly ShardGroup[], size: number): ShardGroup[] {
  const paths = groups.flatMap((group) => group.paths);
  const chunks: ShardGroup[] = [];
  for (let start = 0; start < paths.length; start += size) {
    const chunk = paths.slice(start, start + size);
    const first = chunk[0] ?? '';
    chunks.push({
      label: chunk.length === 1 ? first : `${first}+${chunk.length - 1}`,
      paths: chunk,
    });
  }
  return chunks;
}

/**
 * Splits one combined request into `parts` contiguous chunks of near-equal
 * size, in order (`--jobs` with `--no-shard`).
 */
export function splitContiguous(paths: readonly string[], parts: number): ShardGroup[] {
  const count = Math.max(1, Math.min(parts, paths.length));
  const groups: ShardGroup[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const size = Math.ceil((paths.length - start) / (count - index));
    const chunk = paths.slice(start, start + size);
    start += size;
    const first = chunk[0] ?? '';
    groups.push({
      label: chunk.length === 1 ? first : `${first}+${chunk.length - 1}`,
      paths: chunk,
    });
  }
  return groups;
}
