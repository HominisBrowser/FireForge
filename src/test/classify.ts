// SPDX-License-Identifier: EUPL-1.2
/**
 * What one harness dispatch proves. An exit code, or a grep for a summary,
 * cannot tell a test result from the harness failing around it:
 *
 *  - mach's system resource monitor (mozsystemmonitor over psutil) can raise
 *    at startup on a host that refuses its readings, before any test;
 *  - a browser that hangs after startup dies at the no-output timeout and
 *    still prints a `Passed: 0` summary;
 *  - a green run stalls on "must wait for focus" during teardown and records
 *    "Application shut down (without crashing) in the middle of a test!" as
 *    its only failure;
 *  - a browser that crashes at the second of eight files leaves a summary
 *    reading `Passed: 2 / Failed: 0`, and a browser that quits cleanly
 *    mid-suite lets mach exit 0;
 *  - a run whose tests all passed can exit non-zero on resource-monitor
 *    output printed after its suite closed.
 *
 * So the verdict keys on what the harness itself wrote where only the harness
 * writes it: start and end markers, the suite summary, crash markers, and the
 * structured raw log when the dispatch wrote one. A summary never counts as
 * proof that tests ran, a green summary never speaks for what happened after
 * it, and every requested file must start and finish.
 */
import type { RawTestLog } from './rawLog.js';

/** Counts from the harness's embedded summary. An absent key means it printed none, never zero. */
export interface SummaryCounts {
  /** `Ran N checks`. */
  checks?: number;
  /** `Unexpected results: N`. */
  unexpected?: number;
}

/** A recognized failure of the harness rather than of a test, with its evidence line. */
export interface CrashSignature {
  /** What was recognized, in words. */
  reason: string;
  /** The output line the recognition rests on. */
  line: string;
  /** `server-startup` when a mochitest server never came up; otherwise the verdict reads `crash`. */
  verdictReason?: 'server-startup';
  /** The harness's port and browser-wait lines before a startup timeout. */
  harnessLines?: string[];
}

/** Why a green-looking summary was not trusted. */
export interface GreenSummaryRejection {
  /** A browser crash marker. */
  crashLine?: string;
  /** Why the non-zero exit cannot be blamed on harness noise. */
  exitEvidence?: string;
  /** Requested test files with no start marker. */
  neverStarted: string[];
  /** Started files with no end marker. */
  neverEnded: string[];
}

/** Why a run that would have passed was failed by the completeness veto. */
export interface IncompleteRun {
  /** Requested files that produced a start or skip marker. */
  started: number;
  /** Requested files the run could account for. */
  requested: number;
  /** First requested file, in dispatch order, that never started. */
  firstUnstarted?: string;
  /** Where the start count came from: the raw log, the full stream, or the captured text. */
  startedSource?: 'raw' | 'stream' | 'capture';
  /** The harness's "shut down in the middle of a test" line. */
  shutdownLine?: string;
  /** The unexpected count, from the raw log when the dispatch wrote one. */
  unexpected?: number;
  /** Tests the raw log started and never ended. */
  unfinished?: string[];
  /** The signal the harness reported the browser died of. */
  appExit?: string;
}

/** What a dispatch proves. */
export type HarnessKind = 'pass' | 'test-failures' | 'crash' | 'no-tests';

/** The verdict on one dispatch. */
export interface HarnessVerdict extends SummaryCounts {
  kind: HarnessKind;
  /** For `crash`: what failed. */
  signature?: CrashSignature;
  /** The first concrete failure line. */
  failureLine?: string;
  /** The first unexpected lines, each with the assertion context under it. */
  failureBlocks?: string[];
  /** Harness noise seen beside a real failure. */
  secondary?: CrashSignature;
  /** A non-zero exit was overruled by a completed green summary that recognized noise explains. */
  greenSummaryOverride?: boolean;
  /** A green-looking summary was refused on crash or truncation evidence. */
  greenSummaryRejected?: GreenSummaryRejection;
  /** A short classification of how the verdict was reached, for the verdict line. */
  note?: string;
  /** Why a would-be pass was failed by the completeness veto. */
  incomplete?: IncompleteRun;
}

