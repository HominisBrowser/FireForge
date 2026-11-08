// SPDX-License-Identifier: EUPL-1.2
/**
 * Harness-crash classification for `fireforge test`.
 *
 * The wrapped mach harness exhibits flaky non-test failures that an exit
 * code (or a "did it print a summary" grep) cannot distinguish from real
 * test results:
 *
 *  - startup crashes from the mozlog resource monitor on macOS
 *    (`AttributeError: 'SystemResourceMonitor' object has no attribute
 *    'poll_interval'`, `host_statistics64(HOST_VM_INFO64) syscall failed`,
 *    `(ipc/mig) array not large enough`, a psutil/macOS mismatch) which
 *    abort the run before any test executes.
 *  - hangs after browser startup that die at the no-output timeout yet still
 *    emit a `Passed: 0` summary.
 *  - post-green shutdown re-entry, where a fully green run stalls on "must
 *    wait for focus" and records "Application shut down (without crashing)
 *    in the middle of a test!" as the only unexpected failure.
 *
 * Classification therefore keys on `TEST-START` presence, so summary lines
 * never count as proof that tests ran, and recognizes the crash shapes
 * above so the command layer can retry them with a bounded budget instead of
 * reporting phantom test failures (or phantom passes).
 */

import { hasKnownTeardownNoise } from './mach-known-noise-filter.js';
import { detectServerStartupFailure } from './test-harness-infra.js';
import {
  analyzeTestCompleteness,
  EXECUTION_START_PATTERN,
  extractSummaryCounts,
  GREEN_UNEXPECTED_SUMMARY_PATTERN,
  type HarnessSummaryCounts,
  lastSuiteEndOffset,
  NONZERO_FAILED_SUMMARY_PATTERN,
  NONZERO_UNEXPECTED_SUMMARY_PATTERN,
  POSITIVE_PASSED_SUMMARY_PATTERN,
  SUITE_END_PATTERN,
  XPCSHELL_RESULT_SUMMARY_PATTERN,
  ZERO_PASSED_SUMMARY_PATTERN,
} from './test-harness-markers.js';
import {
  type GreenTeardownOverride,
  truncateEvidence,
  unmarkedFailureEvidenceNote,
} from './test-harness-verdict-notes.js';
import { classifyProfileArgumentFailure } from './test-profile-files.js';
// Defined in a leaf module so this file and `test-stall-triage.ts` can both
// name it without forming an import cycle. Re-exported here because the
// command layer imports its harness diagnostics from this module.
export type { GreenSummaryRejection, HarnessCrashSignature } from './test-harness-signature.js';
import {
  formatIncompleteSuffix,
  formatShardsSuffix,
  type GreenSummaryRejection,
  type HarnessCrashSignature,
  type IncompleteRunEvidence,
  type RawRunSummary,
} from './test-harness-signature.js';

export type { HarnessSummaryCounts } from './test-harness-markers.js';

// The operator messages live beside the server-startup shape in
// `test-harness-infra.ts`.
export {
  buildGreenSummaryRejectedMessage,
  buildHarnessCrashMessage,
  buildNoTestsRanMessage,
  buildSilentSegfaultMessage,
} from './test-harness-infra.js';

// The no-output-stall triage text lives in `test-stall-triage.ts` (it is
// operator advice, not classification) and is re-exported here so the
// command layer keeps importing its harness diagnostics from one module.
export { headedDisplayAsleepVerdictNote, headedNoOutputTimeoutHint } from './test-stall-triage.js';

/** How a completed harness run should be interpreted. */
export type HarnessRunClassification =
  'tests-ran-ok' | 'test-failures' | 'harness-crash' | 'harness-arguments' | 'no-tests';

/** Result of {@link classifyHarnessRun}. */
export interface HarnessRunVerdict extends HarnessSummaryCounts {
  kind: HarnessRunClassification;
  signature?: HarnessCrashSignature;
  /** First concrete test-failure evidence line, when available. */
  realFailureLine?: string;
  /**
   * First N `TEST-UNEXPECTED-*` lines verbatim, each with its trailing
   * assertion/diff context lines (`Got …` / `Expected …` / Assert diff /
   * stack head). Lets the failure summary echo the actual assertion so a
   * one-off failure that does not reproduce is still diagnosable after the
   * fact. Only set on `test-failures` verdicts when such lines exist.
   */
  realFailureBlocks?: string[];
  /** Harness noise seen in the same output as a real test failure. */
  secondaryHarnessSignature?: HarnessCrashSignature;
  /**
   * Set when a non-zero mach exit code was overridden because the output
   * embeds a completed green summary, so the exit code followed harness
   * noise, not a test result. Callers should surface a note.
   */
  greenSummaryOverride?: boolean;
  /**
   * Set when the output embeds a green-looking summary that was rejected:
   * crash or truncation evidence proves the suite never completed, so the
   * "green" counts only cover the files that ran before the run died. A
   * SIGSEGV at the second of eight files leaves a `Passed: 2 / Failed: 0`
   * summary that reads as a pass. Callers must fail the run and surface the
   * evidence.
   */
  greenSummaryRejected?: GreenSummaryRejection;
  /**
   * Short parenthetical appended to the `FIREFORGE-VERDICT:` line when the
   * bare status would under-describe the run: currently "harness teardown
   * noise ignored" and the headed display-asleep stall. Advisory text
   * only. The status and reason keys are unaffected.
   */
  note?: string;
  /**
   * Set when a mach-exit-0 run was refused its pass because it is
   * incomplete or reported unexpected results. See
   * `test-run-completeness.ts`.
   */
  incomplete?: IncompleteRunEvidence;
}

