// SPDX-License-Identifier: EUPL-1.2
/**
 * The mozlog structured ("raw") log of one dispatch: one JSON object per line,
 * with `suite_start`, `test_start`, `test_status`, `test_end` and `suite_end`
 * actions naming each test by its manifest id. It is the record the harness's
 * own summary is computed from, so a dispatch that wrote one is judged by it
 * rather than by its human-readable text. `mach test`, `mach mochitest` and
 * `mach xpcshell-test` all write it for `--log-raw=<path>`.
 */
import { readTextIfExists } from '../kernel/fs.js';
import { isRecord, parseJson } from '../kernel/json.js';

/**
 * One red, as the harness labels it. mozlog's `subtest` is a mochitest's
 * assertion message and an xpcshell test's task name; an xpcshell red also
 * carries its assertion's own text, which is `message`.
 */
export interface AssertionFailure {
  assertion: string;
  status: string;
  expected: string;
  message?: string;
}

/** One test file's outcome, from its `test_end` and unexpected `test_status` records. */
export interface RawTestResult {
  /** The id mozlog reports: an engine-relative path, or a harness pseudo-test such as `automation.py`. */
  test: string;
  /** `test_end` status: `OK`, `PASS`, `FAIL`, `ERROR`, `TIMEOUT`, `CRASH`, `SKIP`. */
  status: string;
  /** Expected status; equal to `status` when mozlog omitted it. */
  expected: string;
  /** The file ended unexpectedly or any subtest did. */
  unexpected: boolean;
  /** Subtests that reported an unexpected status, the unexpected passes included. */
  failures: AssertionFailure[];
  /** Wall time between `test_start` and `test_end`, when both carried a time. */
  durationMs?: number;
}

/** Everything one raw log says about a dispatch. */
export interface RawTestLog {
  /** Files in `test_end` order. */
  results: RawTestResult[];
  /** Every `test_start` id, in order. */
  started: string[];
  /** Ids of files that ended `SKIP`. */
  skipped: string[];
  /** Started tests that never ended: a crash or a cut-off run. */
  unfinished: string[];
  /** A `suite_end` closed every `suite_start`. */
  suiteCompleted: boolean;
  /**
   * Every test id the `suite_start` records announced, once each. mozlog
   * writes `tests` as a map of group (a manifest) to ids, a list being the
   * group `default`; groups go in sorted key order, the order mochitest runs
   * its manifests in.
   */
  roster: string[];
}

function rosterOf(tests: unknown): string[] {
  const groups: unknown[] = Array.isArray(tests)
    ? [tests]
    : isRecord(tests)
      ? Object.keys(tests)
          .sort()
          .map((key) => tests[key])
      : [];
  return groups.flatMap((ids) =>
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  );
}

/** mozlog's own rule: a status listed as a known intermittent is not unexpected. */
function isUnexpected(record: Record<string, unknown>): boolean {
  if (typeof record['expected'] !== 'string' || record['expected'] === record['status']) {
    return false;
  }
  const known = record['known_intermittent'];
  return !(Array.isArray(known) && known.includes(record['status']));
}

/**
 * The assertion text of an xpcshell red. xpcshell's head reports a failure as
 * `[<task> : <line>] <text>` with the task as its `subtest`; that prefix is
 * what tells its message apart from a mochitest's diagnostic.
 */
function xpcshellAssertionText(subtest: string, message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const prefix = `[${subtest} : `;
  if (!message.startsWith(prefix)) return undefined;
  const text = /^\d+\] ([\s\S]+)$/.exec(message.slice(prefix.length))?.[1];
  return text === undefined || text.trim() === '' ? undefined : text;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const parsed = parseJson(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // A line cut off by a killed harness is not a record.
    return undefined;
  }
}

/**
 * Parses a raw log. Unknown actions and malformed lines are skipped, so a
 * log truncated by a crash still yields the files that finished.
 *
 * @param text - The raw log's contents
 */
export function parseRawTestLog(text: string): RawTestLog {
  const results: RawTestResult[] = [];
  const started: string[] = [];
  const startTimes = new Map<string, number>();
  const failures = new Map<string, AssertionFailure[]>();
  const roster = new Set<string>();
  let suitesStarted = 0;
  let suitesEnded = 0;
  for (const line of text.split(/\r?\n/)) {
    const record = parseRecord(line.trim());
    if (record === undefined) continue;
    const action = record['action'];
    if (action === 'suite_start') {
      suitesStarted += 1;
      for (const id of rosterOf(record['tests'])) roster.add(id);
    }
    if (action === 'suite_end') suitesEnded += 1;
    const test = record['test'];
    const status = record['status'];
    if (typeof test !== 'string') continue;
    if (action === 'test_start') {
      started.push(test);
      if (typeof record['time'] === 'number') startTimes.set(test, record['time']);
    } else if (action === 'test_status' && typeof status === 'string' && isUnexpected(record)) {
      const subtest = typeof record['subtest'] === 'string' ? record['subtest'] : '';
      const message = xpcshellAssertionText(subtest, record['message']);
      failures.set(test, [
        ...(failures.get(test) ?? []),
        {
          assertion: subtest,
          status,
          expected: String(record['expected']),
          ...(message === undefined ? {} : { message }),
        },
      ]);
    } else if (action === 'test_end' && typeof status === 'string') {
      const own = failures.get(test) ?? [];
      const start = startTimes.get(test);
      results.push({
        test,
        status,
        expected: typeof record['expected'] === 'string' ? record['expected'] : status,
        unexpected: isUnexpected(record) || own.length > 0,
        failures: own,
        ...(start !== undefined && typeof record['time'] === 'number'
          ? { durationMs: record['time'] - start }
          : {}),
      });
    }
  }
  const ended = new Set(results.map((result) => result.test));
  return {
    results,
    started,
    skipped: results.filter((result) => result.status === 'SKIP').map((result) => result.test),
    unfinished: started.filter((test) => !ended.has(test)),
    suiteCompleted: suitesEnded === suitesStarted,
    roster: [...roster],
  };
}

/**
 * Reads and parses a raw log.
 *
 * @param path - The `--log-raw` destination
 * @returns Undefined when the harness never wrote it
 * @throws When the log exists and cannot be read: evidence that is there but
 *   unreadable is not the same as none
 */
export async function readRawTestLog(path: string): Promise<RawTestLog | undefined> {
  const text = await readTextIfExists(path);
  return text === undefined ? undefined : parseRawTestLog(text);
}