/** Start and skip marker names a run printed. */
export interface StartMarkers {
  started: string[];
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Markers. Each reads only at the position the harness writes it, so a test
// that logs a marker-shaped line changes nothing.
// ---------------------------------------------------------------------------

/**
 * What may precede a marker on a line the harness wrote: an instance label
 * (`[job 2] `), mozlog's elapsed time, a mochitest line counter, a log level
 * and xpcshell's `INFO | `. A test's own output reaches the log behind
 * `console.log:`, `GECKO(n)` or similar, so a marker it prints never sits here.
 */
const HARNESS_LINE_PREFIX = String.raw`^[ \t]*(?:\[[^\]\n]*\][ \t]+)?(?:\d+:\d+(?:\.\d+)?[ \t]+)*(?:\d+[ \t]+)?(?:(?:INFO|WARNING|ERROR|CRITICAL|DEBUG)[ \t]+){0,2}(?:\|[ \t]+)?`;

const harnessLine = (body: string, flags = 'm'): RegExp =>
  new RegExp(`${HARNESS_LINE_PREFIX}${body}`, flags);

/** A start marker that names a test; mochitest's `TEST-START | Shutdown` announces its own teardown. */
const EXECUTION_START = harnessLine(String.raw`TEST[-_]START\b(?![:| \t]*Shutdown[ \t]*$)`);
const SUITE_END = harnessLine(String.raw`SUITE_END\b`);
const GREEN_UNEXPECTED = harnessLine(String.raw`Unexpected results:[ \t]*0+\b`);
const NONZERO_UNEXPECTED = harnessLine(String.raw`Unexpected results:[ \t]*0*[1-9]`);
const NONZERO_FAILED = harnessLine(
  String.raw`(?:Passed:[ \t]*\d+[ \t]*/[ \t]*)?Failed:[ \t]*0*[1-9]\d*[ \t]*$`
);
const POSITIVE_PASSED = harnessLine(String.raw`Passed:[ \t]*0*[1-9]\d*\b`);
const ZERO_PASSED = harnessLine(String.raw`Passed:[ \t]*0+\b`);
/**
 * The suite-specific xpcshell dispatch prints no start lines, but its result
 * block proves tests ran. `Ran 0 checks` is the no-output hang's spelling, so
 * only a positive count counts.
 */
const XPCSHELL_RESULT_SUMMARY = harnessLine(
  String.raw`(?:TEST_END\b|Ran [1-9]\d* checks?\b|Result summary:)`,
  'im'
);
const START_MARKER = harnessLine(String.raw`TEST[-_]START\b[:| \t]*(\S+)?`);
const END_MARKER = harnessLine(String.raw`(?:TEST_END\b|TEST-OK\b)`);
const SKIP_MARKER = harnessLine(String.raw`TEST[-_]SKIP(?:PED)?\b[:| \t]*(\S+)?`);

/** Basename shape of a test file a manifest lists. */
const TEST_FILE_BASENAME = /^(?:browser|test)_.*\.m?js$/;

const lines = (text: string): string[] => text.split(/\r?\n/);

function findLine(output: string, patterns: readonly RegExp[]): string | undefined {
  for (const line of lines(output)) {
    if (patterns.some((pattern) => pattern.test(line))) return line.trim();
  }
  return undefined;
}

/**
 * The test a start line names, or undefined for any other line and for the
 * harness's own `TEST-START | Shutdown`.
 *
 * @param line - One output line
 */
function parseStartMarker(line: string): { name: string | undefined } | undefined {
  const match = START_MARKER.exec(line);
  if (match === null) return undefined;
  return match[1] === 'Shutdown' ? undefined : { name: match[1] };
}

function recordMarker(line: string, into: StartMarkers): void {
  const start = parseStartMarker(line)?.name;
  if (start !== undefined) {
    into.started.push(start);
    return;
  }
  const skip = SKIP_MARKER.exec(line)?.[1];
  if (skip !== undefined) into.skipped.push(skip);
}

/**
 * Collects start and skip markers line by line as output streams, so a run
 * whose captured text lost its beginning can still be counted. It grows with
 * the file count, not the output size.
 */
export function createMarkerTracker(): {
  line: (line: string) => void;
  markers: () => StartMarkers;
} {
  const collected: StartMarkers = { started: [], skipped: [] };
  return {
    line: (line) => {
      recordMarker(line, collected);
    },
    markers: () => ({ started: [...collected.started], skipped: [...collected.skipped] }),
  };
}

function scanMarkers(output: string): StartMarkers {
  const markers: StartMarkers = { started: [], skipped: [] };
  for (const line of lines(output)) recordMarker(line, markers);
  return markers;
}

function lastCount(output: string, pattern: RegExp): number | undefined {
  let last: number | undefined;
  for (const match of output.matchAll(pattern)) {
    if (match[1] !== undefined) last = Number.parseInt(match[1], 10);
  }
  return last;
}

/**
 * The counts of the embedded summary. The last occurrence of each wins: a
 * multi-suite run prints one summary per suite.
 *
 * @param output - Captured harness output
 */
export function extractSummaryCounts(output: string): SummaryCounts {
  const checks = lastCount(output, harnessLine(String.raw`Ran (\d+) checks?\b`, 'gm'));
  const unexpected = lastCount(
    output,
    harnessLine(String.raw`Unexpected results:[ \t]*(\d+)\b`, 'gm')
  );
  return {
    ...(checks === undefined ? {} : { checks }),
    ...(unexpected === undefined ? {} : { unexpected }),
  };
}

function lastSuiteEndOffset(output: string): number {
  let last = -1;
  for (const match of output.matchAll(new RegExp(SUITE_END.source, 'gm'))) last = match.index;
  return last;
}

/**
 * Cross-checks starts and ends: every requested test file must start, and
 * every start must end. Ends pair with starts positionally, because the
 * xpcshell dialect's `TEST_END: Test PASS` names no file. A requested path
 * that is not test-file shaped (a directory, a manifest) has no start of its own.
 *
 * @param output - Captured output, which may keep only the tail of a long run
 * @param requested - Dispatched paths
 * @param streamedStarts - Start names seen in the complete stream
 */
export function analyzeTestCompleteness(
  output: string,
  requested: readonly string[],
  streamedStarts: readonly string[] = []
): { neverStarted: string[]; neverEnded: string[] } {
  const startedNames = [...streamedStarts];
  const open: string[] = [];
  for (const line of lines(output)) {
    const start = parseStartMarker(line);
    if (start !== undefined) {
      const name = start.name ?? '(unnamed test)';
      startedNames.push(name);
      open.push(name);
    } else if (END_MARKER.test(line)) {
      open.pop();
    }
  }
  const neverStarted = requested.filter((path) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return TEST_FILE_BASENAME.test(base) && !startedNames.some((name) => name.includes(base));
  });
  return { neverStarted, neverEnded: open };
}

// ---------------------------------------------------------------------------
// Noise: output that never decides a verdict by itself.
// ---------------------------------------------------------------------------

/**
 * The resource guard FireForge installs into mach (`engine/resourceGuard.ts`)
 * substitutes `_DegradedReading` for a psutil reading that fails. These
 * errors mean a consumer used that stand-in in a way it does not support:
 * the monitor crashed, so the harness may not have run.
 */
