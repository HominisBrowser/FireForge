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
  | 'tests-ran-ok'
  | 'test-failures'
  | 'harness-crash'
  | 'no-tests';

/** A recognized harness-crash shape with its evidence line. */
export interface HarnessCrashSignature {
  reason: string;
  line: string;
}

/** Result of {@link classifyHarnessRun}. */
export interface HarnessRunVerdict {
  kind: HarnessRunClassification;
  signature?: HarnessCrashSignature;
}

const TEST_START_PATTERN = /\bTEST-START\b/;
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
const STARTUP_TRACEBACK_SIGNALS: readonly RegExp[] = [
  /AttributeError:.*SystemResourceMonitor/,
  /'SystemResourceMonitor' object has no attribute/,
  /poll_interval/,
  /host_statistics64/,
  /HOST_VM_INFO64/,
  /\(ipc\/mig\) array not large enough/,
  /psutil\.[A-Za-z]*Error/,
];

function findLine(output: string, patterns: readonly RegExp[]): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (patterns.some((p) => p.test(line))) return line.trim();
  }
  return undefined;
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
  const hasTestStart = TEST_START_PATTERN.test(output);
  const realFailures = realUnexpectedFailureLines(output);

  // Startup traceback cluster (resource monitor / psutil). Real test
  // failures take precedence: a traceback printed during teardown of a
  // genuinely failing run must not get the whole run retried.
  if (TRACEBACK_PATTERN.test(output) && realFailures.length === 0) {
    const signalLine = findLine(output, STARTUP_TRACEBACK_SIGNALS);
    if (signalLine) {
      return { reason: 'harness startup traceback (resource monitor/psutil)', line: signalLine };
    }
  }

  // Post-browser-startup hang: no test ever started, the harness died at
  // the no-output timeout. A trailing "Passed: 0" summary is part of this
  // shape and must not be read as a result.
  if (!hasTestStart) {
    const timeoutLine = findLine(output, [NO_OUTPUT_TIMEOUT_PATTERN]);
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
 * 2. No `TEST-START` with explicit paths requested means no test ran —
 *    `no-tests`, even when the exit code is zero. Summary lines are not
 *    trusted as evidence of execution.
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

  if (!TEST_START_PATTERN.test(output) && requestedPaths.length > 0) {
    return { kind: 'no-tests' };
  }

  return exitCode === 0 ? { kind: 'tests-ran-ok' } : { kind: 'test-failures' };
}

/** Builds the operator-facing failure message after retries are exhausted. */
export function buildHarnessCrashMessage(
  signature: HarnessCrashSignature,
  attempts: number
): string {
  return (
    `mach test crashed in the harness itself (not in your tests) on all ${attempts} attempt(s).\n\n` +
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