const UNEXPECTED_LINE_PATTERN = /^.*\bTEST-UNEXPECTED-[A-Z-]+\b.*$/gm;
/**
 * A `FAIL` token that is harness-shaped. Not a bare `\bFAIL\b`
 * word match: that matched any output line containing the ordinary English
 * word, so a test's own passing diagnostic could manufacture a red run (see
 * {@link realUnexpectedFailureLines}). It also matched `TEST-KNOWN-FAIL`,
 * an expected failure, and counted it as a real one.
 *
 * The `TEST-` prefix is what makes the token the harness's rather than
 * prose, and the negative lookahead is what keeps a known-fail annotation
 * out of the evidence set.
 */
const FAIL_LINE_PATTERN = /^.*\bTEST-(?!KNOWN-FAIL\b)[A-Z-]*FAIL\b.*$/gm;
/**
 * The three concrete shapes Gecko prints for a real assertion failure.
 * Case-sensitive and punctuation-anchored on purpose: the previous
 * `/\b(?:Assertion failure|MOZ_ASSERT|ASSERTION)\b/gim` was
 * case-insensitive, so the ordinary English word "assertion" in a passing
 * diagnostic ("If an assertion below times out, this is why") was read as
 * a failure, and the verdict then named that diagnostic as the first real
 * test failure, pointing the reader at the wrong line.
 */
const ASSERTION_LINE_PATTERN = /^.*(?:Assertion failure:|MOZ_ASSERT\(|###!!! ASSERTION).*$/gm;
export const SHUTDOWN_REENTRY_PATTERN =
  /Application shut down \(without crashing\) in the middle of a test/i;
const FOCUS_STALL_PATTERN = /must wait for focus/i;
const TRACEBACK_PATTERN = /Traceback \(most recent call last\)/;
const NO_OUTPUT_TIMEOUT_PATTERN = /timed out after \d+ seconds with no output/i;

/** Harness lines that say what a run was waiting on or which ports it held. */
const STARTUP_CONTEXT_PATTERN = /\bport \d{2,5}\b|Waiting for browser|Marionette/i;

/** Most harness lines carried into a startup-timeout message. */
const STARTUP_CONTEXT_LIMIT = 5;

function startupContextLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => STARTUP_CONTEXT_PATTERN.test(line))
    .slice(0, STARTUP_CONTEXT_LIMIT)
    .map((line) => line.trim());
}

/**
 * Crash-marker lines mozcrash / the mochitest harness print when the browser
 * process itself died. Matched against the raw output (never noise-stripped):
 * any of these proves the run was truncated by a crash, so an embedded green
 * summary is under-reporting, not a result. `Main app process: killed by
 * SIGSEGV` at the second of eight files with a `Passed: 2 / Failed: 0`
 * summary is the shape this exists to catch.
 */
const CRASH_MARKER_PATTERNS: readonly RegExp[] = [
  /Main app process: killed by SIG\w+/,
  /\bPROCESS-CRASH\b/,
  // The minidump-processing header shapes mozcrash emits when it walks a
  // crash dump after the run.
  /mozcrash.*minidump/i,
  /Crash dump filename/i,
  /Thread \d+ \(crashed\)/,
];

/**
 * Startup-traceback fingerprints from the mozlog resource monitor / psutil
 * on macOS. Each is matched per-line so the evidence line in the report is
 * the concrete failure, not the whole traceback.
 */
// A `_DegradedReading` fallback that is not a real namedtuple duck type
// crashes mozsystemmonitor on the fallback itself (`_build_meta` subscripts
// the reading, `_collect` unpacks it). A startup abort with zero TEST-START
// lines from this family is a crash, not a test failure. The `_collect
// failed` variant is caught-and-logged, so it carries no Traceback header.
// It gets its own zero-TEST-START check in `detectHarnessCrashSignature`
// besides joining the traceback cluster.
const DEGRADED_READING_CRASH_SIGNALS: readonly RegExp[] = [
  /'_DegradedReading' object is not subscriptable/,
  /'_DegradedReading' object is not iterable/,
];

const STARTUP_TRACEBACK_SIGNALS: readonly RegExp[] = [
  /AttributeError:.*SystemResourceMonitor/,
  /'SystemResourceMonitor' object has no attribute/,
  /poll_interval/,
  /host_statistics64/,
  /HOST_VM_INFO64/,
  /\(ipc\/mig\) array not large enough/,
  /psutil\.[A-Za-z]*Error/,
  // On a degraded host every collector sample is rejected, aggregation has
  // nothing, and mozbuild's log_resource_usage dies on
  // usage["io"].read_bytes AFTER a fully successful compile ("Error running
  // mach" with complete artifacts). Environmental, not a build regression:
  // the protected build retries it, since an incremental retry is cheap and
  // the guard keeps the retry green.
  /AttributeError: 'NoneType' object has no attribute 'read_bytes'/,
  ...DEGRADED_READING_CRASH_SIGNALS,
];

