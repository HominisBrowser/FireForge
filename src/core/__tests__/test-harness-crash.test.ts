// SPDX-License-Identifier: EUPL-1.2
/**
 * Classifier tests for the field-observed harness flake shapes (C1/C2),
 * driven by simulated mach output fixtures — no live Firefox checkout.
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeTestCompleteness,
  buildGreenSummaryRejectedMessage,
  buildHarnessCrashMessage,
  buildNoTestsRanMessage,
  classifyHarnessRun,
  detectHarnessCrashSignature,
  findCrashMarkerLine,
  hasCompletedGreenSummary,
  stripNonSignalNoise,
} from '../test-harness-crash.js';

const PATHS = ['browser/components/foo/test/browser_foo.js'];

const RESOURCE_MONITOR_TRACEBACK = [
  ' 0:00.81 INFO Checking for orphan ssltunnel processes...',
  'Traceback (most recent call last):',
  '  File "mozlog/handlers/base.py", line 41, in __call__',
  '    self.stream_handler(data)',
  '  File "mozlog/handlers/resource.py", line 23, in start',
  "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
  'Error running mach',
].join('\n');

const MIG_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "psutil/_psosx.py", line 351, in virtual_memory',
  'host_statistics64(HOST_VM_INFO64) syscall failed: (ipc/mig) array not large enough',
  'Error running mach',
].join('\n');

const GREEN_RUN = [
  ' 0:05.12 INFO TEST-START | browser/components/foo/test/browser_foo.js',
  ' 0:09.44 INFO TEST-OK | browser/components/foo/test/browser_foo.js | took 4320ms',
  ' 0:10.01 INFO Passed: 12',
  ' 0:10.01 INFO Failed: 0',
].join('\n');

const REAL_FAILURE_RUN = [
  ' 0:05.12 INFO TEST-START | browser/components/foo/test/browser_foo.js',
  ' 0:09.44 INFO TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_foo.js | Assertion failed',
  ' 0:10.01 INFO Failed: 1',
].join('\n');

const HANG_WITH_FALSE_SUMMARY = [
  ' 0:04.20 INFO Application command: firefox -marionette',
  ' 6:14.77 ERROR Application ran for longer than allowed: timed out after 370 seconds with no output',
  ' 6:14.90 INFO Passed: 0',
  ' 6:14.90 INFO Failed: 0',
].join('\n');

// Captured shape of a passing single-file `mach xpcshell-test` dispatch.
// The suite-specific xpcshell command prints a result-summary block and a
// per-test `TEST_END: Test PASS` line, but NO `TEST-START` line — so a
// TEST-START-only execution heuristic mis-reads this green run as no-tests
// (the wrapper then appended "finished without starting any tests" and
// exited 1). Strings mirror the runxpcshelltests output, no live build.
const XPCSHELL_PASS_RUN = [
  ' 0:00.41 INFO | Running tests sequentially.',
  ' 0:00.42 INFO | TEST-INFO | (xpcshell/tests/toolkit/.../test_settings.js)',
  ' 0:02.18 INFO | TEST_END: Test PASS',
  ' 0:02.19 INFO | Result summary:',
  ' 0:02.19 INFO | Ran 16 checks (16 subtests, 0 tests)',
  ' 0:02.19 INFO | Passed: 16',
  ' 0:02.19 INFO | Failed: 0',
  ' 0:02.19 INFO | Unexpected results: 0',
].join('\n');

const XPCSHELL_FAIL_RUN = [
  ' 0:00.41 INFO | Running tests sequentially.',
  ' 0:02.18 INFO | TEST_END: Test FAIL',
  ' 0:02.19 INFO | Result summary:',
  ' 0:02.19 INFO | Ran 16 checks (16 subtests, 0 tests)',
  ' 0:02.19 INFO | Passed: 15',
  ' 0:02.19 INFO | Failed: 1',
  ' 0:02.19 INFO | Unexpected results: 1',
].join('\n');

const POST_GREEN_SHUTDOWN_REENTRY = [
  ' 0:05.12 INFO TEST-START | browser/components/foo/test/browser_foo.js',
  ' 0:09.44 INFO TEST-OK | browser/components/foo/test/browser_foo.js | took 4320ms',
  ' 0:10.01 INFO Passed: 12',
  ' 0:50.20 INFO must wait for focus',
  ' 0:51.33 INFO TEST-START | browser/components/foo/test/browser_foo.js',
  ' 0:51.40 ERROR TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_foo.js | Application shut down (without crashing) in the middle of a test!',
].join('\n');

describe('detectHarnessCrashSignature', () => {
  it('recognizes the resource-monitor startup traceback', () => {
    const sig = detectHarnessCrashSignature(RESOURCE_MONITOR_TRACEBACK);
    expect(sig?.reason).toContain('startup traceback');
    expect(sig?.line).toContain('SystemResourceMonitor');
  });

  it('recognizes the psutil/mig syscall traceback', () => {
    const sig = detectHarnessCrashSignature(MIG_TRACEBACK);
    expect(sig?.reason).toContain('startup traceback');
    expect(sig?.line).toContain('host_statistics64');
  });

  it('recognizes the pre-test no-output hang despite a Passed: 0 summary', () => {
    const sig = detectHarnessCrashSignature(HANG_WITH_FALSE_SUMMARY);
    expect(sig?.reason).toContain('no-output timeout');
  });

  it('recognizes the post-green shutdown re-entry shape', () => {
    const sig = detectHarnessCrashSignature(POST_GREEN_SHUTDOWN_REENTRY);
    expect(sig?.reason).toContain('shutdown re-entry');
  });

  it('does not classify a green run or a real failure as a crash', () => {
    expect(detectHarnessCrashSignature(GREEN_RUN)).toBeUndefined();
    expect(detectHarnessCrashSignature(REAL_FAILURE_RUN)).toBeUndefined();
  });

  it('lets real failures win over an incidental teardown traceback', () => {
    const mixed = `${REAL_FAILURE_RUN}\n${RESOURCE_MONITOR_TRACEBACK}`;
    expect(detectHarnessCrashSignature(mixed)).toBeUndefined();
  });

  it('does not treat shutdown re-entry as a crash when real failures exist', () => {
    const mixed = [
      POST_GREEN_SHUTDOWN_REENTRY,
      ' 0:52.00 ERROR TEST-UNEXPECTED-FAIL | browser_foo.js | real assertion broke',
    ].join('\n');
    expect(detectHarnessCrashSignature(mixed)).toBeUndefined();
  });
});

describe('classifyHarnessRun', () => {
  it('classifies green runs and real failures by exit code', () => {
    expect(classifyHarnessRun(0, GREEN_RUN, PATHS).kind).toBe('tests-ran-ok');
    expect(classifyHarnessRun(1, REAL_FAILURE_RUN, PATHS).kind).toBe('test-failures');
  });

  it('classifies crash signatures as harness-crash regardless of exit code', () => {
    expect(classifyHarnessRun(1, RESOURCE_MONITOR_TRACEBACK, PATHS).kind).toBe('harness-crash');
    expect(classifyHarnessRun(0, HANG_WITH_FALSE_SUMMARY, PATHS).kind).toBe('harness-crash');
    expect(classifyHarnessRun(1, POST_GREEN_SHUTDOWN_REENTRY, PATHS).kind).toBe('harness-crash');
  });

  it('treats zero TEST-START with requested paths as no-tests even on exit 0', () => {
    const summaryOnly = ' 0:10.01 INFO Passed: 0\n 0:10.01 INFO Failed: 0';
    const verdict = classifyHarnessRun(0, summaryOnly, PATHS);
    expect(verdict.kind).toBe('no-tests');
  });

  it('does not raise no-tests for full-suite runs without explicit paths', () => {
    expect(classifyHarnessRun(0, 'Passed: 0', []).kind).toBe('tests-ran-ok');
  });

  it('treats a passing xpcshell suite summary (no TEST-START) as tests-ran-ok', () => {
    const xpcshellPaths = ['toolkit/components/foo/test/unit/test_settings.js'];
    expect(classifyHarnessRun(0, XPCSHELL_PASS_RUN, xpcshellPaths).kind).toBe('tests-ran-ok');
  });

  it('still reports test-failures for a failing xpcshell suite summary', () => {
    const xpcshellPaths = ['toolkit/components/foo/test/unit/test_settings.js'];
    expect(classifyHarnessRun(1, XPCSHELL_FAIL_RUN, xpcshellPaths).kind).toBe('test-failures');
  });

  it('does not treat a bare Passed/Failed summary as an xpcshell execution signal', () => {
    // The no-output hang's `Passed: 0` summary must not be mistaken for an
    // xpcshell result-summary block — it stays no-tests.
    const summaryOnly = ' 0:10.01 INFO Passed: 0\n 0:10.01 INFO Failed: 0';
    expect(classifyHarnessRun(0, summaryOnly, PATHS).kind).toBe('no-tests');
  });
});

// ── 0.34.0 field report: fully green sharded runs reported CRASH ──
//
// A completed multi-file xpcshell suite whose output ALSO carries the
// non-fatal resource-monitor degradation warnings and a caught telemetry
// traceback. The embedded summary is green (Unexpected results: 0,
// SUITE_END), yet the signature strings (psutil, _collect) matched the
// startup-traceback cluster and every suite was classified CRASH.
const GREEN_XPCSHELL_WITH_DEGRADATION_NOISE = [
  ' 0:00.30 SUITE_START',
  ' 0:00.41 INFO | Running tests sequentially.',
  '/x/_venv/lib/python3.11/site-packages/fireforge_mach_guard.py:12: UserWarning: psutil failed to run: host_statistics64(HOST_VM_INFO64) syscall failed',
  '  warnings.warn(',
  ' 0:00.50 WARNING _collect failed: poll_interval unavailable on degraded monitor',
  ' 0:00.60 TEST_START | test_one.js',
  ' 0:02.18 INFO | TEST_END: Test PASS',
  ' 0:02.20 TEST_START | test_two.js',
  ' 0:04.02 INFO | TEST_END: Test PASS',
  'Traceback (most recent call last):',
  '  File "mach/telemetry.py", line 661, in submit_telemetry',
  '    record_telemetry_event(data)',
  'ConnectionError: telemetry submission failed (offline)',
  ' 0:04.10 INFO | Result summary:',
  ' 0:04.10 INFO | Ran 42 checks (40 subtests, 2 tests)',
  ' 0:04.10 INFO | Passed: 42',
  ' 0:04.10 INFO | Failed: 0',
  ' 0:04.10 INFO | Unexpected results: 0',
  ' 0:04.11 SUITE_END',
].join('\n');

const XPCSHELL_DIR_PATHS = ['toolkit/components/foo/test/unit'];

describe('green-summary veto and noise exclusion (0.34.0)', () => {
  it('does not classify a completed green suite with degradation noise as a crash', () => {
    expect(detectHarnessCrashSignature(GREEN_XPCSHELL_WITH_DEGRADATION_NOISE)).toBeUndefined();
  });

  it('classifies the green-with-noise run as tests-ran-ok on exit 0', () => {
    expect(
      classifyHarnessRun(0, GREEN_XPCSHELL_WITH_DEGRADATION_NOISE, XPCSHELL_DIR_PATHS).kind
    ).toBe('tests-ran-ok');
  });

  it('overrides a non-zero exit code when the embedded summary completed green (--no-shard field case)', () => {
    const verdict = classifyHarnessRun(
      1,
      GREEN_XPCSHELL_WITH_DEGRADATION_NOISE,
      XPCSHELL_DIR_PATHS
    );
    expect(verdict.kind).toBe('tests-ran-ok');
    expect(verdict.greenSummaryOverride).toBe(true);
  });

  it('does NOT override a non-zero exit when the summary reports unexpected results', () => {
    const redSummary = GREEN_XPCSHELL_WITH_DEGRADATION_NOISE.replace(
      'Unexpected results: 0',
      'Unexpected results: 2'
    );
    expect(classifyHarnessRun(1, redSummary, XPCSHELL_DIR_PATHS).kind).toBe('test-failures');
  });

  it('excludes degradation warnings and caught telemetry tracebacks from crash evidence', () => {
    // Without the green summary the run is NOT vetoed — but the remaining
    // evidence (warnings + telemetry traceback only) must still not read
    // as a startup crash, because none of it is a fatal signal.
    const noiseOnly = [
      'UserWarning: psutil failed to run: host_statistics64 syscall failed',
      '  warnings.warn(',
      '_collect failed: poll_interval unavailable',
      'Traceback (most recent call last):',
      '  File "mach/telemetry.py", line 661, in submit_telemetry',
      'ConnectionError: telemetry submission failed',
      ' 0:00.60 TEST_START | test_one.js',
      ' 0:02.18 INFO | TEST_END: Test PASS',
    ].join('\n');
    expect(detectHarnessCrashSignature(noiseOnly)).toBeUndefined();
  });

  it('keeps a real (non-telemetry) traceback in the evidence after stripping noise', () => {
    const stripped = stripNonSignalNoise(RESOURCE_MONITOR_TRACEBACK);
    expect(stripped).toContain("no attribute 'poll_interval'");
    const strippedNoise = stripNonSignalNoise(GREEN_XPCSHELL_WITH_DEGRADATION_NOISE);
    expect(strippedNoise).not.toContain('UserWarning');
    expect(strippedNoise).not.toContain('telemetry');
    expect(strippedNoise).not.toContain('_collect failed');
  });

  it('hasCompletedGreenSummary requires execution signal, green count, and SUITE_END', () => {
    expect(hasCompletedGreenSummary(GREEN_XPCSHELL_WITH_DEGRADATION_NOISE)).toBe(true);
    // No SUITE_END → incomplete, no veto.
    expect(
      hasCompletedGreenSummary(GREEN_XPCSHELL_WITH_DEGRADATION_NOISE.replace(/SUITE_END/g, ''))
    ).toBe(false);
    // Non-zero unexpected count → not green.
    expect(
      hasCompletedGreenSummary(
        GREEN_XPCSHELL_WITH_DEGRADATION_NOISE.replace(
          'Unexpected results: 0',
          'Unexpected results: 3'
        )
      )
    ).toBe(false);
    // Summary lines without any execution signal → not a completed run.
    expect(hasCompletedGreenSummary('Unexpected results: 0\nSUITE_END')).toBe(false);
  });

  it('keeps the post-green shutdown re-entry shape as a crash despite green-looking lines', () => {
    expect(detectHarnessCrashSignature(POST_GREEN_SHUTDOWN_REENTRY)?.reason).toContain(
      'shutdown re-entry'
    );
  });
});

// ── 0.34.0 downstream report (Hominis): _DegradedReading fallback ──
//
// The pre-fix degraded psutil fallback only survived attribute access, so
// mozsystemmonitor crashed on the fallback itself in two shapes, both
// aborting mach mochitest at startup with zero TEST-START lines.
const DEGRADED_SUBSCRIPT_STARTUP_ABORT = [
  ' 0:00.81 INFO Checking for orphan ssltunnel processes...',
  'Traceback (most recent call last):',
  '  File "mozsystemmonitor/resourcemonitor.py", line 12, in _build_meta',
  '    "system_memory": psutil.virtual_memory()[0],',
  "TypeError: '_DegradedReading' object is not subscriptable",
  'Error running mach',
].join('\n');

const DEGRADED_ITERABLE_STARTUP_ABORT = [
  ' 0:00.81 INFO Checking for orphan ssltunnel processes...',
  " 0:00.92 WARNING _collect failed: '_DegradedReading' object is not iterable",
  'Error running mach',
].join('\n');

describe('_DegradedReading fallback crash signatures (0.34.0 downstream report)', () => {
  it('classifies the not-subscriptable startup abort as harness-crash', () => {
    const sig = detectHarnessCrashSignature(DEGRADED_SUBSCRIPT_STARTUP_ABORT);
    expect(sig?.line).toContain("'_DegradedReading' object is not subscriptable");
    expect(classifyHarnessRun(1, DEGRADED_SUBSCRIPT_STARTUP_ABORT, PATHS).kind).toBe(
      'harness-crash'
    );
  });

  it('classifies the not-iterable startup abort (no traceback header) as harness-crash', () => {
    const sig = detectHarnessCrashSignature(DEGRADED_ITERABLE_STARTUP_ABORT);
    expect(sig?.reason).toContain('_DegradedReading');
    expect(sig?.line).toContain("'_DegradedReading' object is not iterable");
    expect(classifyHarnessRun(1, DEGRADED_ITERABLE_STARTUP_ABORT, PATHS).kind).toBe(
      'harness-crash'
    );
  });

  it('keeps the _DegradedReading _collect line as evidence while plain _collect noise is stripped', () => {
    const mixed = [
      " 0:00.92 WARNING _collect failed: '_DegradedReading' object is not iterable",
      ' 0:00.93 WARNING _collect failed: poll_interval unavailable on degraded monitor',
    ].join('\n');
    const stripped = stripNonSignalNoise(mixed);
    expect(stripped).toContain("'_DegradedReading' object is not iterable");
    expect(stripped).not.toContain('poll_interval unavailable');
  });

  it('does not classify a completed green run with a _DegradedReading _collect line as a crash', () => {
    const greenWithDegradedLine = [
      " 0:00.92 WARNING _collect failed: '_DegradedReading' object is not iterable",
      GREEN_XPCSHELL_WITH_DEGRADATION_NOISE,
    ].join('\n');
    expect(detectHarnessCrashSignature(greenWithDegradedLine)).toBeUndefined();
    expect(classifyHarnessRun(0, greenWithDegradedLine, XPCSHELL_DIR_PATHS).kind).toBe(
      'tests-ran-ok'
    );
  });
});

// ── 0.34.1 field report: degraded-host drain-loop noise + post-success
// log_resource_usage crash ──
//
// On a flapping host, mozsystemmonitor's parent rejects malformed collector
// samples ("failed to read the received data") — chatter on runs that then
// complete — and mozbuild's log_resource_usage can die on
// usage["io"].read_bytes AFTER a fully successful compile, failing a build
// whose artifacts are complete.
const DRAIN_LOOP_WARNING_LINES = [
  ' 0:41.02 resourcemonitor.py:766: UserWarning: failed to read the received data: (0, 0, 0.0, 0, 0, 0, 0, 0)',
  ' 0:51.10 WARNING failed to read the received data: (0, 0, 0.0, -12, 0, 34, 0, 0)',
].join('\n');

const POST_SUCCESS_LOG_RESOURCE_USAGE_CRASH = [
  ' 46:12.44 Your build was successful!',
  'Traceback (most recent call last):',
  '  File "mozbuild/controller/building.py", line 526, in log_resource_usage',
  '    "io_read_bytes": usage["io"].read_bytes,',
  "AttributeError: 'NoneType' object has no attribute 'read_bytes'",
  'Error running mach',
].join('\n');

describe('degraded-host drain-loop and log_resource_usage shapes (0.34.1 field report)', () => {
  it('strips the drain-loop rejection warning from crash evidence, with or without the UserWarning token', () => {
    const stripped = stripNonSignalNoise(DRAIN_LOOP_WARNING_LINES);
    expect(stripped).not.toContain('failed to read the received data');
  });

  it('does not classify a completed green run with drain-loop warnings as a crash', () => {
    const greenWithDrainNoise = [
      DRAIN_LOOP_WARNING_LINES,
      GREEN_XPCSHELL_WITH_DEGRADATION_NOISE,
    ].join('\n');
    expect(detectHarnessCrashSignature(greenWithDrainNoise)).toBeUndefined();
    expect(classifyHarnessRun(0, greenWithDrainNoise, XPCSHELL_DIR_PATHS).kind).toBe(
      'tests-ran-ok'
    );
  });

  it('classifies the post-success log_resource_usage AttributeError as harness-crash', () => {
    const sig = detectHarnessCrashSignature(POST_SUCCESS_LOG_RESOURCE_USAGE_CRASH);
    expect(sig?.reason).toContain('resource monitor');
    expect(sig?.line).toContain("'NoneType' object has no attribute 'read_bytes'");
    expect(classifyHarnessRun(1, POST_SUCCESS_LOG_RESOURCE_USAGE_CRASH, []).kind).toBe(
      'harness-crash'
    );
  });

  it('does not classify the read_bytes AttributeError as a crash when real test failures exist', () => {
    const failingRunWithNoise = [REAL_FAILURE_RUN, POST_SUCCESS_LOG_RESOURCE_USAGE_CRASH].join(
      '\n'
    );
    expect(detectHarnessCrashSignature(failingRunWithNoise)).toBeUndefined();
    expect(classifyHarnessRun(1, failingRunWithNoise, PATHS).kind).toBe('test-failures');
  });
});

// ── 0.35.0 field report: crash green-wash ──
//
// A browser-chrome manifest of 8 files whose parent process SIGSEGVed at
// the second file's TEST_START. The remaining six files never started, so
// the embedded summary was "green" (`Passed: 2 / Failed: 0, Unexpected
// results: 0`) only because the crash prevented them from producing any
// results — and 0.35.0's green-summary override reported the mach-exit-1
// run as PASSED. Log lines below are verbatim from the field log.
const HOMINIS_DIR = 'browser/base/content/test/hominis';
const HOMINIS_FILES = [
  `${HOMINIS_DIR}/browser_hominis_first.js`,
  `${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
  `${HOMINIS_DIR}/browser_hominis_third.js`,
  `${HOMINIS_DIR}/browser_hominis_fourth.js`,
  `${HOMINIS_DIR}/browser_hominis_fifth.js`,
  `${HOMINIS_DIR}/browser_hominis_sixth.js`,
  `${HOMINIS_DIR}/browser_hominis_seventh.js`,
  `${HOMINIS_DIR}/browser_hominis_eighth.js`,
];

const SIGSEGV_TRUNCATED_RUN = [
  'SUITE_START',
  `TEST_START: ${HOMINIS_DIR}/browser_hominis_first.js`,
  'TEST_END: Test OK',
  `TEST_START: ${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
  'Exiting due to channel error.',
  'Exiting due to channel error.',
  'Main app process: killed by SIGSEGV',
  'Buffered messages finished',
  'zombiecheck | Checking for orphan process with PID: 12345',
  'Browser Chrome Test Summary',
  '      Passed: 2',
  '      Failed: 0',
  '      Unexpected results: 0',
  'SUITE_END',
].join('\n');

// Truncation WITHOUT a crash marker: the second file started but the log
// ends (green-shaped summary included) with no end marker for it.
const TRUNCATED_NO_CRASH_RUN = [
  'SUITE_START',
  `TEST_START: ${HOMINIS_DIR}/browser_hominis_first.js`,
  'TEST_END: Test OK',
  `TEST_START: ${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
  'Browser Chrome Test Summary',
  '      Passed: 1',
  '      Failed: 0',
  '      Unexpected results: 0',
  'SUITE_END',
].join('\n');

// The genuine noise shape the lenient path was built for: every requested
// file start/end-paired, green summary, and mach exit 1 caused by a
// resource-monitor traceback after the suite finished.
const GREEN_PAIRED_WITH_MONITOR_NOISE = [
  'SUITE_START',
  `TEST_START: ${HOMINIS_DIR}/browser_hominis_first.js`,
  'TEST_END: Test OK',
  `TEST_START: ${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
  'TEST_END: Test OK',
  'Browser Chrome Test Summary',
  '      Passed: 2',
  '      Failed: 0',
  '      Unexpected results: 0',
  'SUITE_END',
  'Traceback (most recent call last):',
  '  File "mozlog/handlers/resource.py", line 23, in stop',
  "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
  'Error running mach',
].join('\n');

const TWO_HOMINIS_FILES = HOMINIS_FILES.slice(0, 2);

describe('green-summary rejection on crash/truncation evidence (0.35.0 field report)', () => {
  it('fails the SIGSEGV-truncated run despite the green summary, naming the signal and the never-started files', () => {
    const verdict = classifyHarnessRun(1, SIGSEGV_TRUNCATED_RUN, HOMINIS_FILES);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.greenSummaryOverride).toBeUndefined();
    expect(verdict.greenSummaryRejected?.crashLine).toContain('killed by SIGSEGV');
    expect(verdict.greenSummaryRejected?.neverStarted).toHaveLength(6);
    expect(verdict.greenSummaryRejected?.neverStarted).toContain(HOMINIS_FILES[2]);
    expect(verdict.greenSummaryRejected?.neverEnded).toEqual([
      `${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
    ]);
    const message = buildGreenSummaryRejectedMessage(
      verdict.greenSummaryRejected ?? { neverStarted: [], neverEnded: [] },
      1
    );
    expect(message).toContain('killed by SIGSEGV');
    expect(message).toContain(HOMINIS_FILES[2] ?? '');
    expect(message).toContain('NOT');
  });

  it('fails a started-but-never-ended run even without a crash marker', () => {
    const verdict = classifyHarnessRun(1, TRUNCATED_NO_CRASH_RUN, TWO_HOMINIS_FILES);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.greenSummaryRejected?.crashLine).toBeUndefined();
    expect(verdict.greenSummaryRejected?.neverEnded).toEqual([
      `${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
    ]);
  });

  it('keeps the lenient path for the genuine noise shape (paired files, green summary, monitor traceback exit)', () => {
    const verdict = classifyHarnessRun(1, GREEN_PAIRED_WITH_MONITOR_NOISE, TWO_HOMINIS_FILES);
    expect(verdict.kind).toBe('tests-ran-ok');
    expect(verdict.greenSummaryOverride).toBe(true);
    expect(verdict.greenSummaryRejected).toBeUndefined();
  });

  it('leaves mach exit 0 classification untouched', () => {
    expect(classifyHarnessRun(0, GREEN_PAIRED_WITH_MONITOR_NOISE, TWO_HOMINIS_FILES)).toEqual({
      kind: 'tests-ran-ok',
    });
    expect(classifyHarnessRun(0, GREEN_RUN, PATHS)).toEqual({ kind: 'tests-ran-ok' });
  });

  it('findCrashMarkerLine recognizes the mozcrash marker family', () => {
    expect(findCrashMarkerLine(SIGSEGV_TRUNCATED_RUN)).toContain('killed by SIGSEGV');
    expect(
      findCrashMarkerLine('PROCESS-CRASH | browser_foo.js | application crashed [@ mozalloc_abort]')
    ).toContain('PROCESS-CRASH');
    expect(findCrashMarkerLine('mozcrash INFO | Saved minidump as /tmp/x.dmp')).toContain(
      'minidump'
    );
    expect(findCrashMarkerLine('Thread 0 (crashed)')).toContain('crashed');
    expect(findCrashMarkerLine(GREEN_PAIRED_WITH_MONITOR_NOISE)).toBeUndefined();
  });

  it('a crash marker disqualifies the summary from "completed green"', () => {
    expect(hasCompletedGreenSummary(SIGSEGV_TRUNCATED_RUN)).toBe(false);
    expect(hasCompletedGreenSummary(GREEN_PAIRED_WITH_MONITOR_NOISE)).toBe(true);
  });

  it('analyzeTestCompleteness pairs starts/ends positionally and skips non-file requested paths', () => {
    const completeness = analyzeTestCompleteness(SIGSEGV_TRUNCATED_RUN, [
      ...HOMINIS_FILES,
      HOMINIS_DIR,
    ]);
    expect(completeness.neverStarted).toHaveLength(6);
    expect(completeness.neverStarted).not.toContain(HOMINIS_DIR);
    expect(completeness.neverEnded).toEqual([`${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`]);
    // The xpcshell dialect's unnamed `TEST_END: Test PASS` lines pair with
    // the preceding TEST_START even though they do not name the file.
    const balanced = analyzeTestCompleteness(GREEN_XPCSHELL_WITH_DEGRADATION_NOISE, [
      'test_one.js',
      'test_two.js',
    ]);
    expect(balanced.neverStarted).toEqual([]);
    expect(balanced.neverEnded).toEqual([]);
  });

  it('reports an unnamed open test when a start marker carries no path token', () => {
    const open = analyzeTestCompleteness('TEST_START\nno end follows', []);
    expect(open.neverEnded).toEqual(['(unnamed test)']);
  });

  it('builds the rejection message for each evidence shape independently', () => {
    // Truncation without a crash marker (never-ended only).
    const endedOnly = buildGreenSummaryRejectedMessage(
      { neverStarted: [], neverEnded: ['browser_a.js'] },
      1
    );
    expect(endedOnly).toContain('started but never finished: browser_a.js');
    expect(endedOnly).not.toContain('crash evidence');
    expect(endedOnly).not.toContain('never started');
    // Never-started only (e.g. the harness skipped a requested file).
    const startedOnly = buildGreenSummaryRejectedMessage(
      { neverStarted: ['browser_b.js'], neverEnded: [] },
      2
    );
    expect(startedOnly).toContain('mach exited 2');
    expect(startedOnly).toContain('never started: browser_b.js');
    expect(startedOnly).not.toContain('never finished');
  });
});

describe('messages', () => {
  it('builds a crash message naming the shape, evidence, and attempts', () => {
    const sig = detectHarnessCrashSignature(RESOURCE_MONITOR_TRACEBACK);
    if (!sig) throw new Error('expected signature');
    const message = buildHarnessCrashMessage(sig, 3);
    expect(message).toContain('all 3 attempt(s)');
    expect(message).toContain(sig.line);
    expect(message).toContain('--harness-retries');
  });

  it('builds a no-tests message that distrusts summary lines on exit 0', () => {
    const message = buildNoTestsRanMessage(0, PATHS);
    expect(message).toContain('summary without a single TEST-START');
    expect(message).toContain(PATHS[0] ?? '');
  });

  it('builds a no-tests message naming the exit code on non-zero exits', () => {
    const message = buildNoTestsRanMessage(1, PATHS);
    expect(message).toContain('exited 1 before any TEST-START');
  });
});
