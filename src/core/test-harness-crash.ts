// SPDX-License-Identifier: EUPL-1.2
/**
 * Harness-crash classification for `fireforge test` (field reports C1/C2).
 *
 * The wrapped mach harness exhibits flaky non-test failures that an exit
 * code (or a "did it print a summary" grep) cannot distinguish from real
 * test results:
 *
 *  - startup crashes from the mozlog resource monitor on macOS
 *    (`AttributeError: 'SystemResourceMonitor' object has no attribute
 *    'poll_interval'`, `host_statistics64(HOST_VM_INFO64) syscall failed`,
 *    `(ipc/mig) array not large enough` — a psutil/macOS mismatch) which
 *    abort the run before any test executes;
 *  - hangs after browser startup that die at the no-output timeout yet
 *    still emit a `Passed: 0` summary;
 *  - post-green shutdown re-entry, where a fully green run stalls on
 *    "must wait for focus" and records "Application shut down (without
 *    crashing) in the middle of a test!" as the only unexpected failure.
 *
 * Classification therefore keys on `TEST-START` presence — summary lines
 * never count as proof that tests ran — and recognizes the crash shapes
 * above so the command layer can retry them with a bounded budget instead
 * of reporting phantom test failures (or phantom passes).
 */

/** How a completed harness run should be interpreted. */
export type HarnessRunClassification =
  'tests-ran-ok' | 'test-failures' | 'harness-crash' | 'no-tests';

/** A recognized harness-crash shape with its evidence line. */
export interface HarnessCrashSignature {
  reason: string;
  line: string;
}

/** Result of {@link classifyHarnessRun}. */
export interface HarnessRunVerdict {
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
   * embeds a completed green summary — the exit code followed harness
   * noise, not a test result. Callers should surface a note.
   */
  greenSummaryOverride?: boolean;
  /**
   * Set when the output embeds a green-LOOKING summary that was REJECTED:
   * crash or truncation evidence proves the suite never completed, so the
   * "green" counts only cover the files that ran before the run died
   * (field report: a SIGSEGV at the second of eight files left a
   * `Passed: 2 / Failed: 0` summary that 0.35.0 green-washed into a pass).
   * Callers must fail the run and surface the evidence.
   */
  greenSummaryRejected?: GreenSummaryRejection;
}

/** Why a green-looking embedded summary was not trusted. */
export interface GreenSummaryRejection {
  /** Crash-marker evidence line (mozcrash / signal kill), if any. */
  crashLine?: string;
  /** Requested test files with no `TEST_START`/`TEST-START` line at all. */
  neverStarted: string[];
  /** Files whose `TEST_START` has no matching end marker. */
  neverEnded: string[];
}

const TEST_START_PATTERN = /\bTEST-START\b/;
/**
 * Structured-log execution marker (`mach xpcshell-test` mozlog output uses
 * `TEST_START`/`SUITE_END` with underscores, not the hyphenated
 * `TEST-START` the browser-chrome dispatch prints).
 */
const STRUCTURED_TEST_START_PATTERN = /\bTEST_START\b/;
const SUITE_END_PATTERN = /\bSUITE_END\b/;
const GREEN_UNEXPECTED_SUMMARY_PATTERN = /\bUnexpected results:\s*0\b/;
const NONZERO_UNEXPECTED_SUMMARY_PATTERN = /\bUnexpected results:\s*[1-9]/;
/**
 * Execution signals emitted by the suite-specific xpcshell dispatch
 * (`mach xpcshell-test`), which does NOT print `TEST-START` lines the way
 * the generic `mach test` / browser-chrome dispatch does. A passing
 * single-file xpcshell run prints a result-summary block instead
 * (`TEST_END: Test PASS`, `Ran 16 checks`, `Unexpected results: 0`), so
 * keying execution purely on `TEST-START` mis-reads a green xpcshell run as
 * "no tests started" (field report: a single-file xpcshell pass exited 1).
 *
 * These markers are xpcshell-specific on purpose: the bare
 * `Passed: 0` / `Failed: 0` summary that the no-output hang shape prints is
 * deliberately NOT matched here — that case must still read as `no-tests`.
 */
