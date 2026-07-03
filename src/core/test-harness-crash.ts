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
  /**
   * Set when a non-zero mach exit code was overridden because the output
   * embeds a completed green summary — the exit code followed harness
   * noise, not a test result. Callers should surface a note.
   */
  greenSummaryOverride?: boolean;
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
const SHUTDOWN_REENTRY_PATTERN =
  /Application shut down \(without crashing\) in the middle of a test/i;
const FOCUS_STALL_PATTERN = /must wait for focus/i;
const TRACEBACK_PATTERN = /Traceback \(most recent call last\)/;
const NO_OUTPUT_TIMEOUT_PATTERN = /timed out after \d+ seconds with no output/i;

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
 * True when the output embeds a COMPLETED, GREEN suite summary: an
 * execution signal, `Unexpected results: 0` (and no non-zero unexpected
 * count), a `SUITE_END` marker, and no real `TEST-UNEXPECTED-*` lines.
 * Such a run finished its suite; any startup-traceback-shaped noise in the
 * same output is by definition non-fatal, so this vetoes signature-based
 * crash classification (field report: fully green sharded runs reported
 * `CRASH (N attempts)` because degradation warnings matched the psutil
 * signals). Exported for direct unit testing.
 */
export function hasCompletedGreenSummary(output: string): boolean {
  return (
    hasExecutionSignal(output) &&
    SUITE_END_PATTERN.test(output) &&
    GREEN_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    !NONZERO_UNEXPECTED_SUMMARY_PATTERN.test(output) &&
    realUnexpectedFailureLines(output).length === 0
  );
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
  const matches = output.match(UNEXPECTED_LINE_PATTERN) ?? [];
  return matches.filter((line) => !SHUTDOWN_REENTRY_PATTERN.test(line));
}

/**
 * Detects the known harness-crash shapes in captured mach output.
 * Returns undefined for anything that looks like a genuine test result.
 */
export function detectHarnessCrashSignature(output: string): HarnessCrashSignature | undefined {
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
 *    test failure for the regular diagnosis chain.
 */
export function classifyHarnessRun(
  exitCode: number,
  output: string,
  requestedPaths: readonly string[]
): HarnessRunVerdict {
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
  if (hasCompletedGreenSummary(output)) {
    return { kind: 'tests-ran-ok', greenSummaryOverride: true };
  }
  return { kind: 'test-failures' };
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