const DEGRADED_READING = [
  /'_DegradedReading' object is not subscriptable/,
  /'_DegradedReading' object is not iterable/,
];

/**
 * Upstream mozsystemmonitor and psutil failing to read host statistics
 * (macOS's `host_statistics64` among them). They come from mach's resource
 * monitoring, never from a test, so they explain a harness failure.
 */
const STARTUP_TRACEBACK = [
  /AttributeError:.*SystemResourceMonitor/,
  /'SystemResourceMonitor' object has no attribute/,
  /poll_interval/,
  /host_statistics64/,
  /HOST_VM_INFO64/,
  /\(ipc\/mig\) array not large enough/,
  /psutil\.[A-Za-z]*Error/,
  // mach's resource report at exit, when the monitor collected nothing.
  /AttributeError: 'NoneType' object has no attribute 'read_bytes'/,
  ...DEGRADED_READING,
];

/**
 * Warnings the resource monitor and the FireForge resource guard print when
 * monitoring degrades. Monitoring is outside the harness, so they are never
 * crash evidence.
 */
const NOISE_LINES = [
  /\bUserWarning\b/,
  /psutil failed to run/i,
  // A `_collect` failure naming `_DegradedReading` is the crash above, not a warning.
  /_collect failed(?!.*_DegradedReading)/i,
  /FireForge: host resource monitor degraded/i,
  /warnings\.warn\(/,
  /failed to read the received data/i,
];

/** Output that can own a non-zero exit on a suite that finished green. */
const RECOGNIZED_EXIT_NOISE = [...STARTUP_TRACEBACK, ...NOISE_LINES];

/** A traceback mach caught and printed while submitting telemetry never aborts a run. */
const BENIGN_TRACEBACK_CONTEXT = /telemetry|glean/i;
const TRACEBACK = /Traceback \(most recent call last\)/;
const NO_OUTPUT_TIMEOUT = /timed out after \d+ seconds with no output/i;
const FOCUS_STALL = /must wait for focus/i;
const SHUTDOWN_REENTRY = /Application shut down \(without crashing\) in the middle of a test/i;

/**
 * mozsystemmonitor's teardown failure: stopping a monitor that never started
 * raises an `AttributeError` on `stop_time` or `poll_interval` from
 * `resourcemonitor.py`. It happens after the tests, in mach's own
 * bookkeeping, so it is benign. Another attribute, or a traceback from
 * another file, is something else and is not excused.
 */
const MONITOR_TEARDOWN_ERROR =
  /AttributeError: 'SystemResourceMonitor' object has no attribute '(?:stop_time|poll_interval)'/;
const RESOURCEMONITOR_FRAME = /mozsystemmonitor[/\\]resourcemonitor\.py/;

const hasMonitorTeardownNoise = (output: string): boolean =>
  MONITOR_TEARDOWN_ERROR.test(output) && RESOURCEMONITOR_FRAME.test(output);

function scanNoise(output: string): { kept: string[]; benignTracebacks: number } {
  const all = lines(output);
  const kept: string[] = [];
  let benignTracebacks = 0;
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index] ?? '';
    if (NOISE_LINES.some((pattern) => pattern.test(line))) continue;
    if (TRACEBACK.test(line)) {
      // The block: the header, indented frames, and the unindented exception line.
      const block = [line];
      let end = index + 1;
      for (; end < all.length; end += 1) {
        const next = all[end] ?? '';
        block.push(next);
        if (!/^\s/.test(next) && next.trim().length > 0) break;
      }
      if (BENIGN_TRACEBACK_CONTEXT.test(block.join('\n'))) {
        benignTracebacks += 1;
        index = end;
        continue;
      }
    }
    kept.push(line);
  }
  return { kept, benignTracebacks };
}

/**
 * The output without degradation chatter and caught telemetry tracebacks:
 * crash evidence only. Test results are always read from the full output.
 *
 * @param output - Captured harness output
 */
export function stripNonSignalNoise(output: string): string {
  return scanNoise(output).kept.join('\n');
}

const hasRecognizedExitNoise = (output: string): boolean =>
  findLine(output, RECOGNIZED_EXIT_NOISE) !== undefined || scanNoise(output).benignTracebacks > 0;

// ---------------------------------------------------------------------------
// Failure and crash evidence.
// ---------------------------------------------------------------------------

/** Lines mozcrash and the harness print when the browser itself died. */
const CRASH_MARKERS = [
  /Main app process: killed by SIG\w+/,
  /\bPROCESS-CRASH\b/,
  /mozcrash.*minidump/i,
  /Crash dump filename/i,
  /Thread \d+ \(crashed\)/,
];