const XPCSHELL_RESULT_SUMMARY_PATTERN = /\bTEST_END\b|\bRan \d+ checks?\b|\bResult summary:/i;
const UNEXPECTED_LINE_PATTERN = /^.*\bTEST-UNEXPECTED-[A-Z-]+\b.*$/gm;
const FAIL_LINE_PATTERN = /^.*\bFAIL\b.*$/gm;
const ASSERTION_LINE_PATTERN = /^.*\b(?:Assertion failure|MOZ_ASSERT|ASSERTION)\b.*$/gim;
const SHUTDOWN_REENTRY_PATTERN =
  /Application shut down \(without crashing\) in the middle of a test/i;
const FOCUS_STALL_PATTERN = /must wait for focus/i;
const TRACEBACK_PATTERN = /Traceback \(most recent call last\)/;
const NO_OUTPUT_TIMEOUT_PATTERN = /timed out after \d+ seconds with no output/i;

/**
 * Crash-marker lines mozcrash / the mochitest harness print when the
 * browser process itself died. Matched against the RAW output (never
 * noise-stripped): any of these proves the run was truncated by a crash,
 * so an embedded green summary is under-reporting, not a result (field
 * report: `Main app process: killed by SIGSEGV` at the second of eight
 * files, summary `Passed: 2 / Failed: 0`, mach exit 1 — 0.35.0 accepted
 * it as passed and masked a real regression for a whole drill).
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
// Downstream report (0.34.0 cycle): a pre-fix _DegradedReading fallback that
// wasn't a real namedtuple duck type crashed mozsystemmonitor on the fallback
// itself (`_build_meta` subscripts the reading; `_collect` unpacks it); a
// startup abort with zero TEST-START lines from this family is a crash, not
// a test failure. The `_collect failed` variant is caught-and-logged, so it
// carries no Traceback header — it gets its own zero-TEST-START check in
// `detectHarnessCrashSignature` besides joining the traceback cluster.
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
  // Field report (0.34.1): on a degraded host every collector sample is
  // rejected, aggregation has nothing, and mozbuild's log_resource_usage
  // dies on usage["io"].read_bytes AFTER a fully successful compile
  // ("Error running mach" with complete artifacts). Environmental, not a
  // build regression — the protected build retries it (incremental retry
  // is cheap and the guard keeps the retry green).
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
 * Non-signal noise lines: the resource-monitor degrade path (FireForge's
 * own guard plus mozlog's `_collect failed`) prints warnings on runs that
 * then complete green. Field report (0.34.0 cycle): every multi-file suite
 * was reported CRASH because these lines matched the startup-traceback
 * signals even though the embedded summary was fully green. They are
 * excluded from crash evidence entirely.
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
  // mozsystemmonitor's parent-side drain loop rejecting a malformed sample
  // (field report 0.34.1); mach sometimes reprints the warning text without
  // the `UserWarning:` token, and a run that completes despite the stream
  // must never classify as crash on it.
  /failed to read the received data/i,
];

/** Matches the caught/telemetry context that marks a traceback as benign. */
const BENIGN_TRACEBACK_CONTEXT = /telemetry|glean/i;

/**
 * Strips non-signal noise from captured output before crash-signature
 * matching: resource-monitor degradation warnings, and traceback blocks
 * that mach caught itself (telemetry submission tracebacks are printed but
 * never abort the run). The stripped text is used ONLY as crash evidence —
 * classification of test results still reads the full output.
 */
export function stripNonSignalNoise(output: string): string {
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
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
        i = j; // drop the whole caught-telemetry traceback block
        continue;
      }
      // A real traceback stays in evidence line-by-line (minus noise lines
      // already filtered above).
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * True when the output carries any execution signal: the browser-chrome
 * `TEST-START` marker, the structured-log `TEST_START` marker, or the
 * suite-specific xpcshell result-summary block.
 */
