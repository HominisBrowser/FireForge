// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge test --results <path>`: one record per test file and per
 * `--repeat` run, from the mozlog raw log each dispatch writes.
 *
 * Gates and retry wrappers downstream named a run's failing files by
 * reading `TEST_START`/`TEST_END` lines and the prose of the "sharded test
 * run(s) did not pass" error out of the human log, which nothing promised
 * to keep stable. The results file is the stable form: JSON with a
 * `schemaVersion`, written once the invocation has finished, and named on
 * the verdict line as `results=<path>`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RawTestResult } from '../core/test-raw-log.js';
import { writeJson } from '../utils/fs.js';

/** One file's result in one dispatch. */
export interface TestFileResult extends RawTestResult {
  /** `--repeat` run (1-based); 1 for a single run. */
  run: number;
  /** The shard (path argument or `--shard-size` chunk) the file ran in. */
  shard: string;
  /** Line of the run log where this file's dispatch began (1-based). */
  logLine: number;
}

/** The document `--results` writes. */
export interface TestResultsDocument {
  schemaVersion: 1;
  /** Files in dispatch-completion order. */
  files: TestFileResult[];
  /** Started files that never ended, per dispatch. */
  unfinished: Array<{ test: string; run: number; shard: string }>;
}

let collected: TestResultsDocument = { schemaVersion: 1, files: [], unfinished: [] };

/** Clears the collector at the start of an invocation. */
export function resetTestResults(): void {
  collected = { schemaVersion: 1, files: [], unfinished: [] };
}

/**
 * Adds one dispatch's parsed raw log to the invocation's results.
 *
 * @param results - The dispatch's finished files
 * @param unfinished - Its started-but-unfinished files
 * @param context - Run, shard and run-log line of the dispatch
 */
export function recordTestResults(
  results: readonly RawTestResult[],
  unfinished: readonly string[],
  context: { run: number; shard: string; logLine: number }
): void {
  for (const result of results) collected.files.push({ ...result, ...context });
  for (const test of unfinished) {
    collected.unfinished.push({ test, run: context.run, shard: context.shard });
  }
}

/** The results collected so far (for tests and the shard summary). */
export function collectedTestResults(): TestResultsDocument {
  return collected;
}

/**
 * Writes the collected results.
 *
 * @param path - Destination of `--results`
 */
export async function writeTestResults(path: string): Promise<void> {
  await writeJson(path, collectedTestResults());
}

/**
 * Creates the scratch directory the dispatches' raw logs go to, runs
 * `body`, and removes it afterwards.
 *
 * @param body - Receives the directory
 */
export async function withRawLogDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fireforge-raw-log-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