const UNEXPECTED_LINES = /^.*\bTEST-UNEXPECTED-[A-Z-]+\b.*$/gm;
/** A harness `FAIL` token; `TEST-KNOWN-FAIL` is an expected failure and prose is not a token. */
const FAIL_LINES = /^.*\bTEST-(?!KNOWN-FAIL\b)[A-Z-]*FAIL\b.*$/gm;
/** The three shapes Gecko prints for an assertion failure; the English word does not count. */
const ASSERTION_LINES = /^.*(?:Assertion failure:|MOZ_ASSERT\(|###!!! ASSERTION).*$/gm;
const UNEXPECTED_MARKER = /\bTEST-UNEXPECTED-[A-Z-]+\b/;
/** Lines the harnesses print under an unexpected line: Got/Expected, Assert text, diffs, stacks. */
const FAILURE_CONTEXT =
  /^(?:\s*(?:Got\b|Expected\b|Actual\b|Assert\w*\b|Stack trace:|[-+]\s)|\s{2,}\S)/;
const FAILURE_CONTEXT_LIMIT = 6;

/** Harness lines that say what a run waited on or which ports it held. */
const STARTUP_CONTEXT = /\bport \d{2,5}\b|Waiting for browser|Marionette/i;

/** A mochitest server that never came up: the httpd's bind failure, and the wait for it. */
const SERVER_STARTUP_FAILURE = [
  /could not start server on port \d+/,
  /Timed out while waiting for server startup/,
];

/**
 * The first crash-marker line, or undefined when the run shows no crash.
 *
 * @param output - Captured harness output, never noise-stripped
 */
export function findCrashMarkerLine(output: string): string | undefined {
  return findLine(output, CRASH_MARKERS);
}

function realFailureLines(output: string): string[] {
  const matches = [
    ...(output.match(UNEXPECTED_LINES) ?? []),
    ...(output.match(FAIL_LINES) ?? []),
    ...(output.match(ASSERTION_LINES) ?? []),
  ];
  const summary = lines(output).find((line) => NONZERO_UNEXPECTED.test(line));
  if (summary !== undefined) matches.push(summary);
  return [...new Set(matches.map((line) => line.trim()))].filter(
    (line) => !SHUTDOWN_REENTRY.test(line)
  );
}

const hasExecutionSignal = (output: string): boolean =>
  EXECUTION_START.test(output) || XPCSHELL_RESULT_SUMMARY.test(output);

/** Summary lines that look green, blind to crash and truncation evidence. */
const hasGreenShapedSummary = (output: string): boolean =>
  hasExecutionSignal(output) &&
  SUITE_END.test(output) &&
  GREEN_UNEXPECTED.test(output) &&
  !NONZERO_UNEXPECTED.test(output) &&
  !NONZERO_FAILED.test(output) &&
  realFailureLines(output).length === 0;

/**
 * Whether the output embeds a completed green suite with no crash marker.
 * Such a suite finished, so startup-shaped noise in it was not fatal.
 *
 * @param output - Captured harness output
 */
export function hasCompletedGreenSummary(output: string): boolean {
  return hasGreenShapedSummary(output) && findCrashMarkerLine(output) === undefined;
}

/**
 * The first `limit` unexpected lines, each with its assertion context, and a
 * final note when more were left out.
 *
 * @param output - Captured harness output
 * @param limit - How many blocks to keep
 */
export function collectFailureBlocks(output: string, limit = 5): string[] {
  const all = lines(output);
  const blocks: string[] = [];
  let skipped = 0;
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index] ?? '';
    if (!UNEXPECTED_MARKER.test(line) || SHUTDOWN_REENTRY.test(line)) continue;
    if (blocks.length >= limit) {
      skipped += 1;
      continue;
    }
    const block = [line.trim()];
    for (let next = index + 1; next < all.length && block.length <= FAILURE_CONTEXT_LIMIT; next++) {
      const candidate = all[next] ?? '';
      if (UNEXPECTED_MARKER.test(candidate) || !FAILURE_CONTEXT.test(candidate)) break;
      block.push(candidate.trimEnd());
    }
    blocks.push(block.join('\n'));
  }
  if (skipped > 0) {
    blocks.push(`…(+${skipped} more TEST-UNEXPECTED line${skipped === 1 ? '' : 's'} not shown)`);
  }
  return blocks;
}

/** What the signature rules read. */
interface Evidence {
  output: string;
  /** The output without non-signal noise. */
  stripped: string;
  ranTests: boolean;
  realFailures: string[];
  /** A completed green summary vetoes the startup-traceback rule. */
  greenVeto: boolean;
  failurePatterns: readonly RegExp[];
}

/** One recognized harness failure: when it can apply, and its evidence line. */
interface SignatureRule {
  reason: string;
  applies: (evidence: Evidence) => boolean;
  line: (evidence: Evidence) => string | undefined;
}

/**
 * The recognized harness failures, in the order they are tried. A browser
 * crash marker is never one of them: it is a test result, and the
 * classifier reports it with the files it cut off.
 */
const SIGNATURE_RULES: readonly SignatureRule[] = [
  {
    // Only a run with no test failure: a failing run's traceback may be the test's own.
    reason: 'harness startup traceback (resource monitor/psutil)',
    applies: (e) => !e.greenVeto && e.realFailures.length === 0 && TRACEBACK.test(e.stripped),
    line: (e) => findLine(e.stripped, STARTUP_TRACEBACK),
  },
  {
    // mach logs this one without a traceback header.
    reason: 'degraded resource reading crashed the harness fallback (_DegradedReading)',
    applies: (e) => !e.ranTests && e.realFailures.length === 0,
    line: (e) => findLine(e.stripped, DEGRADED_READING),
  },
  {
    // A trailing `Passed: 0` summary is part of this shape.
    reason: 'no-output timeout before any test started',
    applies: (e) => !e.ranTests,
    line: (e) => findLine(e.stripped, [NO_OUTPUT_TIMEOUT]),
  },
  {
    reason: 'a configured harness failure pattern matched before any test started',
    applies: (e) => !e.ranTests && e.failurePatterns.length > 0,
    line: (e) => findLine(e.output, e.failurePatterns),
  },
  {
    // Every unexpected line is the shutdown artifact, on a run that stalled on focus.
    reason: 'post-green shutdown re-entry during harness teardown',
    applies: (e) => e.ranTests && e.realFailures.length === 0 && FOCUS_STALL.test(e.output),
    line: (e) => findLine(e.output, [SHUTDOWN_REENTRY]),
  },
];