function findLine(output: string, patterns: readonly RegExp[]): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (patterns.some((p) => p.test(line))) return line.trim();
  }
  return undefined;
}

/**
 * Non-signal noise lines: the resource-monitor degrade path (FireForge's own
 * guard plus mozlog's `_collect failed`) prints warnings on runs that then
 * complete green. Without excluding them, every multi-file suite reports
 * CRASH because these lines match the startup-traceback signals even though
 * the embedded summary is fully green.
 */
const NOISE_LINE_PATTERNS: readonly RegExp[] = [
  /\bUserWarning\b/,
  /psutil failed to run/i,
  // `_collect failed` chatter is noise on green runs, EXCEPT the
  // `_DegradedReading` variant: that is the crash evidence for the
  // "object is not iterable" startup-abort signature above and must
  // survive stripNonSignalNoise.
  /_collect failed(?!.*_DegradedReading)/i,
  /FireForge: host resource monitor degraded/i,
  /warnings\.warn\(/,
  // mozsystemmonitor's parent-side drain loop rejecting a malformed sample.
  // mach sometimes reprints the warning text without the `UserWarning:`
  // token, and a run that completes despite the stream must never classify
  // as crash on it.
  /failed to read the received data/i,
];

/**
 * Output that can own a non-zero exit on a suite that finished green: the
 * resource-monitor failure family and its degradation chatter.
 */
const RECOGNIZED_EXIT_NOISE: readonly RegExp[] = [
  ...STARTUP_TRACEBACK_SIGNALS,
  ...NOISE_LINE_PATTERNS,
];

/** Matches the caught/telemetry context that marks a traceback as benign. */
const BENIGN_TRACEBACK_CONTEXT = /telemetry|glean/i;

/**
 * Strips non-signal noise from captured output before crash-signature
 * matching: resource-monitor degradation warnings, and traceback blocks
 * that mach caught itself (telemetry submission tracebacks are printed but
 * never abort the run). The stripped text is used only as crash evidence.
 * Classification of test results still reads the full output.
 */
export function stripNonSignalNoise(output: string): string {
  return scanNonSignalNoise(output).kept.join('\n');
}

function scanNonSignalNoise(output: string): { kept: string[]; benignTracebacks: number } {
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  let benignTracebacks = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (NOISE_LINE_PATTERNS.some((p) => p.test(line))) continue;
    if (TRACEBACK_PATTERN.test(line)) {
      // Collect the whole traceback block: the header, indented frame/code
      // lines, and the trailing unindented exception line.
      const block: string[] = [line];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const blockLine = lines[j] ?? '';
        block.push(blockLine);
        const isIndented = /^\s/.test(blockLine) || blockLine.trim().length === 0;
        if (!isIndented) break; // unindented exception line terminates the block
      }
      if (BENIGN_TRACEBACK_CONTEXT.test(block.join('\n'))) {
        benignTracebacks += 1;
        i = j; // drop the whole caught-telemetry traceback block
        continue;
      }
      // A real traceback stays in evidence line-by-line (minus noise lines
      // already filtered above).
    }
    kept.push(line);
  }
  return { kept, benignTracebacks };
}

/** Output that can own a non-zero exit, including a traceback mach caught itself. */
function hasRecognizedExitNoise(output: string): boolean {
  return (
    findLine(output, RECOGNIZED_EXIT_NOISE) !== undefined ||
    scanNonSignalNoise(output).benignTracebacks > 0
  );
}

/**
 * True when the output carries any execution signal: the browser-chrome
 * `TEST-START` marker, the structured-log `TEST_START` marker, or the
 * suite-specific xpcshell result-summary block.
 */
function hasExecutionSignal(output: string): boolean {
  return EXECUTION_START_PATTERN.test(output) || hasXpcshellResultSummary(output);
}

/**
 * Finds the first crash-marker line in the RAW output (see
 * {@link CRASH_MARKER_PATTERNS}), or undefined when the run shows no
 * crash evidence. Exported for direct unit testing.
 */
export function findCrashMarkerLine(output: string): string | undefined {
  return findLine(output, CRASH_MARKER_PATTERNS);
}

/**
 * True when the summary lines LOOK green: execution signal, `Unexpected
 * results: 0` with no non-zero count, `SUITE_END`, no real
 * `TEST-UNEXPECTED-*` lines. Blind to crash/truncation
 * evidence: {@link hasCompletedGreenSummary} layers that on top, and
 * {@link classifyHarnessRun} needs the distinction to report why a
 * green-shaped summary was rejected.
 */
function hasGreenShapedSummary(output: string): boolean {
  return (
    hasExecutionSignal(output) &&
    SUITE_END_PATTERN.test(output) &&
    GREEN_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    !NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    !NONZERO_FAILED_SUMMARY_PATTERN.test(output) &&
    realUnexpectedFailureLines(output).length === 0
  );
}

