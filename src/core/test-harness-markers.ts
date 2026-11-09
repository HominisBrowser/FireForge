// SPDX-License-Identifier: EUPL-1.2
/**
 * The lines of a harness log that count, and where they count. A marker reads only
 * at the position the harness writes it, so a test that logs one changes nothing.
 */

/** Numeric counts parsed from the harness's embedded result summary. */
export interface HarnessSummaryCounts {
  /** Total checks the suite ran (`Ran N checks`), when the summary prints one. */
  checks?: number;
  /** Unexpected-result count (`Unexpected results: N`), when the summary prints one. */
  unexpected?: number;
}

/**
 * What may precede a marker on a line the harness itself wrote: an instance
 * label (`[job 2] `), mozlog's elapsed time, a mochitest line counter, and a log
 * level with its xpcshell `INFO | ` form. A test's own output reaches the log behind `console.log:`, `GECKO(n)`
 * or similar text, so a marker it prints does not sit at this position.
 */
const HARNESS_LINE_PREFIX = String.raw`^[ \t]*(?:\[[^\]\n]*\][ \t]+)?(?:\d+:\d+(?:\.\d+)?[ \t]+)*(?:\d+[ \t]+)?(?:(?:INFO|WARNING|ERROR|CRITICAL|DEBUG)[ \t]+){0,2}(?:\|[ \t]+)?`;

function harnessLine(body: string, flags = 'm'): RegExp {
  return new RegExp(`${HARNESS_LINE_PREFIX}${body}`, flags);
}

/**
 * Any start marker that names a test. mochitest closes every browser run with
 * `TEST-START | Shutdown`, which announces the harness's own teardown and has
 * no end marker.
 */
export const EXECUTION_START_PATTERN = harnessLine(
  String.raw`TEST[-_]START\b(?![:| \t]*Shutdown[ \t]*$)`
);
export const SUITE_END_PATTERN = harnessLine(String.raw`SUITE_END\b`);
export const GREEN_UNEXPECTED_SUMMARY_PATTERN = harnessLine(
  String.raw`Unexpected results:[ \t]*0+\b`
);
export const NONZERO_UNEXPECTED_SUMMARY_PATTERN = harnessLine(
  String.raw`Unexpected results:[ \t]*0*[1-9]`
);
/** A summary's count, alone on its line or as `Passed: n / Failed: n`. */
const FAILED_SUMMARY_PREFIX = String.raw`(?:Passed:[ \t]*\d+[ \t]*/[ \t]*)?Failed:[ \t]*`;
export const NONZERO_FAILED_SUMMARY_PATTERN = harnessLine(
  `${FAILED_SUMMARY_PREFIX}0*[1-9]\\d*[ \\t]*$`
);
export const POSITIVE_PASSED_SUMMARY_PATTERN = harnessLine(String.raw`Passed:[ \t]*0*[1-9]\d*\b`);
export const ZERO_PASSED_SUMMARY_PATTERN = harnessLine(String.raw`Passed:[ \t]*0+\b`);
/**
 * Execution signals emitted by the suite-specific xpcshell dispatch
 * (`mach xpcshell-test`), which does not print `TEST-START` lines the way
 * the generic `mach test` / browser-chrome dispatch does. A passing
 * single-file xpcshell run prints a result-summary block instead
 * (`TEST_END: Test PASS`, `Ran 16 checks`, `Unexpected results: 0`), so
 * keying execution purely on `TEST-START` mis-reads a green xpcshell run as
 * "no tests started".
 *
 * These markers are xpcshell-specific on purpose: the bare `Passed: 0` /
 * `Failed: 0` summary that the no-output hang shape prints is deliberately
 * not matched here, because that case must still read as `no-tests`. `Ran 0
 * checks` is that same hang's other spelling, so only a positive count is
 * evidence that something ran.
 */
export const XPCSHELL_RESULT_SUMMARY_PATTERN = harnessLine(
  String.raw`(?:TEST_END\b|Ran [1-9]\d* checks?\b|Result summary:)`,
  'im'
);
/** Basename shape of a mozbuild-manifest test implementation file. */
export const TEST_FILE_BASENAME_PATTERN = /^(?:browser|test)_.*\.m?js$/;