/**
 * The recognized harness failure in captured output, or undefined for
 * anything that reads as a test result.
 *
 * @param output - Captured harness output
 * @param failurePatterns - Lines that mean the browser never came up (`test.harnessFailurePatterns`)
 */
export function detectCrashSignature(
  output: string,
  failurePatterns: readonly RegExp[] = []
): CrashSignature | undefined {
  if (findCrashMarkerLine(output) !== undefined) return undefined;
  const evidence: Evidence = {
    output,
    stripped: stripNonSignalNoise(output),
    ranTests: hasExecutionSignal(output),
    realFailures: realFailureLines(output),
    greenVeto: hasCompletedGreenSummary(output),
    failurePatterns,
  };
  for (const rule of SIGNATURE_RULES) {
    if (!rule.applies(evidence)) continue;
    const line = rule.line(evidence);
    if (line === undefined) continue;
    const signature: CrashSignature = { reason: rule.reason, line };
    if (rule.reason.startsWith('no-output timeout')) {
      const context = lines(evidence.stripped)
        .filter((candidate) => STARTUP_CONTEXT.test(candidate))
        .slice(0, 5)
        .map((candidate) => candidate.trim());
      if (context.length > 0) signature.harnessLines = context;
    }
    return signature;
  }
  return undefined;
}

function secondaryNoise(output: string): CrashSignature | undefined {
  const evidence = stripNonSignalNoise(output);
  const traceback = TRACEBACK.test(evidence) ? findLine(evidence, STARTUP_TRACEBACK) : undefined;
  if (traceback !== undefined) {
    return { reason: 'harness traceback also present (resource monitor/psutil)', line: traceback };
  }
  const timeout = findLine(evidence, [NO_OUTPUT_TIMEOUT]);
  return timeout === undefined
    ? undefined
    : { reason: 'harness no-output timeout also present', line: timeout };
}

/** Exit values meaning the harness was killed: `128 + n`, a negated signal, a relayed SIGKILL or SIGTERM. */
const isSignalExit = (exitCode: number): boolean =>
  exitCode < 0 || exitCode > 128 || exitCode === 9 || exitCode === 15;