/**
 * True when the output embeds a completed, green suite summary: an execution
 * signal, `Unexpected results: 0` (and no non-zero unexpected count), a
 * `SUITE_END` marker, no real `TEST-UNEXPECTED-*` lines, and no crash
 * marker. Such a run finished its suite, so any startup-traceback-shaped
 * noise in the same output is non-fatal and this vetoes
 * signature-based crash classification. Without the veto, fully green
 * sharded runs report `CRASH (N attempts)` because degradation warnings
 * match the psutil signals. A summary printed after a crash marker is not
 * "completed": it only covers the files that ran before the crash.
 * Exported for direct unit testing.
 */
export function hasCompletedGreenSummary(output: string): boolean {
  return hasGreenShapedSummary(output) && findCrashMarkerLine(output) === undefined;
}

/**
 * True when the captured output carries the suite-specific xpcshell
 * result-summary block, which proves tests executed even though the
 * xpcshell dispatch emits no `TEST-START` line. Used alongside
 * `TEST_START_PATTERN` so a green single-file xpcshell run is not
 * mis-classified as `no-tests`. Exported for direct unit testing.
 */
function hasXpcshellResultSummary(output: string): boolean {
  return XPCSHELL_RESULT_SUMMARY_PATTERN.test(output);
}

/** Unexpected-failure lines that are not the shutdown re-entry artifact. */
function realUnexpectedFailureLines(output: string): string[] {
  const matches = [
    ...(output.match(UNEXPECTED_LINE_PATTERN) ?? []),
    ...(output.match(FAIL_LINE_PATTERN) ?? []),
    ...(output.match(ASSERTION_LINE_PATTERN) ?? []),
  ];
  if (NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(output)) {
    const summary = output
      .split(/\r?\n/)
      .find((line) => NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(line));
    if (summary) matches.push(summary);
  }
  return [...new Set(matches.map((line) => line.trim()))].filter(
    (line) => !SHUTDOWN_REENTRY_PATTERN.test(line)
  );
}

/**
 * Non-global copies of the unexpected/assertion patterns for per-line use.
 * The `g`-flagged module patterns carry `lastIndex` state across `.test()`
 * calls and must never be reused line-by-line.
 */
const UNEXPECTED_LINE_SINGLE = /\bTEST-UNEXPECTED-[A-Z-]+\b/;
/**
 * Context lines the chrome/xpcshell harnesses print directly under a
 * TEST-UNEXPECTED line: `Got …` / `Expected …` / `Actual …`, Assert
 * messages, diff markers, stack-trace heads, and indented continuation
 * lines.
 */
const FAILURE_CONTEXT_LINE_PATTERN =
  /^(?:\s*(?:Got\b|Expected\b|Actual\b|Assert\w*\b|Stack trace:|[-+]\s)|\s{2,}\S)/;

/** Cap on context lines echoed under a single TEST-UNEXPECTED line. */
const FAILURE_BLOCK_CONTEXT_LIMIT = 6;

/**
 * Collects the first `limit` TEST-UNEXPECTED-* lines with their trailing
 * assertion/diff context, one string per block. The shutdown-reentry
 * artifact is excluded (it is harness noise, not a test result). When more
 * than `limit` blocks exist, a final `…(+N more …)` note is appended so the
 * operator knows the echo was truncated. Pure. Exported for unit tests.
 */
export function collectUnexpectedFailureBlocks(output: string, limit = 5): string[] {
  const lines = output.split(/\r?\n/);
  const blocks: string[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!UNEXPECTED_LINE_SINGLE.test(line) || SHUTDOWN_REENTRY_PATTERN.test(line)) continue;

    if (blocks.length >= limit) {
      skipped++;
      continue;
    }

    const block = [line.trim()];
    let contextCount = 0;
    for (let j = i + 1; j < lines.length && contextCount < FAILURE_BLOCK_CONTEXT_LIMIT; j++) {
      const next = lines[j] ?? '';
      if (UNEXPECTED_LINE_SINGLE.test(next)) break;
      if (!FAILURE_CONTEXT_LINE_PATTERN.test(next)) break;
      block.push(next.trimEnd());
      contextCount++;
    }
    blocks.push(block.join('\n'));
  }

  if (skipped > 0) {
    blocks.push(`…(+${skipped} more TEST-UNEXPECTED line${skipped === 1 ? '' : 's'} not shown)`);
  }
  return blocks;
}

function detectSecondaryHarnessNoise(output: string): HarnessCrashSignature | undefined {
  const evidence = stripNonSignalNoise(output);
  if (TRACEBACK_PATTERN.test(evidence)) {
    const signalLine = findLine(evidence, STARTUP_TRACEBACK_SIGNALS);
    if (signalLine) {
      return {
        reason: 'harness traceback also present (resource monitor/psutil)',
        line: signalLine,
      };
    }
  }
  const timeoutLine = findLine(evidence, [NO_OUTPUT_TIMEOUT_PATTERN]);
  if (timeoutLine) {
    return { reason: 'harness no-output timeout also present', line: timeoutLine };
  }
  return undefined;
}

/**
 * Detects the known harness-crash shapes in captured mach output.
 * Returns undefined for anything that looks like a genuine test result.
 */
