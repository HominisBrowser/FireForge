// SPDX-License-Identifier: EUPL-1.2
/**
 * Classifier tests for the field-observed harness flake shapes (C1/C2),
 * driven by simulated mach output fixtures — no live Firefox checkout.
 */
import { describe, expect, it } from 'vitest';

import {
  buildHarnessCrashMessage,
  buildNoTestsRanMessage,
  classifyHarnessRun,
  detectHarnessCrashSignature,
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
});