function hasExecutionSignal(output: string): boolean {
  return (
    TEST_START_PATTERN.test(output) ||
    STRUCTURED_TEST_START_PATTERN.test(output) ||
    hasXpcshellResultSummary(output)
  );
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
 * `TEST-UNEXPECTED-*` lines. Deliberately blind to crash/truncation
 * evidence — {@link hasCompletedGreenSummary} layers that on top, and
 * {@link classifyHarnessRun} needs the distinction to report WHY a
 * green-shaped summary was rejected.
 */
function hasGreenShapedSummary(output: string): boolean {
  return (
    hasExecutionSignal(output) &&
    SUITE_END_PATTERN.test(output) &&
    GREEN_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    !NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    realUnexpectedFailureLines(output).length === 0
  );
}

/**
 * True when the output embeds a COMPLETED, GREEN suite summary: an
 * execution signal, `Unexpected results: 0` (and no non-zero unexpected
 * count), a `SUITE_END` marker, no real `TEST-UNEXPECTED-*` lines — and
 * NO crash marker. Such a run finished its suite; any startup-traceback-
 * shaped noise in the same output is by definition non-fatal, so this
 * vetoes signature-based crash classification (field report: fully green
 * sharded runs reported `CRASH (N attempts)` because degradation warnings
 * matched the psutil signals). A summary printed after a crash marker is
 * NOT "completed" — it only covers the files that ran before the crash
 * (0.35.0 green-wash field report). Exported for direct unit testing.
 */
export function hasCompletedGreenSummary(output: string): boolean {
  return hasGreenShapedSummary(output) && findCrashMarkerLine(output) === undefined;
}

/** Basename shape of a mozbuild-manifest test implementation file. */
const TEST_FILE_BASENAME_PATTERN = /^(?:browser|test)_.*\.m?js$/;

/**
 * Start/end execution markers, both log dialects: the structured mozlog
 * `TEST_START`/`TEST_END` pair and the human browser-chrome
 * `TEST-START`/`TEST-OK` pair. `TEST-UNEXPECTED-*` end shapes are
 * irrelevant here — any such line already fails the green-summary check
 * before completeness is consulted.
 */
const START_MARKER_PATTERN = /\bTEST[-_]START\b[:| ]*\s*(\S+)?/;
const END_MARKER_PATTERN = /\bTEST[-_]END\b|\bTEST-OK\b/;

/**
 * Cross-checks run completeness against the requested test files: every
 * requested file must produce a start marker, and every started test must
 * produce an end marker (the harness emits both even for failing files).
 *
 * Ends are paired with starts POSITIONALLY (last open start is closed by
 * the next end), not by filename — the xpcshell dialect's `TEST_END: Test
 * PASS` lines do not name the file. Requested paths that are not
 * test-file-shaped (directories, manifests) are skipped for the
 * never-started check; the start/end pairing scan covers them regardless.
 * Exported for direct unit testing.
 */
export function analyzeTestCompleteness(
  output: string,
  requestedPaths: readonly string[]
): { neverStarted: string[]; neverEnded: string[] } {
  const startedNames: string[] = [];
  const openTests: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const startMatch = START_MARKER_PATTERN.exec(line);
    if (startMatch) {
      const name = startMatch[1] ?? '(unnamed test)';
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
 * True when the captured output carries the suite-specific xpcshell
 * result-summary block, which proves tests executed even though the
 * xpcshell dispatch emits no `TEST-START` line. Used alongside
 * `TEST_START_PATTERN` so a green single-file xpcshell run is not
 * mis-classified as `no-tests`. Exported for direct unit testing.
 */
function hasXpcshellResultSummary(output: string): boolean {
  return XPCSHELL_RESULT_SUMMARY_PATTERN.test(output);
}

/** Unexpected-failure lines that are NOT the shutdown re-entry artifact. */
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
 * Non-global copies of the unexpected/assertion patterns for per-line use —
 * the `g`-flagged module patterns carry `lastIndex` state across `.test()`
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
 * operator knows the echo was truncated. Pure; exported for unit tests.
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
  // re-entry shape below is exempt — it is deliberately a crash verdict on
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
      return { reason: 'no-output timeout before any test started', line: timeoutLine };
    }
    return undefined;
  }

  // Post-green shutdown re-entry: every unexpected line is the
  // shutdown-mid-test artifact, the run stalled on focus, and at least one
  // such artifact exists — an otherwise green log.
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
 *    shutdown re-entry shape exits non-zero on an otherwise green run;
 *    the hang shape can even exit zero with a `Passed: 0` summary).
 * 2. No execution signal with explicit paths requested means no test ran —
 *    `no-tests`, even when the exit code is zero. The execution signal is
 *    a `TEST-START` line (generic `mach test` / browser-chrome dispatch)
 *    OR the suite-specific xpcshell result-summary block (the xpcshell
 *    dispatch prints no `TEST-START`). Bare `Passed:`/`Failed:` summary
 *    lines are still not trusted as evidence of execution.
 * 3. Exit code zero with tests started is a pass; anything else is a
 *    test failure for the regular diagnosis chain — except a non-zero
 *    exit whose embedded summary completed green AND shows no crash
 *    marker and no truncated/never-started requested file, which is a
 *    pass with a `greenSummaryOverride` note (harness noise owns the
 *    exit code). A green-shaped summary WITH such evidence is rejected
 *    (`greenSummaryRejected`) and fails.
 */