export function detectHarnessCrashSignature(output: string): HarnessCrashSignature | undefined {
  // Browser/app process crashes are deterministic crash evidence, not
  // retriable environmental harness noise. Leave them to
  // `classifyHarnessRun` so it can reject green-looking truncated summaries
  // with the crash line plus never-started/never-ended file evidence.
  if (findCrashMarkerLine(output) !== undefined) {
    return undefined;
  }

  const hasTestStart = hasExecutionSignal(output);
  const realFailures = realUnexpectedFailureLines(output);
  // A completed green embedded summary vetoes signature-based crash
  // classification outright: the suite finished, so any startup-shaped
  // noise in the same output was non-fatal. (The post-green shutdown
  // re-entry shape below is exempt: it is a crash verdict on
  // an otherwise-green log, keyed on its own explicit markers.)
  const greenSummaryVeto = hasCompletedGreenSummary(output);

  // Startup traceback cluster (resource monitor / psutil), scanned over
  // noise-stripped evidence so degradation warnings and caught telemetry
  // tracebacks never count. Real test failures take precedence: a
  // traceback printed during teardown of a genuinely failing run must not
  // get the whole run retried.
  const evidence = stripNonSignalNoise(output);
  if (!greenSummaryVeto && TRACEBACK_PATTERN.test(evidence) && realFailures.length === 0) {
    const signalLine = findLine(evidence, STARTUP_TRACEBACK_SIGNALS);
    if (signalLine) {
      return { reason: 'harness startup traceback (resource monitor/psutil)', line: signalLine };
    }
  }

  // Post-browser-startup hang: no test ever started, the harness died at
  // the no-output timeout. A trailing "Passed: 0" summary is part of this
  // shape and must not be read as a result.
  if (!hasTestStart) {
    // Startup abort on the degraded-reading fallback family: the `_collect
    // failed: '_DegradedReading' ...` variant is caught-and-logged (no
    // Traceback header), so the traceback cluster above never sees it.
    if (realFailures.length === 0) {
      const degradedLine = findLine(evidence, DEGRADED_READING_CRASH_SIGNALS);
      if (degradedLine) {
        return {
          reason: 'degraded resource reading crashed the harness fallback (_DegradedReading)',
          line: degradedLine,
        };
      }
    }
    const timeoutLine = findLine(evidence, [NO_OUTPUT_TIMEOUT_PATTERN]);
    if (timeoutLine) {
      const harnessLines = startupContextLines(evidence);
      return {
        reason: 'no-output timeout before any test started',
        line: timeoutLine,
        ...(harnessLines.length > 0 ? { harnessLines } : {}),
      };
    }
    return undefined;
  }

  // Post-green shutdown re-entry: every unexpected line is the
  // shutdown-mid-test artifact, the run stalled on focus, and at least one
  // such artifact exists, on an otherwise green log.
  const shutdownLine = findLine(output, [SHUTDOWN_REENTRY_PATTERN]);
  if (shutdownLine && realFailures.length === 0 && FOCUS_STALL_PATTERN.test(output)) {
    return { reason: 'post-green shutdown re-entry during harness teardown', line: shutdownLine };
  }

  return undefined;
}

/**
 * Classifies a completed harness run. The decision tree, in order:
 *
 * 1. A recognized crash signature wins regardless of exit code (the
 *    shutdown re-entry shape exits non-zero on an otherwise green run,
 *    and the hang shape can even exit zero with a `Passed: 0` summary).
 * 2. No execution signal with explicit paths requested means no test ran.
 *    A mochitest server that failed to start explains that, and is a
 *    retriable infrastructure failure (`harness-crash` with
 *    `reason=server-startup` on the verdict line). Otherwise it is
 *    `no-tests`, even when the exit code is zero. The execution signal is
 *    a `TEST-START` line (generic `mach test` / browser-chrome dispatch)
 *    or the suite-specific xpcshell result-summary block (the xpcshell
 *    dispatch prints no `TEST-START`). Bare `Passed:`/`Failed:` summary
 *    lines are still not trusted as evidence of execution.
 * 3. Exit code zero with tests started passes only without hard failure,
 *    crash, or nonzero failure-summary evidence. Anything else is a
 *    test failure for the regular diagnosis chain, except a non-zero
 *    exit whose embedded summary completed green and shows no crash
 *    marker and no truncated/never-started requested file, which is a
 *    pass with a `greenSummaryOverride` note (recognized noise owns the
 *    exit code). A green-shaped summary with such evidence, a signal-shaped
 *    exit, a later unexplained traceback, or an exit no recognized noise
 *    accounts for is rejected (`greenSummaryRejected`) and fails.
 *    A summary that counted zero checks is `no-tests`.
 *
 * An exit-0 pass needs its own proof that the suite completed. With a raw log
 * that is the log's `suite_end`, and `vetoIncompletePass` accounts for the
 * files. Without one the text must carry a positive count and a completed
 * suite, and every started test must have ended.
 *
 * @param exitCode - The harness process exit code
 * @param output - Combined stdout/stderr from the run
 * @param requestedPaths - Dispatched paths
 * @param evidence - What the dispatch's raw log says, when it wrote one, and the
 *   start names of the complete stream, which the capped output may have lost
 */
