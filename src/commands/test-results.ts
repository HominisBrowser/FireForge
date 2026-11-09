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
import type {
  TestControlEvidence,
  TestFileResult,
  TestResultsDocument,
} from '../core/test-results-document.js';
import { CONTROL_BASELINE_REPETITION } from '../core/test-results-document.js';
import type { StartMarkers } from '../core/test-run-completeness.js';
import { writeJson } from '../utils/fs.js';

/**
 * The `test` id mozlog gives a result the harness itself reports, such as
 * the no-output TIMEOUT of a hung browser: a record that names no test
 * file. It keeps that id, and gains the shard's files so a consumer can
 * attribute it without matching `shard` labels back to paths.
 */
const HARNESS_PSEUDO_TEST = 'automation.py';

/** Append only after restoration was checked against the control's byte and mode journal. */
export function recordControlEvidence(evidence: TestControlEvidence): void {
  (collected.controls ??= []).push(evidence);
}

/** A compiled mutation is not cleaned up until the clean binary was rebuilt too. */
export function recordCompiledControlRestore(state: 'done' | 'failed' | 'not-built'): void {
  for (const control of collected.controls ?? [])
    if (control.compiled) control.compiledRestoreBuild = state;
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
 * @param context - Run, shard and run-log line of the dispatch, and the
 *   shard's dispatched files for harness pseudo-records
 */
export function recordTestResults(
  results: readonly RawTestResult[],
  unfinished: readonly string[],
  context: {
    run: number;
    shard: string;
    logLine: number;
    shardFiles?: readonly string[];
    markers?: StartMarkers;
    attempts?: number;
  }
): void {
  const { shardFiles, markers, attempts, ...dispatch } = context;
  if (markers !== undefined) {
    (collected.dispatches ??= []).push({
      run: context.run,
      shard: context.shard,
      requested: [...(shardFiles ?? [])],
      started: [...markers.started],
      completed: results
        .filter((result) => result.test !== HARNESS_PSEUDO_TEST)
        .map((result) => result.test),
      skipped: [...markers.skipped],
      unfinished: [...unfinished],
      attempts: attempts ?? 1,
    });
  }
  const target =
    context.run === CONTROL_BASELINE_REPETITION
      ? (collected.controlBaseline ??= { files: [], unfinished: [] })
      : collected;
  for (const result of results) {
    target.files.push({ ...result, ...dispatch, ...harnessRecordFiles(result, shardFiles) });
  }
  for (const test of unfinished) {
    target.unfinished.push({ test, run: context.run, shard: context.shard });
  }
}

/** The `shardFiles`/`file` keys a harness pseudo-record gains. */
function harnessRecordFiles(
  result: RawTestResult,
  shardFiles: readonly string[] | undefined
): Pick<TestFileResult, 'shardFiles' | 'file'> {
  if (result.test !== HARNESS_PSEUDO_TEST || shardFiles === undefined) return {};
  const only = shardFiles.length === 1 ? shardFiles[0] : undefined;
  return { shardFiles: [...shardFiles], ...(only === undefined ? {} : { file: only }) };
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
