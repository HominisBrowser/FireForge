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
  buildSilentSegfaultMessage,
  classifyHarnessRun,
  collectUnexpectedFailureBlocks,
  detectHarnessCrashSignature,
  extractSummaryCounts,
  findCrashMarkerLine,
  formatFireforgeVerdictLine,
  hasCompletedGreenSummary,
  headedDisplayAsleepVerdictNote,
  headedNoOutputTimeoutHint,
  isSilentSegfault,
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
// TEST-START-only execution heuristic mis-reads this green run as no-tests,
// appends "finished without starting any tests", and exits 1. Strings mirror
// the runxpcshelltests output; no live build.
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

  it('keeps first real failure evidence when harness traceback noise is also present', () => {
    const verdict = classifyHarnessRun(
      1,
      `${REAL_FAILURE_RUN}\n${RESOURCE_MONITOR_TRACEBACK}`,
      PATHS
    );
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.realFailureLine).toContain('TEST-UNEXPECTED-FAIL');
    expect(verdict.secondaryHarnessSignature?.reason).toContain('harness traceback');
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

// A completed multi-file xpcshell suite whose output ALSO carries the
// non-fatal resource-monitor degradation warnings and a caught telemetry
// traceback. The embedded summary is green (Unexpected results: 0,
// SUITE_END), yet the signature strings (psutil, _collect) match the
// startup-traceback cluster — without the green-summary veto every such
// suite classifies CRASH.
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

describe('extractSummaryCounts', () => {
  it('parses checks and unexpected from an xpcshell result summary', () => {
    expect(extractSummaryCounts(XPCSHELL_PASS_RUN)).toEqual({ checks: 16, unexpected: 0 });
  });

  it('last summary wins when a multi-suite run prints several', () => {
    const multi = [
      'Ran 4 checks',
      'Unexpected results: 2',
      'Ran 16 checks',
      'Unexpected results: 0',
    ].join('\n');
    expect(extractSummaryCounts(multi)).toEqual({ checks: 16, unexpected: 0 });
  });

  it('omits both keys when no summary printed them', () => {
    expect(extractSummaryCounts(GREEN_RUN)).toEqual({});
  });

  it('classifyHarnessRun carries the parsed counts on its verdict', () => {
    const verdict = classifyHarnessRun(0, XPCSHELL_PASS_RUN, [
      'toolkit/components/foo/test/unit/test_settings.js',
    ]);
    expect(verdict.kind).toBe('tests-ran-ok');
    expect(verdict.checks).toBe(16);
    expect(verdict.unexpected).toBe(0);
  });
});

describe('formatFireforgeVerdictLine', () => {
  it('formats a pass with counts', () => {
    expect(formatFireforgeVerdictLine({ kind: 'tests-ran-ok', checks: 16, unexpected: 0 })).toBe(
      'FIREFORGE-VERDICT: PASS checks=16 unexpected=0'
    );
  });

  it('formats a pass without counts (keys omitted, never zeroed)', () => {
    expect(formatFireforgeVerdictLine({ kind: 'tests-ran-ok' })).toBe('FIREFORGE-VERDICT: PASS');
  });

  it('a greenSummaryOverride pass still says PASS (verdict over exit code)', () => {
    expect(
      formatFireforgeVerdictLine({ kind: 'tests-ran-ok', greenSummaryOverride: true, checks: 16 })
    ).toBe('FIREFORGE-VERDICT: PASS checks=16');
  });

  it('a crash-classified run says FAIL reason=crash even when the summary looks green at exit 0', () => {
    const verdict = classifyHarnessRun(0, HANG_WITH_FALSE_SUMMARY, PATHS);
    expect(verdict.kind).toBe('harness-crash');
    expect(formatFireforgeVerdictLine(verdict)).toMatch(/^FIREFORGE-VERDICT: FAIL reason=crash/);
  });

  it('maps no-tests and test-failures reasons', () => {
    expect(formatFireforgeVerdictLine({ kind: 'no-tests' })).toBe(
      'FIREFORGE-VERDICT: FAIL reason=no-tests'
    );
    expect(formatFireforgeVerdictLine({ kind: 'test-failures', unexpected: 3 })).toBe(
      'FIREFORGE-VERDICT: FAIL reason=test-failures unexpected=3'
    );
  });

  it('a rejected green summary formats as test-failures', () => {
    expect(
      formatFireforgeVerdictLine({
        kind: 'test-failures',
        greenSummaryRejected: { neverStarted: [], neverEnded: ['a.js'] },
      })
    ).toBe('FIREFORGE-VERDICT: FAIL reason=test-failures');
  });
});

describe('green-summary veto and noise exclusion', () => {
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

// A degraded psutil fallback that only survives attribute access makes
// mozsystemmonitor crash on the fallback itself, in two shapes, both
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

describe('_DegradedReading fallback crash signatures', () => {
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

// Degraded-host drain-loop noise plus a post-success log_resource_usage
// crash: on a flapping host, mozsystemmonitor's parent rejects malformed
// collector samples ("failed to read the received data") — chatter on runs
// that then complete — and mozbuild's log_resource_usage can die on
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

describe('degraded-host drain-loop and log_resource_usage shapes', () => {
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

// Crash green-wash: a browser-chrome manifest of 8 files whose parent
// process SIGSEGVed at the second file's TEST_START. The remaining six
// never started, so the embedded summary is "green" (`Passed: 2 / Failed:
// 0, Unexpected results: 0`) only because the crash prevented them from
// producing any results — and an unguarded green-summary override reports
// the mach-exit-1 run as PASSED.
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

const SIGSEGV_TRUNCATED_RUN_WITH_MONITOR_TRACEBACK = [
  SIGSEGV_TRUNCATED_RUN,
  'Traceback (most recent call last):',
  '  File "mozlog/handlers/resource.py", line 58, in stop',
  '    self.resourcemonitor.stop()',
  '  File "mozsystemmonitor/resourcemonitor.py", line 321, in stop',
  '    self._process.send((self.stop_time, psutil.virtual_memory()))',
  "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
  'During handling of the above exception, another exception occurred:',
  'Traceback (most recent call last):',
  '  File "psutil/_psosx.py", line 351, in virtual_memory',
  'host_statistics64(HOST_VM_INFO64) syscall failed: (ipc/mig) array not large enough',
  'Error running mach',
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

describe('green-summary rejection on crash/truncation evidence', () => {
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

  it('lets a hard SIGSEGV outrank co-occurring resource-monitor teardown noise', () => {
    expect(
      detectHarnessCrashSignature(SIGSEGV_TRUNCATED_RUN_WITH_MONITOR_TRACEBACK)
    ).toBeUndefined();

    const verdict = classifyHarnessRun(
      1,
      SIGSEGV_TRUNCATED_RUN_WITH_MONITOR_TRACEBACK,
      HOMINIS_FILES
    );
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.signature).toBeUndefined();
    expect(verdict.greenSummaryOverride).toBeUndefined();
    expect(verdict.greenSummaryRejected?.crashLine).toContain('killed by SIGSEGV');
    expect(verdict.greenSummaryRejected?.neverStarted).toHaveLength(6);
    expect(verdict.greenSummaryRejected?.neverStarted).toContain(HOMINIS_FILES[2]);
    expect(verdict.greenSummaryRejected?.neverEnded).toEqual([
      `${HOMINIS_DIR}/browser_hominis_cui_telemetry.js`,
    ]);
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
    // `unexpected` rides along since I5 — the fixture's summary prints it.
    expect(classifyHarnessRun(0, GREEN_PAIRED_WITH_MONITOR_NOISE, TWO_HOMINIS_FILES)).toEqual({
      kind: 'tests-ran-ok',
      unexpected: 0,
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

describe('collectUnexpectedFailureBlocks', () => {
  // Chrome-suite shape: the TEST-UNEXPECTED line is followed by the Assert
  // diff the operator needs to diagnose a non-reproducing one-off.
  const CHROME_FAILURE_RUN = [
    ' 0:05.12 INFO TEST-START | browser/components/foo/test/browser_x.js',
    ' 0:09.44 INFO TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_x.js | Assert.equal - got false, expected true',
    'Got false',
    'Expected true',
    'Stack trace:',
    '    chrome://mochikit/content/browser-test.js:test_ok:1370',
    ' 0:09.50 INFO TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_x.js | Tile order mismatch',
    'Got ["b","a"]',
    'Expected ["a","b"]',
    ' 0:10.01 INFO Failed: 1',
    ' 0:10.01 INFO Unexpected results: 1',
    ' 0:10.02 INFO SUITE_END',
  ].join('\n');

  it('returns each TEST-UNEXPECTED line verbatim with its assertion context', () => {
    const blocks = collectUnexpectedFailureBlocks(CHROME_FAILURE_RUN);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain(
      'TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_x.js | Assert.equal - got false, expected true'
    );
    expect(blocks[0]).toContain('Got false');
    expect(blocks[0]).toContain('Expected true');
    expect(blocks[0]).toContain('Stack trace:');
    expect(blocks[1]).toContain('Tile order mismatch');
    expect(blocks[1]).toContain('Expected ["a","b"]');
  });

  it('caps at the limit and appends a truncation note', () => {
    const many = Array.from(
      { length: 7 },
      (_, i) => ` 0:09.${String(i)} INFO TEST-UNEXPECTED-FAIL | browser_x.js | failure ${String(i)}`
    ).join('\n');
    const blocks = collectUnexpectedFailureBlocks(many, 5);
    expect(blocks).toHaveLength(6);
    expect(blocks[5]).toBe('…(+2 more TEST-UNEXPECTED lines not shown)');
  });

  it('excludes the shutdown-reentry artifact line', () => {
    const blocks = collectUnexpectedFailureBlocks(POST_GREEN_SHUTDOWN_REENTRY);
    expect(blocks).toHaveLength(0);
  });

  it('stops context collection at the next non-context line', () => {
    const run = [
      'TEST-UNEXPECTED-FAIL | browser_x.js | boom',
      'Got 1',
      ' 0:10.01 INFO TEST-OK | browser_y.js',
    ].join('\n');
    const blocks = collectUnexpectedFailureBlocks(run);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain('TEST-OK');
  });

  it('classifyHarnessRun carries the blocks on test-failure verdicts', () => {
    const verdict = classifyHarnessRun(1, CHROME_FAILURE_RUN, PATHS);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.realFailureBlocks).toBeDefined();
    expect(verdict.realFailureBlocks?.[0]).toContain('Assert.equal - got false, expected true');
    expect(verdict.realFailureBlocks?.[0]).toContain('Got false');
  });

  it('classifyHarnessRun omits the field on green runs', () => {
    const verdict = classifyHarnessRun(0, GREEN_RUN, PATHS);
    expect(verdict.realFailureBlocks).toBeUndefined();
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

describe('silent SIGSEGV diagnosis', () => {
  it('recognizes a signal-killed harness that printed nothing, in both exit-code shapes', () => {
    expect(isSilentSegfault(-11, '')).toBe(true);
    expect(isSilentSegfault(139, '   \n  ')).toBe(true);
  });

  it('does not claim the shape when the run actually printed something', () => {
    const realOutput = [
      'TEST_START: browser/base/test_a.js',
      'TEST-UNEXPECTED-FAIL | test_a.js | boom',
      'Ran 12 checks',
      'Unexpected results: 1',
      'SUITE_END',
      'Main app process: killed by SIGSEGV',
    ].join('\n');
    expect(isSilentSegfault(-11, realOutput)).toBe(false);
  });

  it('does not claim the shape for a non-SIGSEGV exit', () => {
    expect(isSilentSegfault(1, '')).toBe(false);
    expect(isSilentSegfault(-9, '')).toBe(false);
  });

  it('names moz.build registration as the first thing to check', () => {
    const message = buildSilentSegfaultMessage(-11, ['browser/base/test_a.js']);
    expect(message).toContain('EXTRA_JS_MODULES');
    expect(message).toContain('check this FIRST');
    // The recurring shape — an import added to an EXISTING module — is
    // called out explicitly, because the new-file lint cannot see it.
    expect(message).toContain('added to an EXISTING module');
    expect(message).toContain('fireforge verify');
    expect(message).toContain('browser/base/test_a.js');
  });
});

describe('known teardown noise on a clean suite', () => {
  const TEARDOWN_TRACEBACK = [
    'Traceback (most recent call last):',
    '  File "/x/mozsystemmonitor/resourcemonitor.py", line 442, in __exit__',
    '    self.stop()',
    '  File "/x/mozsystemmonitor/resourcemonitor.py", line 460, in stop',
    '    duration = self.stop_time - self.start_time',
    "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
  ].join('\n');

  /** A substantively green xpcshell suite, with no SUITE_END marker. */
  const greenSuiteWithoutSuiteEnd = [
    'TEST_START: browser/base/content/test/test_a.js',
    'TEST_END: Test PASS',
    'Ran 894 checks (894 subtests, 0 errors)',
    'Unexpected results: 0',
    'OK',
  ].join('\n');

  it('passes a clean suite whose only residue is the recognized teardown noise', () => {
    const verdict = classifyHarnessRun(1, `${greenSuiteWithoutSuiteEnd}\n${TEARDOWN_TRACEBACK}`, [
      'browser/base/content/test/test_a.js',
    ]);
    expect(verdict.kind).toBe('tests-ran-ok');
    expect(verdict.note).toBe('harness teardown noise ignored');
    expect(formatFireforgeVerdictLine(verdict)).toBe(
      'FIREFORGE-VERDICT: PASS checks=894 unexpected=0 (harness teardown noise ignored)'
    );
  });

  it('still fails the same suite when a real unexpected line is present', () => {
    const output = [
      greenSuiteWithoutSuiteEnd,
      'TEST-UNEXPECTED-FAIL | test_a.js | boom',
      TEARDOWN_TRACEBACK,
    ].join('\n');
    expect(classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).kind).not.toBe(
      'tests-ran-ok'
    );
  });

  it('still fails the same suite when a crash marker is present', () => {
    const output = [
      greenSuiteWithoutSuiteEnd,
      'Main app process: killed by SIGSEGV',
      TEARDOWN_TRACEBACK,
    ].join('\n');
    expect(classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).kind).not.toBe(
      'tests-ran-ok'
    );
  });

  it('still fails when a requested test file never started', () => {
    const output = `${greenSuiteWithoutSuiteEnd}\n${TEARDOWN_TRACEBACK}`;
    expect(
      classifyHarnessRun(1, output, [
        'browser/base/content/test/test_a.js',
        'browser/base/content/test/test_never_ran.js',
      ]).kind
    ).not.toBe('tests-ran-ok');
  });

  it('does not forgive an UNRECOGNIZED teardown traceback', () => {
    const novel = TEARDOWN_TRACEBACK.replace(
      "no attribute 'stop_time'",
      "no attribute 'brand_new_attribute'"
    );
    expect(
      classifyHarnessRun(1, `${greenSuiteWithoutSuiteEnd}\n${novel}`, [
        'browser/base/content/test/test_a.js',
      ]).kind
    ).not.toBe('tests-ran-ok');
  });

  // Every belt condition is all-or-nothing, so a rejected run's verdict is
  // identical whichever one rejected it. A downstream report hit exactly
  // this: recognized teardown noise, zero unexpected, and a FAIL nobody
  // could diagnose from outside — the re-run was green and the log was
  // gone. The verdict line now names the rejecting condition.
  describe('rejection reasons', () => {
    it('names a real failure line as the rejecting condition', () => {
      const output = [
        greenSuiteWithoutSuiteEnd,
        'TEST-UNEXPECTED-FAIL | browser/base/content/test/test_a.js | boom',
        TEARDOWN_TRACEBACK,
      ].join('\n');
      const verdict = classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']);
      expect(verdict.kind).not.toBe('tests-ran-ok');
      expect(verdict.note).toContain('green-teardown override rejected');
      expect(verdict.note).toContain('matched failure line');
    });

    it('names a never-started requested file as the rejecting condition', () => {
      const verdict = classifyHarnessRun(1, `${greenSuiteWithoutSuiteEnd}\n${TEARDOWN_TRACEBACK}`, [
        'browser/base/content/test/test_a.js',
        'browser/base/content/test/test_missing.js',
      ]);
      expect(verdict.kind).not.toBe('tests-ran-ok');
      expect(verdict.note).toContain('never started');
      expect(verdict.note).toContain('test_missing.js');
    });

    it('names a missing "Ran N checks" line', () => {
      const verdict = classifyHarnessRun(
        1,
        [
          'TEST_START: a.js',
          'TEST_END: Test PASS',
          'Unexpected results: 0',
          TEARDOWN_TRACEBACK,
        ].join('\n'),
        []
      );
      expect(verdict.note).toContain('no "Ran N checks" line');
    });

    it('names a non-zero unexpected count from the summary', () => {
      const verdict = classifyHarnessRun(
        1,
        [
          'TEST_START: a.js',
          'TEST_END: Test PASS',
          'Ran 5 checks',
          'Unexpected results: 2',
          TEARDOWN_TRACEBACK,
        ].join('\n'),
        []
      );
      expect(verdict.note).toContain('summary reported unexpected=2');
    });

    it('names a missing "Unexpected results:" line', () => {
      const verdict = classifyHarnessRun(
        1,
        ['TEST_START: a.js', 'TEST_END: Test PASS', 'Ran 5 checks', TEARDOWN_TRACEBACK].join('\n'),
        []
      );
      expect(verdict.note).toContain('no "Unexpected results:" line');
    });

    it('names a missing execution signal', () => {
      const verdict = classifyHarnessRun(1, TEARDOWN_TRACEBACK, []);
      expect(verdict.note).toContain('no execution signal');
    });

    // A run with no recognized teardown noise was never a candidate for the
    // belt; naming a "rejecting condition" for it would be pure noise.
    it('says nothing when the run carried no recognized teardown noise', () => {
      const verdict = classifyHarnessRun(
        1,
        [
          greenSuiteWithoutSuiteEnd,
          'TEST-UNEXPECTED-FAIL | browser/base/content/test/test_a.js | boom',
        ].join('\n'),
        ['browser/base/content/test/test_a.js']
      );
      expect(verdict.note ?? '').not.toContain('green-teardown override rejected');
    });
  });

  it('passes a green suite whose diagnostic contains the ordinary word "assertion"', () => {
    // Regression: the assertion arm used to be a case-INSENSITIVE word match,
    // so a test's own passing diagnostic manufactured a red run and the
    // verdict then named that diagnostic as the first real test failure.
    const output = [
      'TEST_START: browser/base/content/test/test_a.js',
      'If an assertion below times out, this is why: the delivery guard is armed.',
      'TEST_END: Test PASS',
      'Ran 894 checks (894 subtests, 0 errors)',
      'Unexpected results: 0',
      'OK',
      TEARDOWN_TRACEBACK,
    ].join('\n');
    const verdict = classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']);
    expect(verdict.kind).toBe('tests-ran-ok');
    expect(verdict.note).toBe('harness teardown noise ignored');
  });

  it('passes a green suite carrying a non-vacuousness note that says "assertion"', () => {
    const output = [
      greenSuiteWithoutSuiteEnd,
      'TEST-PASS | test_a.js | the assertion above is not vacuous',
      TEARDOWN_TRACEBACK,
    ].join('\n');
    expect(classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).kind).toBe(
      'tests-ran-ok'
    );
  });

  it('still fails on a REAL Gecko assertion failure', () => {
    for (const line of [
      'Assertion failure: !mDestroyed, at /x/nsDocShell.cpp:1234',
      "###!!! ASSERTION: bad state: 'mState == eIdle', file nsFoo.cpp, line 99",
    ]) {
      const output = [greenSuiteWithoutSuiteEnd, line, TEARDOWN_TRACEBACK].join('\n');
      expect(classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).kind).not.toBe(
        'tests-ran-ok'
      );
    }
  });

  it('does not count TEST-KNOWN-FAIL, an EXPECTED failure, as a real failure', () => {
    const output = [
      greenSuiteWithoutSuiteEnd,
      'TEST-KNOWN-FAIL | test_a.js | known to fail on macOS',
      TEARDOWN_TRACEBACK,
    ].join('\n');
    expect(classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).kind).toBe(
      'tests-ran-ok'
    );
  });

  it('does not forgive a suite whose summary never printed a zero unexpected count', () => {
    const noSummary = [
      'TEST_START: browser/base/content/test/test_a.js',
      'TEST_END: Test PASS',
    ].join('\n');
    expect(
      classifyHarnessRun(1, `${noSummary}\n${TEARDOWN_TRACEBACK}`, [
        'browser/base/content/test/test_a.js',
      ]).kind
    ).not.toBe('tests-ran-ok');
  });
});

describe('unmarked failure evidence note', () => {
  it('says so when a test-failures verdict rests on evidence with no TEST-UNEXPECTED marker', () => {
    // `unexpected=0` beside `reason=test-failures` is the tell that the
    // classification rests on pattern matching rather than a harness result.
    const output = [
      'TEST_START: browser/base/content/test/test_a.js',
      'Assertion failure: !mDestroyed, at /x/nsDocShell.cpp:1234',
      'Ran 12 checks (12 subtests, 0 errors)',
      'Unexpected results: 0',
    ].join('\n');
    const verdict = classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']);
    expect(verdict.kind).toBe('test-failures');
    expect(formatFireforgeVerdictLine(verdict)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=test-failures checks=12 unexpected=0 ' +
        '(summary reported 0 unexpected; no TEST-UNEXPECTED marker in the matched evidence)'
    );
  });

  it('adds no note when a TEST-UNEXPECTED marker is present', () => {
    const output = [
      'TEST_START: browser/base/content/test/test_a.js',
      'TEST-UNEXPECTED-FAIL | test_a.js | boom',
      'Ran 12 checks (12 subtests, 0 errors)',
      'Unexpected results: 1',
    ].join('\n');
    expect(classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).note).toBe(
      undefined
    );
  });
});

describe('headedNoOutputTimeoutHint', () => {
  const timeoutSignature = {
    reason: 'no-output timeout before any test started',
    line: 'Timed out after 370 seconds with no output',
  };

  it('prints the three-cause triage list for a headed no-output timeout on darwin', () => {
    const hint = headedNoOutputTimeoutHint(timeoutSignature, {
      headless: false,
      platform: 'darwin',
    });
    // Recommending `caffeinate` is wrong for this shape: it PREVENTS sleep
    // and cannot WAKE an already-sleeping display. The hint says so and
    // lists all three known causes.
    expect(hint).toContain('sleeping or locked display');
    expect(hint).toContain('SWGL compositor');
    expect(hint).toContain('chrome://');
    expect(hint).toContain('cannot WAKE a display that is already asleep');
  });

  // The control test is the correct opening move for ALL three causes, so
  // it belongs above the list. While it lived inside cause 3, reaching
  // cause 3 told the operator nothing they did not already have.
  it('hoists the known-good control step above the cause list', () => {
    const hint = headedNoOutputTimeoutHint(timeoutSignature, {
      headless: false,
      platform: 'darwin',
    });
    expect(hint).toContain('run a known-good control test');
    expect(hint?.indexOf('known-good control')).toBeLessThan(
      hint?.indexOf('Known causes of this exact signature') ?? -1
    );
  });

  // Cause 3 is now root-caused: `CheckForBrokenChromeURL` is a printf
  // outside automation and a MOZ_CRASH under it. The census must name the
  // mechanism — but must NOT restore the discredited first-paint story
  // that an earlier revision wrote on top of the correlation.
  it('states cause 3 as the root-caused CheckForBrokenChromeURL mechanism', () => {
    const hint = headedNoOutputTimeoutHint(timeoutSignature, {
      headless: false,
      platform: 'darwin',
    });
    expect(hint).toContain('CheckForBrokenChromeURL');
    expect(hint).toContain('MOZ_CRASH');
    // The discredited mechanism claim must not come back.
    expect(hint).not.toContain('stalls first paint');
  });

  // Under automation the crash lands in the process that died, not in the
  // log, so the census must name the crash-report artefact alongside the
  // smoke probe — pointing only at the log teaches operators to conclude
  // "nothing here" from a log that structurally cannot carry the evidence.
  it('names both the crash-report artefact and the smoke probe for cause 3', () => {
    const hint = headedNoOutputTimeoutHint(timeoutSignature, {
      headless: false,
      platform: 'darwin',
    });
    expect(hint).toContain('DiagnosticReports');
    expect(hint).toContain('fireforge run --smoke-exit');
    expect(hint).toContain('OUTSIDE automation');
  });

  it('states a MEASURED asleep display as fact', () => {
    const hint = headedNoOutputTimeoutHint(timeoutSignature, {
      headless: false,
      platform: 'darwin',
      displayState: 'asleep',
    });
    expect(hint).toContain('MEASURED ASLEEP');
    expect(hint).toContain('environmental');
  });

  it('rules the sleeping display out when it was measured awake', () => {
    const hint = headedNoOutputTimeoutHint(timeoutSignature, {
      headless: false,
      platform: 'darwin',
      displayState: 'awake',
    });
    expect(hint).toContain('measured AWAKE');
    expect(hint).toContain('ruled out');
  });

  it('notes a measured-asleep headed stall on the verdict line', () => {
    expect(
      headedDisplayAsleepVerdictNote(timeoutSignature, {
        headless: false,
        platform: 'darwin',
        displayState: 'asleep',
      })
    ).toBe('headed run stalled with the display asleep');
    // Never asserted without a measurement, and never for other shapes.
    expect(
      headedDisplayAsleepVerdictNote(timeoutSignature, {
        headless: false,
        platform: 'darwin',
        displayState: 'unknown',
      })
    ).toBeUndefined();
    expect(
      headedDisplayAsleepVerdictNote(
        { reason: 'resource monitor traceback', line: 'Traceback' },
        { headless: false, platform: 'darwin', displayState: 'asleep' }
      )
    ).toBeUndefined();
    expect(
      headedDisplayAsleepVerdictNote(timeoutSignature, {
        headless: true,
        platform: 'darwin',
        displayState: 'asleep',
      })
    ).toBeUndefined();
  });

  it('returns undefined for headless runs', () => {
    expect(
      headedNoOutputTimeoutHint(timeoutSignature, { headless: true, platform: 'darwin' })
    ).toBeUndefined();
  });

  it('returns undefined off macOS', () => {
    expect(
      headedNoOutputTimeoutHint(timeoutSignature, { headless: false, platform: 'linux' })
    ).toBeUndefined();
  });

  it('returns undefined for non-timeout crash shapes', () => {
    expect(
      headedNoOutputTimeoutHint(
        { reason: 'resource monitor traceback', line: 'Traceback' },
        { headless: false, platform: 'darwin' }
      )
    ).toBeUndefined();
  });
});