export function classifyHarnessRun(
  exitCode: number,
  output: string,
  requestedPaths: readonly string[],
  evidence: { raw?: RawRunSummary | undefined; started?: readonly string[] } = {}
): HarnessRunVerdict {
  const { raw, started } = evidence;
  const counts = extractSummaryCounts(output);
  const profileFailure = classifyProfileArgumentFailure(output);
  if (profileFailure) return { ...profileFailure, ...counts };
  const realFailures = realUnexpectedFailureLines(output);
  const firstRealFailure =
    realFailures[0] ??
    findCrashMarkerLine(output) ??
    findLine(output, [NONZERO_UNEXPECTED_SUMMARY_PATTERN, NONZERO_FAILED_SUMMARY_PATTERN]);
  const failureKeys = (): Partial<HarnessRunVerdict> => {
    const blocks = collectUnexpectedFailureBlocks(output);
    const secondary =
      firstRealFailure !== undefined ? detectSecondaryHarnessNoise(output) : undefined;
    return {
      ...(firstRealFailure !== undefined ? { realFailureLine: firstRealFailure } : {}),
      ...(blocks.length > 0 ? { realFailureBlocks: blocks } : {}),
      ...(secondary !== undefined ? { secondaryHarnessSignature: secondary } : {}),
    };
  };
  // Checked before signature detection: a suite that ran clean and then died
  // in known upstream teardown noise is a pass, not a crash. The teardown
  // traceback matches the startup-traceback cluster, and the green-summary
  // veto over that cluster requires a `SUITE_END` marker, which this very
  // traceback is what prevents from printing. Without this check a
  // substantively green suite (`Ran N checks` / `Unexpected results: 0`, no
  // unexpected lines) reports CRASH, indistinguishable at the summary level
  // from a red run. Every hard-evidence veto still applies: a crash marker,
  // a non-zero unexpected count, any real TEST-UNEXPECTED line, the
  // shutdown-re-entry shape, or a requested file that never started keeps
  // the run failing. Only the missing shutdown marker is forgiven, and only
  // when the recognized teardown traceback explains it.
  const teardownOverride = isSignalExit(exitCode)
    ? { accepted: false as const }
    : evaluateGreenTeardownOverride(output, counts, realFailures, requestedPaths, started);
  if (teardownOverride.accepted) {
    return { kind: 'tests-ran-ok', note: 'harness teardown noise ignored', ...counts };
  }
  // A run that carried the recognized teardown noise and still failed says
  // WHICH condition rejected the override, on the one greppable line.
  const teardownNote =
    teardownOverride.rejectedBy !== undefined
      ? `green-teardown override rejected: ${teardownOverride.rejectedBy}`
      : undefined;
  const withNotes = <T extends HarnessRunVerdict>(verdict: T, extra?: string): T => {
    const notes = [teardownNote, extra].filter((n): n is string => n !== undefined);
    return notes.length > 0 ? { ...verdict, note: notes.join('; ') } : verdict;
  };

  const signature = detectHarnessCrashSignature(output);
  if (signature) {
    return withNotes({ kind: 'harness-crash', signature, ...counts });
  }

  const ranTests = hasExecutionSignal(output) || (raw?.testsEnded ?? 0) > 0;
  if (!ranTests && requestedPaths.length > 0) {
    const serverStartup = detectServerStartupFailure(output);
    return serverStartup === undefined
      ? { kind: 'no-tests', ...counts }
      : { kind: 'harness-crash', signature: serverStartup, ...counts };
  }
  // A summary that counted nothing never proves a run, whatever else the log
  // printed and whatever the exit code says. Real failure lines keep their own
  // diagnosis below.
  if (counts.checks === 0 && firstRealFailure === undefined) {
    return withNotes({ kind: 'no-tests', ...counts });
  }

  if (
    exitCode === 0 &&
    firstRealFailure === undefined &&
    !NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    !NONZERO_FAILED_SUMMARY_PATTERN.test(output)
  ) {
    const judged = judgeExitZeroRun(output, counts, requestedPaths, raw);
    return judged.kind === 'tests-ran-ok' ? judged : withNotes(judged);
  }
  // Exit codes follow the corrected verdict: a run whose embedded summary
  // completed green is a pass even when the wrapper exit code went non-zero
  // on harness noise. Real failures always carry a non-zero unexpected count
  // or TEST-UNEXPECTED lines, both of which fail the green-summary check.
  //
  // The override must never win over crash or truncation evidence: a SIGSEGV
  // at the second of eight files produces a "green" `Passed: 2 / Failed: 0`
  // summary and mach exit 1, green only because the crash prevented the
  // other six files from producing any results. A crash marker or an
  // unpaired/never-started requested file rejects the override with the
  // evidence attached, so the caller can say why.
  if (hasGreenShapedSummary(output)) {
    const crashLine = findCrashMarkerLine(output);
    const completeness = analyzeTestCompleteness(output, requestedPaths, started);
    const exitEvidence = unexplainedExitEvidence(exitCode, output);
    if (
      crashLine !== undefined ||
      completeness.neverStarted.length > 0 ||
      completeness.neverEnded.length > 0 ||
      exitEvidence !== undefined
    ) {
      return withNotes({
        kind: 'test-failures',
        ...counts,
        ...failureKeys(),
        greenSummaryRejected: {
          ...(crashLine !== undefined ? { crashLine } : {}),
          ...(exitEvidence !== undefined ? { exitEvidence } : {}),
          neverStarted: completeness.neverStarted,
          neverEnded: completeness.neverEnded,
        },
      });
    }
    return { kind: 'tests-ran-ok', greenSummaryOverride: true, ...counts };
  }
  const wordMatchNote = unmarkedFailureEvidenceNote(counts, realFailures);
  return withNotes(
    {
      kind: 'test-failures',
      ...counts,
      ...failureKeys(),
    },
    wordMatchNote
  );
}

