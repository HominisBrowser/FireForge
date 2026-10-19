// SPDX-License-Identifier: EUPL-1.2
/**
 * The mozlog structured ("raw") log of one mach test dispatch.
 *
 * Everything else FireForge reads from a run is human text: the
 * `TEST_START`/`TEST_END` lines and the `Unexpected results:` summary, in two
 * dialects, out of a capture that keeps only its last 2 MB. A gate that
 * wants to name the files a run failed had to regex that text, and agent-
 * quiet mozbuild drops `TEST_START` from it altogether. The raw log is the
 * record the summary itself is computed from: one JSON object per line,
 * with `test_start`, `test_status` and `test_end` actions naming each test
 * by its manifest id.
 *
 * It is requested per dispatch with mozlog's `--log-raw=<path>`, which
 * `mach test`, `mach mochitest` and `mach xpcshell-test` all accept, only
 * when a run asks for per-file results (`--results`, `--shard-size`).
 */

import { readFile } from 'node:fs/promises';

import type { StartMarkers } from './test-run-completeness.js';

/** One test file's outcome, from its `test_end` and failing `test_status` records. */
export interface RawTestResult {
  /** The test id mozlog reports (a manifest-relative path). */
  test: string;
  /** `test_end` status (`OK`, `PASS`, `FAIL`, `ERROR`, `TIMEOUT`, `CRASH`, `SKIP`). */
  status: string;
  /** Expected status; equal to `status` when mozlog omitted it. */
  expected: string;
  /** True when the file ended unexpectedly or any subtest did. */
  unexpected: boolean;
  /** Subtests that reported an unexpected status. */
  unexpectedSubtests: number;
  /** Wall time between `test_start` and `test_end`, when both carried a time. */
  durationMs?: number;
}

/** Everything one raw log says about the run. */
export interface RawTestLog {
  /** Files in `test_end` order. A started file with no end is not listed. */
  results: RawTestResult[];
  /** Start markers for the completeness veto: every `test_start` id. */
  markers: StartMarkers;
  /** Started tests that never ended (a crash or a cut-off run). */
  unfinished: string[];
}

interface RawRecord {
  action?: unknown;
  test?: unknown;
  status?: unknown;
  expected?: unknown;
  time?: unknown;
}

function parseRecord(line: string): RawRecord | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    // A line cut off by a killed harness is not a record.
    return undefined;
  }
}

/**
 * Parses a mozlog raw log. Unknown actions and malformed lines are skipped,
 * so a log truncated by a crash still yields the files that finished.
 *
 * @param text - The raw log's contents
 */
export function parseRawTestLog(text: string): RawTestLog {
  const results: RawTestResult[] = [];
  const started: string[] = [];
  const startTimes = new Map<string, number>();
  const subtestFailures = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const record = parseRecord(line.trim());
    if (record === undefined || typeof record.test !== 'string') continue;
    const test = record.test;
    if (record.action === 'test_start') {
      started.push(test);
      if (typeof record.time === 'number') startTimes.set(test, record.time);
      continue;
    }
    if (record.action === 'test_status' && typeof record.expected === 'string') {
      // mozlog sets `expected` on a status record only when it differs.
      subtestFailures.set(test, (subtestFailures.get(test) ?? 0) + 1);
      continue;
    }
    if (record.action !== 'test_end' || typeof record.status !== 'string') continue;
    const expected = typeof record.expected === 'string' ? record.expected : record.status;
    const unexpectedSubtests = subtestFailures.get(test) ?? 0;
    const start = startTimes.get(test);
    results.push({
      test,
      status: record.status,
      expected,
      unexpected: expected !== record.status || unexpectedSubtests > 0,
      unexpectedSubtests,
      ...(start !== undefined && typeof record.time === 'number'
        ? { durationMs: record.time - start }
        : {}),
    });
  }
  const ended = new Set(results.map((result) => result.test));
  return {
    results,
    markers: {
      started,
      skipped: results.filter((r) => r.status === 'SKIP').map((r) => r.test),
    },
    unfinished: started.filter((test) => !ended.has(test)),
  };
}

/**
 * Reads and parses a raw log. Returns undefined when the file is missing or
 * unreadable (the harness never started, or the engine's mach ignored the
 * flag), so callers fall back to the streamed text.
 *
 * @param path - The `--log-raw` destination
 */
export async function readRawTestLog(path: string): Promise<RawTestLog | undefined> {
  try {
    return parseRawTestLog(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The `--log-raw` destination the operator already forwarded with
 * `--mach-arg`, when it names a file. FireForge then reads that file instead
 * of adding its own flag, so the operator's log is not replaced.
 *
 * @param args - The dispatch's extra mach arguments
 */
export function forwardedRawLogPath(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = arg.startsWith('--log-raw=')
      ? arg.slice('--log-raw='.length)
      : arg === '--log-raw'
        ? args[index + 1]
        : undefined;
    if (value !== undefined) return value === '-' ? undefined : value;
  }
  return undefined;
}

/** True when the dispatch arguments already carry any `--log-raw`. */
export function hasForwardedRawLog(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--log-raw' || arg.startsWith('--log-raw='));
}
