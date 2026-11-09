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

import type { AssertionResult } from './control-assertions.js';
import type { RawRunSummary, StartMarkers } from './test-harness-signature.js';

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
  /** Exact unexpected assertion labels reported by mozlog test_status. */
  unexpectedAssertions?: string[];
  /**
   * Status pairs distinguish assertion failures from an unexpected pass. An
   * xpcshell red's `assertion` is its task, and `message` its assertion's text.
   */
  unexpectedAssertionResults?: AssertionResult[];
}

/** Everything one raw log says about the run. */
export interface RawTestLog {
  /** Files in `test_end` order. A started file with no end is not listed. */
  results: RawTestResult[];
  /** Start markers for the completeness veto: every `test_start` id. */
  markers: StartMarkers;
  /** Started tests that never ended (a crash or a cut-off run). */
  unfinished: string[];
  /** A `suite_end` closed every `suite_start`. mozlog opens every log with one. */
  suiteCompleted: boolean;
  /**
   * Every test id the `suite_start` records announced, once each, groups in
   * sorted key order. mozlog writes `tests` as a map of group (a manifest) to
   * ids, a list being stored as the group `default`; a run can write several
   * `suite_start` records, and their rosters are joined.
   */
  roster: string[];
}

interface RawRecord {
  action?: unknown;
  test?: unknown;
  status?: unknown;
  expected?: unknown;
  time?: unknown;
  subtest?: unknown;
  message?: unknown;
  known_intermittent?: unknown;
  tests?: unknown;
}

/**
 * The test ids one `suite_start` announces. Groups go in sorted key order, the
 * order mochitest runs its manifests in, so the first id never started is
 * where the run stopped.
 */
function rosterOf(tests: unknown): string[] {
  const groups: unknown[] = Array.isArray(tests)
    ? [tests]
    : typeof tests === 'object' && tests !== null
      ? Object.keys(tests)
          .sort()
          .map((key) => (tests as Record<string, unknown>)[key])
      : [];
  return groups.flatMap((ids) =>
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  );
}

/** mozlog's own test: a status listed as a known intermittent is not unexpected. */
function isUnexpectedStatus(record: RawRecord): boolean {
  if (typeof record.expected !== 'string' || record.expected === record.status) return false;
  return !(
    Array.isArray(record.known_intermittent) && record.known_intermittent.includes(record.status)
  );
}

/**
 * The assertion text of an xpcshell red. xpcshell's head reports a failure as
 * `[<task> : <line>] <text>` with the task as its `subtest`; that prefix is
 * what tells its message apart from a mochitest's diagnostic.
 */
function xpcshellAssertionMessage(subtest: string, message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const prefix = `[${subtest} : `;
  if (!message.startsWith(prefix)) return undefined;
  const text = /^\d+\] ([\s\S]+)$/.exec(message.slice(prefix.length))?.[1];
  return text?.trim() === '' ? undefined : text;
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
  const assertions = new Map<string, AssertionResult[]>();
  let suitesStarted = 0;
  let suitesEnded = 0;
  const roster = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const record = parseRecord(line.trim());
    if (record?.action === 'suite_start') {
      suitesStarted += 1;
      for (const id of rosterOf(record.tests)) roster.add(id);
    }
    if (record?.action === 'suite_end') suitesEnded += 1;
    if (record === undefined || typeof record.test !== 'string') continue;
    const test = record.test;
    if (record.action === 'test_start') {
      started.push(test);
      if (typeof record.time === 'number') startTimes.set(test, record.time);
      continue;
    }
    if (
      record.action === 'test_status' &&
      typeof record.expected === 'string' &&
      typeof record.status === 'string' &&
      isUnexpectedStatus(record)
    ) {
      // mozlog sets `expected` on a status record only when it differs.
      subtestFailures.set(test, (subtestFailures.get(test) ?? 0) + 1);
      if (typeof record.subtest === 'string') {
        const message = xpcshellAssertionMessage(record.subtest, record.message);
        assertions.set(test, [
          ...(assertions.get(test) ?? []),
          {
            assertion: record.subtest,
            status: record.status,
            expected: record.expected,
            ...(message === undefined ? {} : { message }),
          },
        ]);
      }
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
      unexpected: isUnexpectedStatus(record) || unexpectedSubtests > 0,
      unexpectedSubtests,
      ...(assertions.has(test)
        ? {
            unexpectedAssertions: (assertions.get(test) ?? []).map((result) => result.assertion),
            unexpectedAssertionResults: assertions.get(test) ?? [],
          }
        : {}),
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
    suiteCompleted: suitesEnded === suitesStarted,
    roster: [...roster],
  };
}

/**
 * The classifier's view of a raw log.
 *
 * @param log - A parsed raw log
 */
export function summarizeRawLog(log: RawTestLog): RawRunSummary {
  return { testsEnded: log.results.length, suiteCompleted: log.suiteCompleted };
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

/**
 * True when the dispatch arguments make mochitest pass over announced tests
 * without a start or skip record: `--start-at` and `--end-at` trim the list in
 * the browser, after `suite_start` named every test.
 *
 * @param args - The dispatch's extra mach arguments
 */
export function trimsAnnouncedTests(args: readonly string[]): boolean {
  return args.some((arg) => /^--(?:start|end)-at(?:=|$)/.test(arg));
}

/** True when the dispatch arguments already carry any `--log-raw`. */
export function hasForwardedRawLog(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--log-raw' || arg.startsWith('--log-raw='));
}