/**
 * The verdict for an exit-0 run with no failure evidence: a pass only when the
 * run shows it completed. `Ran N checks` is what the summary prints at the end
 * of a suite, and every browser run closes with `SUITE_END`.
 */
function judgeExitZeroRun(
  output: string,
  counts: HarnessSummaryCounts,
  requestedPaths: readonly string[],
  raw: RawRunSummary | undefined
): HarnessRunVerdict {
  if (raw !== undefined) {
    if (raw.suiteCompleted) return { kind: 'tests-ran-ok', ...counts };
    return {
      kind: 'harness-crash',
      signature: {
        reason: 'the raw log has no completed suite',
        line: 'exit 0, with no suite_end for the last suite_start',
      },
      ...counts,
    };
  }
  const passed = POSITIVE_PASSED_SUMMARY_PATTERN.test(output);
  const positive = (counts.checks ?? 0) > 0 || passed;
  if (!positive && ZERO_PASSED_SUMMARY_PATTERN.test(output)) {
    return { kind: 'no-tests', ...counts };
  }
  const completed = SUITE_END_PATTERN.test(output) || counts.unexpected !== undefined;
  if (!positive || !completed) {
    return {
      kind: 'harness-crash',
      signature: {
        reason: 'the harness exited 0 without a completed suite summary',
        line: positive ? 'no SUITE_END or results summary' : 'no positive check count',
      },
      ...counts,
    };
  }
  const { neverEnded } = analyzeTestCompleteness(output, requestedPaths);
  if (neverEnded.length > 0) {
    return {
      kind: 'test-failures',
      ...counts,
      greenSummaryRejected: { neverStarted: [], neverEnded },
    };
  }
  return { kind: 'tests-ran-ok', ...counts };
}

/**
 * Exit values that mean the harness was killed: `128 + n`, Node's negated
 * signal number, and SIGKILL or SIGTERM relayed as a plain code.
 */
function isSignalExit(exitCode: number): boolean {
  return exitCode < 0 || exitCode > 128 || exitCode === 9 || exitCode === 15;
}

/**
 * Why a non-zero exit cannot be blamed on harness noise, or undefined when it
 * can. A green summary only speaks for the suite it closes, so the exit stays
 * unexplained, and the rest of the run unaccounted for, when:
 *
 *  - the process died on a signal;
 *  - a traceback after the last `SUITE_END` is not one the recognized
 *    resource-monitor signatures explain;
 *  - the output holds no recognized noise that could own the exit code, however
 *    many requested files finished.
 */
function unexplainedExitEvidence(exitCode: number, output: string): string | undefined {
  if (exitCode === 0) return undefined;
  if (isSignalExit(exitCode)) return `the harness died on a signal (exit ${exitCode})`;
  const lastSuiteEnd = lastSuiteEndOffset(output);
  const afterSuite = stripNonSignalNoise(lastSuiteEnd < 0 ? '' : output.slice(lastSuiteEnd));
  const traceback = /Traceback \(most recent call last\)[\s\S]*/.exec(afterSuite)?.[0];
  if (traceback !== undefined && findLine(traceback, RECOGNIZED_EXIT_NOISE) === undefined) {
    const exception = traceback
      .split(/\r?\n/)
      .find((line, index) => index > 0 && line.length > 0 && !/^\s/.test(line));
    return `a traceback followed the last suite summary: ${truncateEvidence(exception ?? traceback)}`;
  }
  if (!hasRecognizedExitNoise(output)) {
    return `exit ${exitCode} has no recognized noise signature to account for it`;
  }
  return undefined;
}

/**
 * True when the capture shows a substantively GREEN suite whose only
 * unexplained residue is the recognized mozsystemmonitor teardown
 * traceback.
 *
 * Requires, all of them: tests actually executed, the summary printed
 * `Ran N checks` with an explicit `Unexpected results: 0`, no non-zero
 * unexpected count anywhere, no real `TEST-UNEXPECTED-*`/assertion line,
 * no crash marker, every requested test file both started and ended, and
 * the recognized teardown traceback is present. Anything short of that
 * falls through to the normal (failing) chain, with the failing condition
 * named, so the next occurrence is a filed bug rather than another
 * undiagnosable re-run.
 *
 * The conditions are evaluated in a fixed order and the first failing one
 * is reported. A run can violate several, and reporting one deterministic
 * condition beats an unordered list of everything that happened to be true.
 */