/**
 * Start/end execution markers, both log dialects: the structured mozlog
 * `TEST_START`/`TEST_END` pair and the human browser-chrome
 * `TEST-START`/`TEST-OK` pair. `TEST-UNEXPECTED-*` end shapes are
 * irrelevant here, since any such line already fails the green-summary check
 * before completeness is consulted.
 */
const START_MARKER_PATTERN = harnessLine(String.raw`TEST[-_]START\b[:| \t]*(\S+)?`);
const END_MARKER_PATTERN = harnessLine(String.raw`(?:TEST_END\b|TEST-OK\b)`);
const SKIP_MARKER_PATTERN = harnessLine(String.raw`TEST[-_]SKIP(?:PED)?\b[:| \t]*(\S+)?`);

/**
 * The test a harness start line names, or undefined for any other line and for
 * the harness's own `TEST-START | Shutdown`.
 *
 * @param line - One output line
 */
export function parseStartMarker(line: string): { name: string | undefined } | undefined {
  const match = START_MARKER_PATTERN.exec(line);
  if (match === null) return undefined;
  return match[1] === 'Shutdown' ? undefined : { name: match[1] };
}

/**
 * The test a harness skip line names (`TEST-SKIP | path`, `TEST_SKIP: path`), when it names one.
 *
 * @param line - One output line
 */
export function parseSkipMarker(line: string): string | undefined {
  return SKIP_MARKER_PATTERN.exec(line)?.[1];
}

/**
 * Cross-checks run completeness against the requested test files: every
 * requested file must produce a start marker, and every started test must
 * produce an end marker (the harness emits both even for failing files).
 *
 * Ends are paired with starts positionally (last open start is closed by
 * the next end), not by filename: the xpcshell dialect's `TEST_END: Test
 * PASS` lines do not name the file. Requested paths that are not
 * test-file-shaped (directories, manifests) are skipped for the
 * never-started check. The start/end pairing scan covers them regardless.
 * Exported for direct unit testing.
 *
 * @param output - Captured output, which keeps only the tail of a long run
 * @param requestedPaths - Dispatched paths
 * @param streamedStarts - Start names seen in the complete stream, when known
 */
export function analyzeTestCompleteness(
  output: string,
  requestedPaths: readonly string[],
  streamedStarts: readonly string[] = []
): { neverStarted: string[]; neverEnded: string[] } {
  const startedNames: string[] = [...streamedStarts];
  const openTests: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const start = parseStartMarker(line);
    if (start !== undefined) {
      const name = start.name ?? '(unnamed test)';
      startedNames.push(name);
      openTests.push(name);
      continue;
    }
    if (END_MARKER_PATTERN.test(line)) {
      openTests.pop();
    }
  }

  const neverStarted = requestedPaths.filter((path) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!TEST_FILE_BASENAME_PATTERN.test(base)) return false;
    return !startedNames.some((name) => name.includes(base));
  });

  return { neverStarted, neverEnded: openTests };
}

/**
 * Parses the numeric counts from the harness's embedded result summary
 * (`Ran N checks` / `Unexpected results: N`). The last occurrence of each
 * wins: a multi-suite run prints one summary per suite and the final one
 * covers the aggregate the operator sees. Absent counts are omitted (the
 * `FIREFORGE-VERDICT:` contract: an absent key means "summary did not
 * print it", never zero).
 */
export function extractSummaryCounts(output: string): HarnessSummaryCounts {
  const checks = lastCapturedCount(output, harnessLine(String.raw`Ran (\d+) checks?\b`, 'gm'));
  const unexpected = lastCapturedCount(
    output,
    harnessLine(String.raw`Unexpected results:[ \t]*(\d+)\b`, 'gm')
  );
  return {
    ...(checks !== undefined ? { checks } : {}),
    ...(unexpected !== undefined ? { unexpected } : {}),
  };
}

/** Last captured integer for `pattern` in `output`, if any occurrence matches. */
function lastCapturedCount(output: string, pattern: RegExp): number | undefined {
  let last: number | undefined;
  for (const match of output.matchAll(pattern)) {
    const captured = match[1];
    if (captured !== undefined) {
      last = Number.parseInt(captured, 10);
    }
  }
  return last;
}

/** Offset of the last harness `SUITE_END` line, or -1. */
export function lastSuiteEndOffset(output: string): number {
  let last = -1;
  for (const match of output.matchAll(new RegExp(SUITE_END_PATTERN.source, 'gm'))) {
    last = match.index;
  }
  return last;
}