/** Caps an evidence line so a one-line note stays one line. */
function truncateEvidence(line: string): string {
  const flat = line.trim().replace(/\s+/g, ' ');
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

/**
 * Why a non-zero exit cannot be blamed on harness noise: a signal death, a
 * traceback after the last suite that no recognized signature explains, or
 * no recognized noise at all.
 */
function unexplainedExit(exitCode: number, output: string): string | undefined {
  if (exitCode === 0) return undefined;
  if (isSignalExit(exitCode)) return `the harness died on a signal (exit ${exitCode})`;
  const lastSuiteEnd = lastSuiteEndOffset(output);
  const afterSuite = stripNonSignalNoise(lastSuiteEnd < 0 ? '' : output.slice(lastSuiteEnd));
  const traceback = /Traceback \(most recent call last\)[\s\S]*/.exec(afterSuite)?.[0];
  if (traceback !== undefined && findLine(traceback, RECOGNIZED_EXIT_NOISE) === undefined) {
    const exception = lines(traceback).find(
      (line, index) => index > 0 && line.length > 0 && !/^\s/.test(line)
    );
    return `a traceback followed the last suite summary: ${truncateEvidence(exception ?? traceback)}`;
  }
  return hasRecognizedExitNoise(output)
    ? undefined
    : `exit ${exitCode} has no recognized noise signature to account for it`;
}

/**
 * Whether a clean suite whose only residue is mozsystemmonitor's teardown
 * failure passes. Every condition must hold; the first that fails is named, but only
 * when the teardown noise was present, since otherwise the run was never a
 * candidate.
 */
function judgeTeardownNoise(
  output: string,
  counts: SummaryCounts,
  realFailures: readonly string[],
  requested: readonly string[],
  started: readonly string[] | undefined
): { accepted: boolean; rejectedBy?: string } {
  if (!hasMonitorTeardownNoise(output)) return { accepted: false };
  const completeness = analyzeTestCompleteness(output, requested, started);
  const checks: [boolean, () => string][] = [
    [hasExecutionSignal(output), () => 'no execution signal (no TEST-START/TEST_START)'],
    [counts.checks !== undefined, () => 'summary printed no "Ran N checks" line'],
    [counts.checks !== 0, () => 'summary reported zero checks'],
    [counts.unexpected !== undefined, () => 'summary printed no "Unexpected results:" line'],
    [
      counts.unexpected === undefined || counts.unexpected === 0,
      () => `summary reported unexpected=${counts.unexpected ?? 0}`,
    ],
    [
      !NONZERO_UNEXPECTED.test(output),
      () => 'a non-zero "Unexpected results:" line is present somewhere in the output',
    ],
    [
      !NONZERO_FAILED.test(output),
      () => 'a non-zero "Failed:" line is present somewhere in the output',
    ],
    [
      realFailures.length === 0,
      () =>
        `${realFailures.length} matched failure line(s), first: ${truncateEvidence(realFailures[0] ?? '')}`,
    ],
    [
      findCrashMarkerLine(output) === undefined,
      () => `crash marker present: ${truncateEvidence(findCrashMarkerLine(output) ?? '')}`,
    ],
    [!SHUTDOWN_REENTRY.test(output), () => 'post-green shutdown re-entry shape present'],
    [
      completeness.neverStarted.length === 0,
      () => `requested file(s) never started: ${completeness.neverStarted.join(', ')}`,
    ],
    [
      completeness.neverEnded.length === 0,
      () => `requested file(s) never ended: ${completeness.neverEnded.join(', ')}`,
    ],
  ];
  const failed = checks.find(([holds]) => !holds);
  return failed === undefined ? { accepted: true } : { accepted: false, rejectedBy: failed[1]() };
}

/** The verdict of an exit-0 run with no failure evidence: a pass only when it shows it completed. */
function judgeExitZero(
  output: string,
  counts: SummaryCounts,
  requested: readonly string[],
  raw: RawTestLog | undefined
): HarnessVerdict {
  if (raw !== undefined) {
    return raw.suiteCompleted
      ? { kind: 'pass', ...counts }
      : {
          kind: 'crash',
          signature: {
            reason: 'the raw log has no completed suite',
            line: 'exit 0, with no suite_end for the last suite_start',
          },
          ...counts,
        };
  }
  const positive = (counts.checks ?? 0) > 0 || POSITIVE_PASSED.test(output);
  if (!positive && ZERO_PASSED.test(output)) return { kind: 'no-tests', ...counts };
  const completed = SUITE_END.test(output) || counts.unexpected !== undefined;
  if (!positive || !completed) {
    return {
      kind: 'crash',
      signature: {
        reason: 'the harness exited 0 without a completed suite summary',
        line: positive ? 'no SUITE_END or results summary' : 'no positive check count',
      },
      ...counts,
    };
  }
  const { neverEnded } = analyzeTestCompleteness(output, requested);
  return neverEnded.length > 0
    ? { kind: 'test-failures', ...counts, greenSummaryRejected: { neverStarted: [], neverEnded } }
    : { kind: 'pass', ...counts };
}

/** The evidence a dispatch has besides its captured text. */
export interface DispatchEvidence {
  /** The dispatch's raw log, when it wrote one. */
  raw?: RawTestLog | undefined;
  /** Start names seen in the complete stream, which the captured text may have lost. */
  started?: readonly string[];
  /** Lines that mean the browser never came up (`test.harnessFailurePatterns`). */
  failurePatterns?: readonly RegExp[];
}

/**
 * Classifies a finished dispatch, in this order:
 *
 *  1. A clean suite whose only residue is mozsystemmonitor's teardown failure passes.
 *  2. A recognized harness failure is a crash, whatever the exit code.
 *  3. No execution signal for requested paths: a server that failed to start
 *     is a crash (`server-startup`), anything else `no-tests`. A summary that
 *     counted zero checks is `no-tests` too.
 *  4. Exit 0 without failure evidence passes only when the run shows it
 *     completed.
 *  5. A non-zero exit whose summary completed green passes when recognized
 *     noise explains the exit and no file was cut off; any crash marker,
 *     unstarted or unfinished file, signal death or unexplained traceback
 *     rejects that summary.
 *  6. Anything else is `test-failures`.
 *
 * @param exitCode - The harness exit status
 * @param output - Its output, both streams
 * @param requested - The dispatched paths
 * @param evidence - See {@link DispatchEvidence}
 */
export function classifyHarnessRun(
  exitCode: number,
  output: string,
  requested: readonly string[],
  evidence: DispatchEvidence = {}
): HarnessVerdict {
  const { raw, started } = evidence;
  const counts = extractSummaryCounts(output);
  const realFailures = realFailureLines(output);
  const firstFailure =
    realFailures[0] ??
    findCrashMarkerLine(output) ??
    findLine(output, [NONZERO_UNEXPECTED, NONZERO_FAILED]);
  const teardown = isSignalExit(exitCode)
    ? { accepted: false }
    : judgeTeardownNoise(output, counts, realFailures, requested, started);
  if (teardown.accepted) return { kind: 'pass', note: 'teardown-noise-ignored', ...counts };
  const withNote = noter(teardown.rejectedBy);

  const signature = detectCrashSignature(output, evidence.failurePatterns);
  if (signature !== undefined) return withNote({ kind: 'crash', signature, ...counts });

  const ranTests = hasExecutionSignal(output) || (raw?.results.length ?? 0) > 0;
  if (!ranTests && requested.length > 0) return nothingRan(output, counts);
  if (counts.checks === 0 && firstFailure === undefined) {
    return withNote({ kind: 'no-tests', ...counts });
  }
  // A non-zero unexpected or failed summary is itself a first failure.
  if (exitCode === 0 && firstFailure === undefined) {
    const judged = judgeExitZero(output, counts, requested, raw);
    return judged.kind === 'pass' ? judged : withNote(judged);
  }
  const failure = { ...counts, ...failureKeys(output, firstFailure) };
  if (hasGreenShapedSummary(output)) {
    const rejection = rejectGreenSummary(exitCode, output, requested, started);
    return rejection === undefined
      ? { kind: 'pass', greenSummaryOverride: true, ...counts }
      : withNote({ kind: 'test-failures', ...failure, greenSummaryRejected: rejection });
  }
  // `unexpected=0` beside a red rests on pattern matching, not a harness result: say so.
  const unmarked =
    counts.unexpected === 0 &&
    realFailures.length > 0 &&
    !realFailures.some((line) => UNEXPECTED_MARKER.test(line))
      ? 'summary reported 0 unexpected; no TEST-UNEXPECTED marker in the matched evidence'
      : undefined;
  return withNote({ kind: 'test-failures', ...failure }, unmarked);
}

/** Adds the rejected teardown override, and any further note, to a failing verdict. */
function noter(
  rejectedBy: string | undefined
): (verdict: HarnessVerdict, extra?: string) => HarnessVerdict {
  return (verdict, extra) => {
    const notes = [
      rejectedBy === undefined ? undefined : `green-teardown override rejected: ${rejectedBy}`,
      extra,
    ].filter((note) => note !== undefined);
    return notes.length > 0 ? { ...verdict, note: notes.join('; ') } : verdict;
  };
}

/** The evidence a failing verdict carries. */
function failureKeys(output: string, firstFailure: string | undefined): Partial<HarnessVerdict> {
  const blocks = collectFailureBlocks(output);
  const secondary = firstFailure === undefined ? undefined : secondaryNoise(output);
  return {
    ...(firstFailure === undefined ? {} : { failureLine: firstFailure }),
    ...(blocks.length > 0 ? { failureBlocks: blocks } : {}),
    ...(secondary === undefined ? {} : { secondary }),
  };
}

/** No test ran: a mochitest server that never came up is infrastructure, anything else `no-tests`. */
function nothingRan(output: string, counts: SummaryCounts): HarnessVerdict {
  const line = findLine(output, SERVER_STARTUP_FAILURE);
  if (line === undefined) return { kind: 'no-tests', ...counts };
  return {
    kind: 'crash',
    signature: {
      reason: 'mochitest server failed to start (server-startup)',
      line,
      verdictReason: 'server-startup',
    },
    ...counts,
  };
}

/** Why a green-shaped summary does not speak for the run, or undefined when it does. */
function rejectGreenSummary(
  exitCode: number,
  output: string,
  requested: readonly string[],
  started: readonly string[] | undefined
): GreenSummaryRejection | undefined {
  const crashLine = findCrashMarkerLine(output);
  const { neverStarted, neverEnded } = analyzeTestCompleteness(output, requested, started);
  const exitEvidence = unexplainedExit(exitCode, output);
  if (
    crashLine === undefined &&
    neverStarted.length === 0 &&
    neverEnded.length === 0 &&
    exitEvidence === undefined
  ) {
    return undefined;
  }
  return {
    ...(crashLine === undefined ? {} : { crashLine }),
    ...(exitEvidence === undefined ? {} : { exitEvidence }),
    neverStarted,
    neverEnded,
  };
}

const SIGSEGV_EXITS = new Set([-11, 139]);

/**
 * Whether a harness died on SIGSEGV without producing any evidence: no
 * execution signal, no failure line, no crash marker. A module loader that
 * faults on an unregistered `.sys.mjs` leaves exactly this.
 *
 * @param exitCode - The harness exit status
 * @param output - Its output
 */
export function isSilentSegfault(exitCode: number, output: string): boolean {
  return (
    SIGSEGV_EXITS.has(exitCode) &&
    !hasExecutionSignal(output) &&
    realFailureLines(output).length === 0 &&
    findCrashMarkerLine(output) === undefined
  );
}

// ---------------------------------------------------------------------------
// Completeness: a would-be pass is re-examined against what the run recorded.
// ---------------------------------------------------------------------------

const normalized = (path: string): string => path.replace(/\\/g, '/');
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const namesSameFile = (name: string, request: string): boolean =>
  name === request || name.endsWith(`/${request}`) || request.endsWith(`/${name}`);
const namesNoTestFile = (path: string): boolean =>
  !TEST_FILE_BASENAME.test(basenameOf(normalized(path)));

/** The requested indexes some name names unambiguously; a name matching two requests counts for neither. */
function namedIndexes(names: readonly string[], requested: readonly string[]): Set<number> {
  const named = new Set<number>();
  for (const name of names) {
    const matches = requested.flatMap((request, index) =>
      namesSameFile(normalized(name), request) ? [index] : []
    );
    if (matches.length === 1) named.add(matches[0] ?? -1);
  }
  return named;
}

/**
 * Counts the requested test files that produced a start or skip marker. A
 * directory or manifest request counts the tests the raw log's `suite_start`
 * announced. Undefined when nothing can be counted: no test-file request, or
 * (outside the raw log) no start line naming any requested file.
 *
 * @param markers - Start and skip names
 * @param requested - Dispatched paths, in order
 * @param authoritative - The markers come from the raw log or provably name only other files
 * @param roster - The ids `suite_start` announced
 */
function countStartedFiles(
  markers: StartMarkers,
  requested: readonly string[],
  authoritative = false,
  roster: readonly string[] = []
): { started: number; requested: number; firstUnstarted?: string } | undefined {
  const named = requested.filter((path) => !namesNoTestFile(path)).map(normalized);
  const all = requested.some(namesNoTestFile)
    ? [
        ...named,
        ...roster.filter(
          (id) =>
            !namesNoTestFile(id) && !named.some((request) => namesSameFile(normalized(id), request))
        ),
      ]
    : named;
  if (all.length === 0) return undefined;
  const forms = all.map(normalized);
  const startedIndexes = namedIndexes(markers.started, forms);
  if (!authoritative && startedIndexes.size === 0) return undefined;
  const skippedIndexes = namedIndexes(markers.skipped, forms);
  const unstarted = all.filter(
    (_path, index) => !startedIndexes.has(index) && !skippedIndexes.has(index)
  );
  return {
    started: all.length - unstarted.length,
    requested: all.length,
    ...(unstarted[0] === undefined ? {} : { firstUnstarted: unstarted[0] }),
  };
}

/** Start lines about other test files altogether, none sharing a basename with a request. */
function namesOnlyOtherFiles(markers: StartMarkers, requested: readonly string[]): boolean {
  const bases = new Set(requested.map(basenameOf));
  const files = markers.started.filter((name) => TEST_FILE_BASENAME.test(basenameOf(name)));
  return files.length > 0 && !files.some((name) => bases.has(basenameOf(name)));
}

/** Requested directories and manifests a raw log ran nothing under. */
function directoriesWithoutResults(
  requested: readonly string[],
  tests: readonly string[]
): string[] {
  return requested.filter((path) => {
    const request = normalized(path);
    if (!request.includes('/') || TEST_FILE_BASENAME.test(basenameOf(request))) return false;
    const dir = /\.(?:toml|ini|list)$/.test(request)
      ? request.slice(0, request.lastIndexOf('/'))
      : request.replace(/\/+$/, '');
    return !tests.some((test) => {
      const id = normalized(test);
      return id.startsWith(`${dir}/`) || id.includes(`/${dir}/`);
    });
  });
}

/** Where the start count comes from, and what it counts. */
function countStarts(
  verdict: HarnessVerdict,
  output: string,
  requested: readonly string[],
  streamed: StartMarkers | undefined,
  raw: RawTestLog | undefined
): { counted: ReturnType<typeof countStartedFiles>; source: 'raw' | 'stream' | 'capture' } {
  // A raw log is complete whatever the capture kept. Streamed markers win when they saw a start.
  if (raw !== undefined) {
    const markers = { started: raw.started, skipped: raw.skipped };
    return { counted: countStartedFiles(markers, requested, true, raw.roster), source: 'raw' };
  }
  if (streamed !== undefined && streamed.started.length > 0) {
    const authoritative = verdict.kind === 'pass' && namesOnlyOtherFiles(streamed, requested);
    return { counted: countStartedFiles(streamed, requested, authoritative), source: 'stream' };
  }
  return { counted: countStartedFiles(scanMarkers(output), requested), source: 'capture' };
}

function gatherCompleteness(
  verdict: HarnessVerdict,
  output: string,
  requested: readonly string[],
  streamed: StartMarkers | undefined,
  raw: RawTestLog | undefined
): IncompleteRun {
  const appExit = /Main app process: killed by (SIG[A-Z0-9]+)/.exec(output)?.[1];
  const shutdownLine = lines(output)
    .find((line) => SHUTDOWN_REENTRY.test(line))
    ?.trim();
  const { counted, source } = countStarts(verdict, output, requested, streamed, raw);
  const firstUnstarted =
    counted?.firstUnstarted ??
    (raw === undefined
      ? undefined
      : directoriesWithoutResults(
          requested,
          raw.results.map((result) => result.test)
        )[0]);
  const unexpected = Math.max(
    verdict.unexpected ?? 0,
    raw?.results.filter((result) => result.unexpected).length ?? 0
  );
  return {
    started: counted?.started ?? 0,
    requested: counted?.requested ?? 0,
    ...(firstUnstarted === undefined ? {} : { firstUnstarted, startedSource: source }),
    ...(shutdownLine === undefined ? {} : { shutdownLine }),
    ...(unexpected > 0 ? { unexpected } : {}),
    ...(raw !== undefined && raw.unfinished.length > 0 ? { unfinished: raw.unfinished } : {}),
    ...(appExit === undefined ? {} : { appExit }),
  };
}

/**
 * Re-examines a passing verdict against what the run recorded, and fails it
 * when a requested file never started, a test never finished, the browser
 * shut down mid-test or died on a signal, or an unexpected result was
 * reported. A raw log decides when there is one: every requested file and
 * directory must have run. A failing verdict keeps its kind and gains the
 * evidence.
 *
 * @param verdict - The classifier's verdict
 * @param output - Captured harness output
 * @param requested - Dispatched paths, in order
 * @param streamed - Markers collected from the complete stream
 * @param raw - The dispatch's raw log
 */
export function vetoIncompletePass(
  verdict: HarnessVerdict,
  output: string,
  requested: readonly string[],
  streamed?: StartMarkers,
  raw?: RawTestLog
): HarnessVerdict {
  const passed = verdict.kind === 'pass';
  const evidence = gatherCompleteness(verdict, output, requested, streamed, raw);
  const stopped =
    evidence.firstUnstarted !== undefined ||
    evidence.shutdownLine !== undefined ||
    evidence.appExit !== undefined;
  if (!stopped && (!passed || (evidence.unexpected === undefined && !evidence.unfinished))) {
    // A raw log that recorded no test at all is a run that did nothing.
    if (passed && raw?.results.length === 0) {
      return {
        kind: 'no-tests',
        ...(verdict.checks === undefined ? {} : { checks: verdict.checks }),
        ...(verdict.unexpected === undefined ? {} : { unexpected: verdict.unexpected }),
      };
    }
    return verdict;
  }
  if (!passed) return { ...verdict, incomplete: evidence };
  // The pass-only annotations would misdescribe a failed run.
  const rest: HarnessVerdict = { ...verdict };
  delete rest.greenSummaryOverride;
  delete rest.note;
  const unexpected = evidence.unexpected ?? 0;
  return {
    ...rest,
    kind: 'test-failures',
    incomplete: evidence,
    ...(unexpected > (rest.unexpected ?? 0) ? { unexpected } : {}),
    ...(evidence.shutdownLine === undefined ? {} : { failureLine: evidence.shutdownLine }),
  };
}

/**
 * Classifies a dispatch and applies the completeness veto: the one judgement
 * a run makes of each dispatch.
 *
 * @param exitCode - The harness exit status
 * @param output - Its output, both streams in arrival order
 * @param requested - The dispatched paths
 * @param evidence - The raw log, streamed markers and configured failure patterns
 */
export function judgeDispatch(
  exitCode: number,
  output: string,
  requested: readonly string[],
  evidence: DispatchEvidence & { streamed?: StartMarkers } = {}
): HarnessVerdict {
  const started = evidence.raw?.started ?? evidence.streamed?.started;
  return vetoIncompletePass(
    classifyHarnessRun(exitCode, output, requested, {
      ...evidence,
      ...(started === undefined ? {} : { started }),
    }),
    output,
    requested,
    evidence.streamed,
    evidence.raw
  );
}