export function classifyHarnessRun(
  exitCode: number,
  output: string,
  requestedPaths: readonly string[]
): HarnessRunVerdict {
  const realFailures = realUnexpectedFailureLines(output);
  const firstRealFailure = realFailures[0];
  const failureBlocks = collectUnexpectedFailureBlocks(output);
  const secondaryHarnessSignature =
    firstRealFailure !== undefined ? detectSecondaryHarnessNoise(output) : undefined;
  const signature = detectHarnessCrashSignature(output);
  if (signature) {
    return { kind: 'harness-crash', signature };
  }

  const ranTests = hasExecutionSignal(output);
  if (!ranTests && requestedPaths.length > 0) {
    return { kind: 'no-tests' };
  }

  if (exitCode === 0) {
    return { kind: 'tests-ran-ok' };
  }
  // Exit codes follow the corrected verdict: a run whose embedded summary
  // completed green is a pass even when the wrapper exit code went
  // non-zero on harness noise (field report: a fully green --no-shard run
  // exited 1). Real failures always carry a non-zero unexpected count or
  // TEST-UNEXPECTED lines, both of which fail the green-summary check.
  //
  // The override must never win over crash or truncation evidence
  // (0.35.0 green-wash field report: a SIGSEGV at the second of eight
  // files produced a "green" `Passed: 2 / Failed: 0` summary and mach
  // exit 1 — the summary was green only because the crash prevented the
  // other six files from producing any results). A crash marker or an
  // unpaired/never-started requested file rejects the override with the
  // evidence attached, so the caller can say why.
  if (hasGreenShapedSummary(output)) {
    const crashLine = findCrashMarkerLine(output);
    const completeness = analyzeTestCompleteness(output, requestedPaths);
    if (
      crashLine !== undefined ||
      completeness.neverStarted.length > 0 ||
      completeness.neverEnded.length > 0
    ) {
      return {
        kind: 'test-failures',
        ...(firstRealFailure !== undefined ? { realFailureLine: firstRealFailure } : {}),
        ...(failureBlocks.length > 0 ? { realFailureBlocks: failureBlocks } : {}),
        ...(secondaryHarnessSignature !== undefined ? { secondaryHarnessSignature } : {}),
        greenSummaryRejected: {
          ...(crashLine !== undefined ? { crashLine } : {}),
          neverStarted: completeness.neverStarted,
          neverEnded: completeness.neverEnded,
        },
      };
    }
    return { kind: 'tests-ran-ok', greenSummaryOverride: true };
  }
  return {
    kind: 'test-failures',
    ...(firstRealFailure !== undefined ? { realFailureLine: firstRealFailure } : {}),
    ...(failureBlocks.length > 0 ? { realFailureBlocks: failureBlocks } : {}),
    ...(secondaryHarnessSignature !== undefined ? { secondaryHarnessSignature } : {}),
  };
}