function evaluateGreenTeardownOverride(
  output: string,
  counts: HarnessSummaryCounts,
  realFailures: readonly string[],
  requestedPaths: readonly string[],
  started: readonly string[] | undefined
): GreenTeardownOverride {
  if (!hasKnownTeardownNoise(output)) return { accepted: false };
  const reject = (rejectedBy: string): GreenTeardownOverride => ({ accepted: false, rejectedBy });

  if (!hasExecutionSignal(output)) return reject('no execution signal (no TEST-START/TEST_START)');
  if (counts.checks === undefined) return reject('summary printed no "Ran N checks" line');
  if (counts.checks === 0) return reject('summary reported zero checks');
  // `counts.unexpected === 0` IS the explicit-`Unexpected results: 0` test
  // the previous revision spelled a second time with
  // GREEN_UNEXPECTED_SUMMARY_PATTERN: the count is parsed from the same
  // line and an absent line leaves it undefined. The two are kept apart in
  // the message because "printed no such line" and "printed a non-zero one"
  // are different findings for the reader.
  if (counts.unexpected === undefined) {
    return reject('summary printed no "Unexpected results:" line');
  }
  if (counts.unexpected !== 0) {
    return reject(`summary reported unexpected=${counts.unexpected}`);
  }
  if (NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(output)) {
    return reject('a non-zero "Unexpected results:" line is present somewhere in the output');
  }
  if (NONZERO_FAILED_SUMMARY_PATTERN.test(output))
    return reject('a non-zero "Failed:" line is present somewhere in the output');
  if (realFailures.length > 0) {
    return reject(
      `${realFailures.length} matched failure line(s), first: ${truncateEvidence(realFailures[0] ?? '')}`
    );
  }
  const crashLine = findCrashMarkerLine(output);
  if (crashLine !== undefined)
    return reject(`crash marker present: ${truncateEvidence(crashLine)}`);
  // The post-green shutdown re-entry shape is deliberately a crash verdict
  // on an otherwise-green log. It must not be swept up here.
  if (SHUTDOWN_REENTRY_PATTERN.test(output)) {
    return reject('post-green shutdown re-entry shape present');
  }
  const completeness = analyzeTestCompleteness(output, requestedPaths, started);
  if (completeness.neverStarted.length > 0) {
    return reject(`requested file(s) never started: ${completeness.neverStarted.join(', ')}`);
  }
  if (completeness.neverEnded.length > 0) {
    return reject(`requested file(s) never ended: ${completeness.neverEnded.join(', ')}`);
  }
  return { accepted: true };
}

/**
 * Formats the machine-readable `FIREFORGE-VERDICT:` line: the stable,
 * greppable last line every `fireforge test` run prints so harness-verdict
 * consumers stop regexing mach internals. The status follows this
 * classifier, never the raw exit code: a crash-classified run says
 * `FAIL reason=crash` even at exit 0, and a green-summary-override pass
 * says `PASS` despite a non-zero mach exit. Count keys are omitted when
 * the embedded summary did not print them. Sharded aggregate lines carry
 * a trailing `shards=<passed>/<total>` instead of counts (counts belong
 * to a single embedded suite summary).
 */
export function formatFireforgeVerdictLine(
  verdict: HarnessRunVerdict,
  shards?: { passed: number; total: number; failed?: readonly string[] }
): string {
  const counts =
    (verdict.checks !== undefined ? ` checks=${verdict.checks}` : '') +
    (verdict.unexpected !== undefined ? ` unexpected=${verdict.unexpected}` : '');
  const tail = `${formatShardsSuffix(shards)}${verdict.note !== undefined ? ` (${verdict.note})` : ''}`;
  if (verdict.kind === 'tests-ran-ok') return `FIREFORGE-VERDICT: PASS${counts}${tail}`;
  const reason =
    verdict.kind === 'harness-crash' ? (verdict.signature?.verdictReason ?? 'crash') : verdict.kind;
  return `FIREFORGE-VERDICT: FAIL reason=${reason}${counts}${formatIncompleteSuffix(verdict.incomplete)}${tail}`;
}

/**
 * Exit codes that mean "the child died on SIGSEGV": Node reports a
 * signal-killed child as the negated signal number, while a shell layer
 * in between reports `128 + signal`. Both shapes reach FireForge
 * depending on how mach wrapped the harness.
 */
const SIGSEGV_EXIT_CODES = new Set([-11, 139]);

/**
 * True when a harness run died on SIGSEGV having produced no test evidence
 * whatsoever.
 *
 * `xpcshell return code: -11` with zero output is the signature of an
 * `.sys.mjs` that a packaged module imports but whose `EXTRA_JS_MODULES`
 * registration never landed: the module loader faults before any logging
 * exists, so there is no import error, no stack, no test output, just a
 * dead process. It is indistinguishable from a genuine product crash
 * unless someone names the cause.
 *
 * "Produced no evidence" is semantic rather than a byte
 * budget: no execution signal, no real failure line, and no mozcrash
 * marker. A run that got far enough to start a test, report a failure, or
 * leave a crash dump has evidence of its own, and the regular diagnosis
 * chain reads it. This branch is only for the case where there is
 * nothing else to say.
 *
 * Pure. Exported for direct unit testing.
 *
 * @param exitCode - The harness process exit code
 * @param output - Combined stdout/stderr from the run
 */
export function isSilentSegfault(exitCode: number, output: string): boolean {
  if (!SIGSEGV_EXIT_CODES.has(exitCode)) return false;
  if (hasExecutionSignal(output)) return false;
  if (realUnexpectedFailureLines(output).length > 0) return false;
  return findCrashMarkerLine(output) === undefined;
}