/**
 * Builds the operator-facing failure message for a green-looking summary
 * that was rejected on crash or truncation evidence (never trusted as a
 * pass, regardless of how green the embedded counts look).
 */
export function buildGreenSummaryRejectedMessage(
  rejection: GreenSummaryRejection,
  exitCode: number
): string {
  const evidence: string[] = [];
  if (rejection.crashLine !== undefined) {
    evidence.push(`  - crash evidence: ${rejection.crashLine}`);
  }
  if (rejection.neverStarted.length > 0) {
    evidence.push(
      `  - requested test file(s) that never started: ${rejection.neverStarted.join(', ')}`
    );
  }
  if (rejection.neverEnded.length > 0) {
    evidence.push(
      `  - test file(s) that started but never finished: ${rejection.neverEnded.join(', ')}`
    );
  }
  return (
    `mach exited ${exitCode} and the embedded suite summary looks green, but FireForge did NOT ` +
    'treat the run as passed:\n\n' +
    `${evidence.join('\n')}\n\n` +
    'A crash- or truncation-shortened run under-reports: the "green" counts only cover the ' +
    'files that ran before the run died, so the summary is not a suite result. Treat this as a ' +
    'FAILED run — check the crash/truncation point in the output above, then re-run the ' +
    'remaining files.'
  );
}

/** Builds the operator-facing failure message after retries are exhausted. */
export function buildHarnessCrashMessage(
  signature: HarnessCrashSignature,
  attempts: number,
  commandLabel = 'mach test'
): string {
  return (
    `${commandLabel} crashed in the harness itself (not in your tests) on all ${attempts} attempt(s).\n\n` +
    `Detected shape: ${signature.reason}\n` +
    `Evidence line: ${signature.line}\n\n` +
    'This failure mode is environmental (mozlog resource monitor / psutil on macOS, focus-stall ' +
    'shutdown re-entry, or a pre-test hang) rather than a test regression. Re-run the command, ' +
    'raise the retry budget with --harness-retries <n>, or run the file in isolation. ' +
    'If it persists across many runs, inspect the mach virtualenv (mach resyncs psutil on its own; ' +
    'patching it manually does not stick).'
  );
}

/**
 * Optional hint appended to the harness-crash message when a HEADED run on
 * macOS died at the no-output timeout: the display may have slept and frozen
 * the headed browser before any test started (FORGE F17). Pure — the
 * platform is injected so unit tests need no mocking.
 */
export function headedNoOutputTimeoutHint(
  signature: HarnessCrashSignature,
  context: { headless: boolean; platform: string }
): string | undefined {
  if (context.platform !== 'darwin' || context.headless) return undefined;
  if (!signature.reason.includes('no-output timeout')) return undefined;
  return (
    'Hint: this was a HEADED run on macOS that died at the no-output timeout. ' +
    'A common cause is the display going to sleep mid-run, which freezes the headed browser ' +
    'before any test starts. Wrap headed runs in `caffeinate -dimsu <command>` to keep the ' +
    'display awake, or pass --headless.'
  );
}

/**
 * Builds the message for a run that produced no `TEST-START` despite
 * requesting paths — including exit-code-zero runs whose `Passed: 0`
 * summary would otherwise read as a silent false green.
 */
export function buildNoTestsRanMessage(
  exitCode: number,
  requestedPaths: readonly string[]
): string {
  const exitNote =
    exitCode === 0
      ? 'The harness exited 0 and may have printed a summary line, but a summary without a single TEST-START is not a test result.'
      : `The harness exited ${exitCode} before any TEST-START line.`;
  return (
    'mach test finished without starting any of the requested tests.\n\n' +
    `${exitNote}\n\n` +
    `Requested paths: ${requestedPaths.join(', ')}\n\n` +
    'Check that the paths are registered in their test manifest (browser.toml / xpcshell.toml) ' +
    'and that the manifest is reachable from moz.build, then retry.'
  );
}
