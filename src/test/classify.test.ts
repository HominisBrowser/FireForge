// SPDX-License-Identifier: EUPL-1.2
/**
 * The classifier as input/output tables, over captured shapes of real
 * harness output: green runs, real failures, harness crashes, hangs, cut-off
 * suites, and the noise that must never decide a verdict.
 */
import { describe, expect, it } from 'vitest';

import { formatVerdict } from '../cli/output.js';
import {
  analyzeTestCompleteness,
  classifyHarnessRun,
  collectFailureBlocks,
  createMarkerTracker,
  detectCrashSignature,
  extractSummaryCounts,
  findCrashMarkerLine,
  type HarnessVerdict,
  hasCompletedGreenSummary,
  isSilentSegfault,
  judgeDispatch,
  type StartMarkers,
  stripNonSignalNoise,
  vetoIncompletePass,
} from './classify.js';
import { parseRawTestLog } from './rawLog.js';
import type { TestRunResult } from './run.js';
import { verdictFields } from './verdict.js';

/** The verdict line one dispatch with this verdict gives a run. */
function line(verdict: HarnessVerdict): string {
  const kind = verdict.kind;
  const reason =
    kind === 'pass'
      ? undefined
      : kind === 'crash'
        ? (verdict.signature?.verdictReason ?? 'crash')
        : kind;
  const result = {
    pass: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    plan: { repeat: 1, dispatches: [{ suite: 'mochitest', paths: [], restart: false }] },
    dispatches: [{ run: 1, index: 1, verdict }],
    reaped: 0,
    log: 'L',
  } as unknown as TestRunResult;
  const { pass, fields } = verdictFields(result);
  return formatVerdict(pass, { ...fields, log: undefined });
}

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
  ' 0:10.20 SUITE_END',
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

/** A passing single-file `mach xpcshell-test`: a result block, no TEST-START. */
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

describe('detectCrashSignature', () => {
  it.each([
    [
      'the resource-monitor startup traceback',
      RESOURCE_MONITOR_TRACEBACK,
      'startup traceback',
      'SystemResourceMonitor',
    ],
    ['the psutil/mig syscall traceback', MIG_TRACEBACK, 'startup traceback', 'host_statistics64'],
    [
      'the pre-test hang despite a Passed: 0 summary',
      HANG_WITH_FALSE_SUMMARY,
      'no-output timeout',
      'timed out',
    ],
    [
      'the post-green shutdown re-entry',
      POST_GREEN_SHUTDOWN_REENTRY,
      'shutdown re-entry',
      'shut down',
    ],
  ])('recognizes %s', (_name, output, reason, evidence) => {
    const signature = detectCrashSignature(output);
    expect(signature?.reason).toContain(reason);
    expect(signature?.line).toContain(evidence);
  });

  it.each([
    ['a green run', GREEN_RUN],
    ['a real failure', REAL_FAILURE_RUN],
    [
      'a real failure with an incidental teardown traceback',
      `${REAL_FAILURE_RUN}\n${RESOURCE_MONITOR_TRACEBACK}`,
    ],
    [
      'a shutdown re-entry beside a real failure',
      `${POST_GREEN_SHUTDOWN_REENTRY}\n 0:52.00 ERROR TEST-UNEXPECTED-FAIL | browser_foo.js | real assertion broke`,
    ],
  ])('does not call %s a crash', (_name, output) => {
    expect(detectCrashSignature(output)).toBeUndefined();
  });

  it('reads a configured failure pattern before any test as a crash', () => {
    const output = 'BrandBrowserUnavailableError: the window never opened\nPassed: 0';
    expect(detectCrashSignature(output, [/BrandBrowserUnavailableError/])).toMatchObject({
      line: 'BrandBrowserUnavailableError: the window never opened',
    });
    expect(detectCrashSignature(output)).toBeUndefined();
    expect(
      detectCrashSignature(`${GREEN_RUN}\n${output}`, [/BrandBrowserUnavailableError/])
    ).toBeUndefined();
  });
});

describe('classifyHarnessRun', () => {
  it('classifies green runs and real failures', () => {
    expect(classifyHarnessRun(0, GREEN_RUN, PATHS).kind).toBe('pass');
    expect(classifyHarnessRun(1, REAL_FAILURE_RUN, PATHS).kind).toBe('test-failures');
  });

  it('keeps the first real failure when harness noise is also present', () => {
    const verdict = classifyHarnessRun(
      1,
      `${REAL_FAILURE_RUN}\n${RESOURCE_MONITOR_TRACEBACK}`,
      PATHS
    );
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.failureLine).toContain('TEST-UNEXPECTED-FAIL');
    expect(verdict.secondary?.reason).toContain('harness traceback');
  });

  it('reads crash signatures as crashes whatever the exit code', () => {
    expect(classifyHarnessRun(1, RESOURCE_MONITOR_TRACEBACK, PATHS).kind).toBe('crash');
    expect(classifyHarnessRun(0, HANG_WITH_FALSE_SUMMARY, PATHS).kind).toBe('crash');
    expect(classifyHarnessRun(1, POST_GREEN_SHUTDOWN_REENTRY, PATHS).kind).toBe('crash');
    expect(line(classifyHarnessRun(0, HANG_WITH_FALSE_SUMMARY, PATHS))).toMatch(
      /^FIREFORGE-VERDICT: FAIL reason=crash/
    );
  });

  it('reads a bare summary without a start as no-tests, even on exit 0', () => {
    const summaryOnly = ' 0:10.01 INFO Passed: 0\n 0:10.01 INFO Failed: 0';
    expect(classifyHarnessRun(0, summaryOnly, PATHS).kind).toBe('no-tests');
    expect(classifyHarnessRun(0, 'Passed: 0', []).kind).toBe('no-tests');
  });

  it('passes a green xpcshell summary that has no TEST-START', () => {
    const verdict = classifyHarnessRun(0, XPCSHELL_PASS_RUN, [
      'toolkit/components/foo/test/unit/test_settings.js',
    ]);
    expect(verdict).toMatchObject({ kind: 'pass', checks: 16, unexpected: 0 });
    expect(line(verdict)).toBe('FIREFORGE-VERDICT: PASS checks=16 unexpected=0');
  });

  it('fails a failing xpcshell summary', () => {
    expect(
      classifyHarnessRun(1, XPCSHELL_FAIL_RUN, [
        'toolkit/components/foo/test/unit/test_settings.js',
      ]).kind
    ).toBe('test-failures');
  });
});

describe('extractSummaryCounts', () => {
  it('reads checks and unexpected; the last summary wins; absent keys stay absent', () => {
    expect(extractSummaryCounts(XPCSHELL_PASS_RUN)).toEqual({ checks: 16, unexpected: 0 });
    expect(
      extractSummaryCounts(
        ['Ran 4 checks', 'Unexpected results: 2', 'Ran 16 checks', 'Unexpected results: 0'].join(
          '\n'
        )
      )
    ).toEqual({ checks: 16, unexpected: 0 });
    expect(extractSummaryCounts(GREEN_RUN)).toEqual({});
  });
});

/**
 * A completed xpcshell suite whose output carries the resource-monitor
 * degradation chatter and a caught telemetry traceback.
 */
const GREEN_XPCSHELL_WITH_NOISE = [
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

const XPCSHELL_DIR = ['toolkit/components/foo/test/unit'];

describe('the green-summary veto and noise', () => {
  it('passes a completed green suite with degradation noise, overruling a non-zero exit', () => {
    expect(detectCrashSignature(GREEN_XPCSHELL_WITH_NOISE)).toBeUndefined();
    expect(classifyHarnessRun(0, GREEN_XPCSHELL_WITH_NOISE, XPCSHELL_DIR).kind).toBe('pass');
    const overruled = classifyHarnessRun(1, GREEN_XPCSHELL_WITH_NOISE, XPCSHELL_DIR);
    expect(overruled).toMatchObject({ kind: 'pass', greenSummaryOverride: true });
    expect(line(overruled)).toContain('PASS note=exit-noise-ignored');
  });

  it('does not overrule a non-zero exit when the summary reports unexpected results', () => {
    const red = GREEN_XPCSHELL_WITH_NOISE.replace('Unexpected results: 0', 'Unexpected results: 2');
    expect(classifyHarnessRun(1, red, XPCSHELL_DIR).kind).toBe('test-failures');
  });

  it('never reads warnings and caught telemetry tracebacks as a crash', () => {
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
    expect(detectCrashSignature(noiseOnly)).toBeUndefined();
  });

  it('strips noise from crash evidence but keeps a real traceback', () => {
    expect(stripNonSignalNoise(RESOURCE_MONITOR_TRACEBACK)).toContain(
      "no attribute 'poll_interval'"
    );
    const stripped = stripNonSignalNoise(GREEN_XPCSHELL_WITH_NOISE);
    expect(stripped).not.toContain('UserWarning');
    expect(stripped).not.toContain('telemetry');
    expect(stripped).not.toContain('_collect failed');
  });

  it('requires an execution signal, a green count and SUITE_END for a completed summary', () => {
    expect(hasCompletedGreenSummary(GREEN_XPCSHELL_WITH_NOISE)).toBe(true);
    expect(hasCompletedGreenSummary(GREEN_XPCSHELL_WITH_NOISE.replace(/SUITE_END/g, ''))).toBe(
      false
    );
    expect(
      hasCompletedGreenSummary(
        GREEN_XPCSHELL_WITH_NOISE.replace('Unexpected results: 0', 'Unexpected results: 3')
      )
    ).toBe(false);
    expect(hasCompletedGreenSummary('Unexpected results: 0\nSUITE_END')).toBe(false);
  });
});

describe('the _DegradedReading fallback crashes', () => {
  const SUBSCRIPT = [
    ' 0:00.81 INFO Checking for orphan ssltunnel processes...',
    'Traceback (most recent call last):',
    '  File "mozsystemmonitor/resourcemonitor.py", line 12, in _build_meta',
    '    "system_memory": psutil.virtual_memory()[0],',
    "TypeError: '_DegradedReading' object is not subscriptable",
    'Error running mach',
  ].join('\n');
  const ITERABLE = [
    ' 0:00.81 INFO Checking for orphan ssltunnel processes...',
    " 0:00.92 WARNING _collect failed: '_DegradedReading' object is not iterable",
    'Error running mach',
  ].join('\n');

  it('reads both startup aborts as crashes', () => {
    expect(detectCrashSignature(SUBSCRIPT)?.line).toContain('not subscriptable');
    expect(classifyHarnessRun(1, SUBSCRIPT, PATHS).kind).toBe('crash');
    expect(detectCrashSignature(ITERABLE)).toMatchObject({
      reason: expect.stringContaining('_DegradedReading') as string,
      line: expect.stringContaining('not iterable') as string,
    });
    expect(classifyHarnessRun(1, ITERABLE, PATHS).kind).toBe('crash');
  });

  it('keeps the _DegradedReading line as evidence while plain _collect chatter goes', () => {
    const stripped = stripNonSignalNoise(
      [
        " 0:00.92 WARNING _collect failed: '_DegradedReading' object is not iterable",
        ' 0:00.93 WARNING _collect failed: poll_interval unavailable on degraded monitor',
      ].join('\n')
    );
    expect(stripped).toContain('not iterable');
    expect(stripped).not.toContain('poll_interval unavailable');
  });

  it('passes a completed green run that carries such a line', () => {
    const output = `${ITERABLE.split('\n')[1] ?? ''}\n${GREEN_XPCSHELL_WITH_NOISE}`;
    expect(detectCrashSignature(output)).toBeUndefined();
    expect(classifyHarnessRun(0, output, XPCSHELL_DIR).kind).toBe('pass');
  });
});

describe('drain-loop warnings and the post-success log_resource_usage crash', () => {
  const DRAIN = [
    ' 0:41.02 resourcemonitor.py:766: UserWarning: failed to read the received data: (0, 0, 0.0, 0, 0, 0, 0, 0)',
    ' 0:51.10 WARNING failed to read the received data: (0, 0, 0.0, -12, 0, 34, 0, 0)',
  ].join('\n');
  const READ_BYTES = [
    ' 46:12.44 Your build was successful!',
    'Traceback (most recent call last):',
    '  File "mozbuild/controller/building.py", line 526, in log_resource_usage',
    '    "io_read_bytes": usage["io"].read_bytes,',
    "AttributeError: 'NoneType' object has no attribute 'read_bytes'",
    'Error running mach',
  ].join('\n');

  it('strips the drain-loop warning, with or without its UserWarning token', () => {
    expect(stripNonSignalNoise(DRAIN)).not.toContain('failed to read the received data');
    expect(classifyHarnessRun(0, `${DRAIN}\n${GREEN_XPCSHELL_WITH_NOISE}`, XPCSHELL_DIR).kind).toBe(
      'pass'
    );
  });

  it('reads the read_bytes AttributeError as a crash unless real failures exist', () => {
    expect(detectCrashSignature(READ_BYTES)).toMatchObject({
      reason: expect.stringContaining('resource monitor') as string,
      line: expect.stringContaining('read_bytes') as string,
    });
    expect(classifyHarnessRun(1, READ_BYTES, []).kind).toBe('crash');
    expect(classifyHarnessRun(1, `${REAL_FAILURE_RUN}\n${READ_BYTES}`, PATHS).kind).toBe(
      'test-failures'
    );
  });
});

/** A manifest of eight files whose browser died of SIGSEGV at the second file. */
const DIR = 'browser/base/content/test/fork';
const FILES = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'].map(
  (name) => `${DIR}/browser_fork_${name}.js`
);
const SIGSEGV_TRUNCATED = [
  'SUITE_START',
  `TEST_START: ${DIR}/browser_fork_first.js`,
  'TEST_END: Test OK',
  `TEST_START: ${DIR}/browser_fork_second.js`,
  'Exiting due to channel error.',
  'Main app process: killed by SIGSEGV',
  'Buffered messages finished',
  'Browser Chrome Test Summary',
  '      Passed: 2',
  '      Failed: 0',
  '      Unexpected results: 0',
  'SUITE_END',
].join('\n');
const MONITOR_TEARDOWN_TAIL = [
  'Traceback (most recent call last):',
  '  File "mozlog/handlers/resource.py", line 58, in stop',
  '  File "mozsystemmonitor/resourcemonitor.py", line 321, in stop',
  "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
  'During handling of the above exception, another exception occurred:',
  'Traceback (most recent call last):',
  '  File "psutil/_psosx.py", line 351, in virtual_memory',
  'host_statistics64(HOST_VM_INFO64) syscall failed: (ipc/mig) array not large enough',
  'Error running mach',
].join('\n');
const TRUNCATED_WITHOUT_CRASH = [
  'SUITE_START',
  `TEST_START: ${DIR}/browser_fork_first.js`,
  'TEST_END: Test OK',
  `TEST_START: ${DIR}/browser_fork_second.js`,
  'Browser Chrome Test Summary',
  '      Passed: 1',
  '      Failed: 0',
  '      Unexpected results: 0',
  'SUITE_END',
].join('\n');
const GREEN_PAIRED_WITH_NOISE = [
  'SUITE_START',
  `TEST_START: ${DIR}/browser_fork_first.js`,
  'TEST_END: Test OK',
  `TEST_START: ${DIR}/browser_fork_second.js`,
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

describe('a green summary is refused on crash or truncation evidence', () => {
  it.each([
    ['alone', SIGSEGV_TRUNCATED],
    ['with resource-monitor teardown noise', `${SIGSEGV_TRUNCATED}\n${MONITOR_TEARDOWN_TAIL}`],
  ])('fails the SIGSEGV-cut run %s, naming the signal and the files', (_name, output) => {
    expect(detectCrashSignature(output)).toBeUndefined();
    const verdict = classifyHarnessRun(1, output, FILES);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.greenSummaryOverride).toBeUndefined();
    expect(verdict.greenSummaryRejected?.crashLine).toContain('killed by SIGSEGV');
    expect(verdict.greenSummaryRejected?.neverStarted).toHaveLength(6);
    expect(verdict.greenSummaryRejected?.neverStarted).toContain(FILES[2]);
    expect(verdict.greenSummaryRejected?.neverEnded).toEqual([FILES[1]]);
  });

  it('fails a started, never-ended file without a crash marker', () => {
    const verdict = classifyHarnessRun(1, TRUNCATED_WITHOUT_CRASH, FILES.slice(0, 2));
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.greenSummaryRejected?.crashLine).toBeUndefined();
    expect(verdict.greenSummaryRejected?.neverEnded).toEqual([FILES[1]]);
  });

  it('passes the genuine noise shape: every file paired, green summary, a monitor traceback owning the exit', () => {
    const verdict = classifyHarnessRun(1, GREEN_PAIRED_WITH_NOISE, FILES.slice(0, 2));
    expect(verdict).toMatchObject({ kind: 'pass', greenSummaryOverride: true });
    expect(verdict.greenSummaryRejected).toBeUndefined();
    expect(classifyHarnessRun(0, GREEN_PAIRED_WITH_NOISE, FILES.slice(0, 2))).toEqual({
      kind: 'pass',
      unexpected: 0,
    });
    expect(classifyHarnessRun(0, GREEN_RUN, PATHS)).toEqual({ kind: 'pass' });
  });

  it('recognizes the mozcrash marker family', () => {
    expect(findCrashMarkerLine(SIGSEGV_TRUNCATED)).toContain('killed by SIGSEGV');
    expect(
      findCrashMarkerLine('PROCESS-CRASH | browser_foo.js | application crashed [@ mozalloc_abort]')
    ).toContain('PROCESS-CRASH');
    expect(findCrashMarkerLine('mozcrash INFO | Saved minidump as /tmp/x.dmp')).toContain(
      'minidump'
    );
    expect(findCrashMarkerLine('Thread 0 (crashed)')).toContain('crashed');
    expect(findCrashMarkerLine(GREEN_PAIRED_WITH_NOISE)).toBeUndefined();
    expect(hasCompletedGreenSummary(SIGSEGV_TRUNCATED)).toBe(false);
    expect(hasCompletedGreenSummary(GREEN_PAIRED_WITH_NOISE)).toBe(true);
  });
});

describe('analyzeTestCompleteness', () => {
  it('pairs starts and ends by position and skips requests that name no test file', () => {
    const completeness = analyzeTestCompleteness(SIGSEGV_TRUNCATED, [...FILES, DIR]);
    expect(completeness.neverStarted).toHaveLength(6);
    expect(completeness.neverStarted).not.toContain(DIR);
    expect(completeness.neverEnded).toEqual([FILES[1]]);
    expect(
      analyzeTestCompleteness(GREEN_XPCSHELL_WITH_NOISE, ['test_one.js', 'test_two.js'])
    ).toEqual({
      neverStarted: [],
      neverEnded: [],
    });
  });

  it('names an open start that carries no path', () => {
    expect(analyzeTestCompleteness('TEST_START\nno end follows', []).neverEnded).toEqual([
      '(unnamed test)',
    ]);
  });
});

describe('collectFailureBlocks', () => {
  const CHROME_FAILURE = [
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

  it('keeps each unexpected line with its assertion context', () => {
    const blocks = collectFailureBlocks(CHROME_FAILURE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('Assert.equal - got false, expected true');
    expect(blocks[0]).toContain('Got false');
    expect(blocks[0]).toContain('Stack trace:');
    expect(blocks[1]).toContain('Expected ["a","b"]');
    const verdict = classifyHarnessRun(1, CHROME_FAILURE, PATHS);
    expect(verdict.failureBlocks?.[0]).toContain('Got false');
    expect(classifyHarnessRun(0, GREEN_RUN, PATHS).failureBlocks).toBeUndefined();
  });

  it('caps the blocks, leaves out the shutdown artifact, and stops at a non-context line', () => {
    const many = Array.from(
      { length: 7 },
      (_, i) => ` 0:09.${i} INFO TEST-UNEXPECTED-FAIL | browser_x.js | failure ${i}`
    ).join('\n');
    const capped = collectFailureBlocks(many, 5);
    expect(capped).toHaveLength(6);
    expect(capped[5]).toBe('…(+2 more TEST-UNEXPECTED lines not shown)');
    expect(collectFailureBlocks(POST_GREEN_SHUTDOWN_REENTRY)).toHaveLength(0);
    const stopped = collectFailureBlocks(
      [
        'TEST-UNEXPECTED-FAIL | browser_x.js | boom',
        'Got 1',
        ' 0:10.01 INFO TEST-OK | browser_y.js',
      ].join('\n')
    );
    expect(stopped[0]).not.toContain('TEST-OK');
  });
});

describe('silent SIGSEGV', () => {
  it('recognizes a harness that died of SIGSEGV printing nothing, in both exit shapes', () => {
    expect(isSilentSegfault(-11, '')).toBe(true);
    expect(isSilentSegfault(139, '   \n  ')).toBe(true);
  });

  it('does not claim a run that printed evidence, or another signal', () => {
    const printed = [
      'TEST_START: browser/base/test_a.js',
      'TEST-UNEXPECTED-FAIL | test_a.js | boom',
      'Main app process: killed by SIGSEGV',
    ].join('\n');
    expect(isSilentSegfault(-11, printed)).toBe(false);
    expect(isSilentSegfault(1, '')).toBe(false);
    expect(isSilentSegfault(-9, '')).toBe(false);
  });
});

describe('known teardown noise on a clean suite', () => {
  const TEARDOWN = [
    'Traceback (most recent call last):',
    '  File "/x/mozsystemmonitor/resourcemonitor.py", line 442, in __exit__',
    '    self.stop()',
    '  File "/x/mozsystemmonitor/resourcemonitor.py", line 460, in stop',
    '    duration = self.stop_time - self.start_time',
    "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
  ].join('\n');
  const A = 'browser/base/content/test/test_a.js';
  const SUITE = [
    'TEST_START: browser/base/content/test/test_a.js',
    'TEST_END: Test PASS',
    'Ran 894 checks (894 subtests, 0 errors)',
    'Unexpected results: 0',
    'OK',
  ].join('\n');

  it('passes a clean suite whose only residue is the recognized teardown noise', () => {
    const verdict = classifyHarnessRun(1, `${SUITE}\n${TEARDOWN}`, [A]);
    expect(verdict).toMatchObject({ kind: 'pass', note: 'teardown-noise-ignored' });
    expect(line(verdict)).toBe(
      'FIREFORGE-VERDICT: PASS note=teardown-noise-ignored checks=894 unexpected=0'
    );
  });

  it.each([
    [
      'a real unexpected line',
      `${SUITE}\nTEST-UNEXPECTED-FAIL | test_a.js | boom\n${TEARDOWN}`,
      [A],
    ],
    ['a crash marker', `${SUITE}\nMain app process: killed by SIGSEGV\n${TEARDOWN}`, [A]],
    [
      'a requested file that never started',
      `${SUITE}\n${TEARDOWN}`,
      [A, 'browser/base/content/test/test_never_ran.js'],
    ],
    [
      'an unrecognized attribute',
      `${SUITE}\n${TEARDOWN.replace("'stop_time'", "'brand_new_attribute'")}`,
      [A],
    ],
    [
      'a summary with no zero unexpected count',
      `TEST_START: ${A}\nTEST_END: Test PASS\n${TEARDOWN}`,
      [A],
    ],
    [
      'a Gecko assertion failure',
      `${SUITE}\nAssertion failure: !mDestroyed, at /x/nsDocShell.cpp:1234\n${TEARDOWN}`,
      [A],
    ],
    [
      'a Gecko ASSERTION',
      `${SUITE}\n###!!! ASSERTION: bad state: 'mState == eIdle', file nsFoo.cpp, line 99\n${TEARDOWN}`,
      [A],
    ],
  ])('still fails with %s', (_name: string, output: string, paths: string[]) => {
    expect(classifyHarnessRun(1, output, paths).kind).not.toBe('pass');
  });

  it.each([
    [
      'the word "assertion" in a passing diagnostic',
      'If an assertion below times out, this is why: the guard is armed.',
    ],
    ['a non-vacuousness note', 'TEST-PASS | test_a.js | the assertion above is not vacuous'],
    [
      'TEST-KNOWN-FAIL, an expected failure',
      'TEST-KNOWN-FAIL | test_a.js | known to fail on macOS',
    ],
  ])('passes despite %s', (_name, extra) => {
    expect(classifyHarnessRun(1, `${SUITE}\n${extra}\n${TEARDOWN}`, [A]).kind).toBe('pass');
  });

  describe('names the condition that rejected the override', () => {
    it.each([
      [`Unexpected results: 3\n${SUITE}\n${TEARDOWN}`, [A], 'non-zero "Unexpected results:"'],
      [`Failed: 2\n${SUITE}\n${TEARDOWN}`, [A], 'non-zero "Failed:"'],
      [`${SUITE}\nTEST-UNEXPECTED-FAIL | ${A} | boom\n${TEARDOWN}`, [A], 'matched failure line'],
      [
        `${SUITE}\n${TEARDOWN}`,
        [A, 'browser/base/content/test/test_missing.js'],
        'never started: browser/base/content/test/test_missing.js',
      ],
      [
        `TEST_START: a.js\nTEST_END: Test PASS\nUnexpected results: 0\n${TEARDOWN}`,
        [],
        'no "Ran N checks" line',
      ],
      [
        `TEST_START: a.js\nTEST_END: Test PASS\nRan 5 checks\nUnexpected results: 2\n${TEARDOWN}`,
        [],
        'summary reported unexpected=2',
      ],
      [
        `TEST_START: a.js\nTEST_END: Test PASS\nRan 5 checks\n${TEARDOWN}`,
        [],
        'no "Unexpected results:" line',
      ],
      [TEARDOWN, [], 'no execution signal'],
    ])('%#', (output, paths, reason) => {
      const verdict = classifyHarnessRun(1, output, paths);
      expect(verdict.kind).not.toBe('pass');
      expect(verdict.note).toContain('green-teardown override rejected');
      expect(verdict.note).toContain(reason);
    });

    it('says nothing when the run carried no recognized teardown noise', () => {
      const verdict = classifyHarnessRun(1, `${SUITE}\nTEST-UNEXPECTED-FAIL | ${A} | boom`, [A]);
      expect(verdict.note ?? '').not.toContain('green-teardown override rejected');
    });
  });
});

describe('failure evidence without a harness marker', () => {
  it('says when a red rests on evidence with no TEST-UNEXPECTED marker', () => {
    const output = [
      'TEST_START: browser/base/content/test/test_a.js',
      'Assertion failure: !mDestroyed, at /x/nsDocShell.cpp:1234',
      'Ran 12 checks (12 subtests, 0 errors)',
      'Unexpected results: 0',
    ].join('\n');
    const verdict = classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.note).toBe(
      'summary reported 0 unexpected; no TEST-UNEXPECTED marker in the matched evidence'
    );
    expect(line(verdict)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=test-failures checks=12 unexpected=0'
    );
  });

  it('adds no note when a TEST-UNEXPECTED marker is present', () => {
    const output = [
      'TEST_START: browser/base/content/test/test_a.js',
      'TEST-UNEXPECTED-FAIL | test_a.js | boom',
      'Ran 12 checks (12 subtests, 0 errors)',
      'Unexpected results: 1',
    ].join('\n');
    expect(
      classifyHarnessRun(1, output, ['browser/base/content/test/test_a.js']).note
    ).toBeUndefined();
  });

  it('keeps a concrete assertion red without the generic summary, on exit 0', () => {
    const verdict = classifyHarnessRun(0, REAL_FAILURE_RUN, PATHS);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.failureLine).toContain('TEST-UNEXPECTED-FAIL');
  });

  it.each([
    'PROCESS-CRASH | browser/components/foo/test/browser_foo.js | application crashed',
    'Crash dump filename: owned.dmp',
    'Unexpected results: 1\nUnexpected results: 0',
    'Failed: 1\nFailed: 0',
    'Failed: 01\nUnexpected results: 0',
  ])('does not let a later green summary erase %s', (evidence) => {
    const output = `${GREEN_RUN}\n${evidence}\nSUITE_END\nUnexpected results: 0`;
    expect(classifyHarnessRun(0, output, PATHS).kind).toBe('test-failures');
    expect(classifyHarnessRun(1, output, PATHS).kind).toBe('test-failures');
  });
});

describe('server-startup failures', () => {
  const SERVER_STARTUP = [
    ' 0:01.10 INFO runtests.py | Server pid: 4242',
    '!!! could not start server on port 8888: [Exception... "Component returned failure code"]',
    ' 0:46.12 ERROR TEST-UNEXPECTED-FAIL | runtests.py | Timed out while waiting for server startup.',
  ].join('\n');

  it('reads a server that never came up as infrastructure, not no-tests', () => {
    const verdict = classifyHarnessRun(1, SERVER_STARTUP, PATHS);
    expect(verdict.kind).toBe('crash');
    expect(verdict.signature).toMatchObject({
      verdictReason: 'server-startup',
      line: expect.stringContaining('could not start server on port 8888') as string,
    });
    expect(line(verdict)).toBe('FIREFORGE-VERDICT: FAIL reason=server-startup');
    const timeoutOnly =
      ' 0:46.12 ERROR TEST-UNEXPECTED-FAIL | runtests.py | Timed out while waiting for server startup.';
    expect(classifyHarnessRun(1, timeoutOnly, PATHS).signature?.verdictReason).toBe(
      'server-startup'
    );
  });

  it('leaves a run whose tests started to the regular chain', () => {
    const started = `${SERVER_STARTUP}\n 0:50.00 INFO TEST-START | ${PATHS[0] ?? ''}`;
    expect(classifyHarnessRun(1, started, PATHS).signature?.verdictReason).toBeUndefined();
  });
});

describe('a green summary never speaks for what happened after it', () => {
  const SUITE = [
    'TEST_START: dir/a/browser_a.js',
    'TEST_END: Test PASS',
    'Ran 3 checks',
    'Unexpected results: 0',
    'SUITE_END',
    '',
  ].join('\n');

  it.each([
    ['SIGKILL after the suite, directory request', 137, ['dir/']],
    ['SIGSEGV after the suite, manifest request', 139, ['dir/browser.toml']],
    ['a negated signal number, file request', -9, ['dir/a/browser_a.js']],
  ])('%s fails', (_name, exitCode, paths) => {
    const verdict = classifyHarnessRun(exitCode, SUITE, paths);
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.greenSummaryRejected?.exitEvidence).toContain('signal');
    expect(line(vetoIncompletePass(verdict, SUITE, paths, { started: [], skipped: [] }))).toContain(
      'FAIL reason=test-failures'
    );
  });

  it('fails on an unexplained traceback after the last suite', () => {
    const output = `${SUITE}Traceback (most recent call last):\n  File "runxpcshelltests.py", line 9, in x\nKeyError: foo\n`;
    expect(classifyHarnessRun(1, output, ['dir/']).greenSummaryRejected?.exitEvidence).toContain(
      'KeyError: foo'
    );
  });

  it.each([
    ['a directory request', ['dir/']],
    ['a path-less request', []],
    ['a file request whose files all finished', ['dir/a/browser_a.js']],
  ])('fails %s whose non-zero exit nothing explains', (_name, paths) => {
    expect(classifyHarnessRun(1, SUITE, paths).greenSummaryRejected?.exitEvidence).toContain(
      'no recognized noise'
    );
  });

  it.each([9, 15])('reads exit %i as a relayed kill, whatever noise the log holds', (exitCode) => {
    expect(
      classifyHarnessRun(exitCode, `UserWarning: psutil failed to run\n${SUITE}`, ['dir/'])
        .greenSummaryRejected?.exitEvidence
    ).toContain('signal');
  });

  it.each([
    [
      'a caught telemetry traceback',
      `${SUITE}Traceback (most recent call last):\n  File "mach/telemetry.py", line 661, in submit\nConnectionError: glean upload failed\n`,
    ],
    [
      'a recognized read_bytes traceback',
      `${SUITE}Traceback (most recent call last):\n  File "x.py", line 1\nAttributeError: 'NoneType' object has no attribute 'read_bytes'\n`,
    ],
    ['degradation chatter', `UserWarning: psutil failed to run\n${SUITE}`],
  ])('keeps the override when %s owns the exit', (_name, output) => {
    expect(classifyHarnessRun(1, output, ['dir/'])).toMatchObject({
      kind: 'pass',
      greenSummaryOverride: true,
    });
  });
});

describe('a startup timeout names the harness lines before it', () => {
  it('carries port and browser-wait lines', () => {
    const output = [
      'Falling back to port 8889 (server)',
      'Waiting for browser...',
      'timed out after 370 seconds with no output',
    ].join('\n');
    expect(classifyHarnessRun(1, output, ['dir/browser_a.js']).signature?.harnessLines).toEqual([
      'Falling back to port 8889 (server)',
      'Waiting for browser...',
    ]);
    expect(
      classifyHarnessRun(1, 'timed out after 370 seconds with no output\n', ['dir/browser_a.js'])
        .signature?.harnessLines
    ).toBeUndefined();
  });
});

describe('a summary that counted zero checks is not a run', () => {
  it('reads the no-output hang as a crash however the harness exited', () => {
    const hang =
      'timed out after 370 seconds with no output\nRan 0 checks\nUnexpected results: 0\nSUITE_END\n';
    for (const exitCode of [0, 1]) {
      expect(classifyHarnessRun(exitCode, hang, ['dir/browser_a.js']).signature?.reason).toBe(
        'no-output timeout before any test started'
      );
    }
  });

  it.each([
    ['a directory', ['dir/'], 'Ran 0 checks\nUnexpected results: 0\nSUITE_END\n'],
    ['a file', ['dir/browser_a.js'], 'Ran 0 checks\nUnexpected results: 0\nSUITE_END\n'],
    [
      'printed starts',
      ['dir/browser_a.js'],
      'TEST_START: dir/browser_a.js\nRan 0 checks\nUnexpected results: 0\nSUITE_END\n',
    ],
  ])('gives no-tests for %s on exit 0', (_name, paths, output) => {
    const verdict = classifyHarnessRun(0, output, paths);
    expect(verdict.kind).toBe('no-tests');
    expect(line(verdict)).toContain('FAIL reason=no-tests checks=0');
  });

  it('leaves a real failure with its own diagnosis', () => {
    const output =
      'TEST-START | dir/browser_a.js\nTEST-UNEXPECTED-FAIL | dir/browser_a.js | boom\nRan 0 checks\nSUITE_END\n';
    expect(classifyHarnessRun(1, output, ['dir/browser_a.js']).kind).toBe('test-failures');
  });
});

/** Excerpts of retained runs, as the harness printed them. */
const REAL_BROWSER_RUN = (file: string): string =>
  [
    ' 0:00.24 SUITE_START: mochitest-browser - running 1 tests',
    ` 0:02.43 TEST_START: ${file}`,
    ' 0:02.84 TEST_END: Test PASS. Subtests passed 7/8. Unexpected 0',
    ' 0:53.27 INFO TEST-START | Shutdown',
    ' 0:53.27 INFO Passed:  1178',
    ' 0:53.27 INFO Failed:  0',
    ' 0:53.27 INFO Todo:    2',
    '*** End BrowserChrome Test Results ***',
    '\tPassed: 1178',
    '\tFailed: 0',
    ' 0:53.58 INFO Buffered messages finished',
    ' 0:53.58 SUITE_END',
    'Overall Summary',
    '===============',
    'mochitest-browser',
    'Ran 1216 checks (1178 subtests, 38 tests)',
    'Expected results: 1216',
    'Unexpected results: 0',
    'OK',
  ].join('\n');

const REAL_XPCSHELL_RUN = (files: readonly string[]): string =>
  [
    ` 0:00.65 SUITE_START: xpcshell - running ${files.length} tests`,
    ...files.map((file) => ` 0:00.65 TEST_START: ${file}`),
    ...files.map(() => ' 0:01.21 TEST_END: PASS'),
    ' 0:16.61 INFO INFO | Result summary:',
    ` 0:16.61 INFO INFO | Passed: ${files.length}`,
    ' 0:16.61 INFO INFO | Failed: 0',
    ' 0:16.61 SUITE_END',
    'xpcshell',
    `Ran ${files.length} checks (${files.length} tests)`,
    'Unexpected results: 0',
    'OK',
  ].join('\n');

describe('real-shaped runs stay green', () => {
  const A = 'browser/x/test/browser_a.js';
  const judged = (
    exitCode: number,
    output: string,
    paths: readonly string[],
    streamed?: StartMarkers
  ): string =>
    line(vetoIncompletePass(classifyHarnessRun(exitCode, output, paths), output, paths, streamed));

  it('passes a browser run whose closing Shutdown start has no end', () => {
    expect(judged(0, REAL_BROWSER_RUN(A), [A])).toContain('PASS checks=1216 unexpected=0');
    expect(judged(0, REAL_BROWSER_RUN(A), ['browser/x/test'])).toContain('PASS');
    expect(analyzeTestCompleteness(REAL_BROWSER_RUN(A), [A]).neverEnded).toEqual([]);
  });

  it('passes a parallel xpcshell run whose starts all precede its ends', () => {
    expect(judged(0, REAL_XPCSHELL_RUN(['a/test_a.js', 'a/test_b.js']), ['a'])).toContain(
      'PASS checks=2 unexpected=0'
    );
  });

  it('passes a run whose file the manifest skipped', () => {
    const skipped = REAL_BROWSER_RUN(A).replace(
      ' 0:02.84 TEST_END: Test PASS. Subtests passed 7/8. Unexpected 0',
      ' 0:02.84 TEST_END: SKIP (skip-if: headless)'
    );
    expect(judged(0, skipped, [A])).toContain('PASS');
  });

  it('keeps the verdict from a capture that lost the start of a long log', () => {
    const tail = REAL_BROWSER_RUN(A).split('\n').slice(3).join('\n');
    expect(judged(0, tail, [A], { started: [A], skipped: [] })).toContain('PASS');
  });

  it('keeps the override for each observed noise shape at exit 1', () => {
    for (const noise of [
      "AttributeError: 'NoneType' object has no attribute 'read_bytes'",
      'UserWarning: psutil failed to run: host_statistics64(HOST_VM_INFO64) syscall failed',
      ' 0:00.50 WARNING _collect failed: poll_interval unavailable on degraded monitor',
      '[FireForge] FireForge: host resource monitor degraded',
      'failed to read the received data',
    ]) {
      expect(judged(1, `${REAL_XPCSHELL_RUN(['a/test_a.js'])}\n${noise}`, ['a'])).toContain('PASS');
    }
  });

  it('accepts an instance prefix on harness lines', () => {
    const prefixed = REAL_BROWSER_RUN(A)
      .split('\n')
      .map((entry) => `[job 1] ${entry}`)
      .join('\n');
    expect(judged(0, prefixed, [A])).toContain('PASS checks=1216');
  });
});

describe('a long run whose capture kept only the tail', () => {
  const A = 'browser/x/test/browser_a.js';
  const B = 'browser/x/test/browser_b.js';
  const TAIL = `TEST_START: ${B}\nTEST_END: Test PASS\nRan 9 checks\nUnexpected results: 0\nSUITE_END\nUserWarning: psutil failed to run`;

  it('keeps the noise override for a file only the stream saw start, and names one it did not', () => {
    expect(classifyHarnessRun(1, TAIL, [A, B], { started: [A, B] })).toMatchObject({
      kind: 'pass',
      greenSummaryOverride: true,
    });
    expect(
      classifyHarnessRun(1, TAIL, [A, B], { started: [B] }).greenSummaryRejected?.neverStarted
    ).toEqual([A]);
  });
});

describe('an exit-0 run must show a complete run', () => {
  const A = 'browser/x/test/browser_a.js';
  const B = 'browser/x/test/browser_b.js';
  const SUMMARY = 'Ran 2 checks\nUnexpected results: 0\nSUITE_END';
  const streamed = (exitCode: number, output: string, paths: readonly string[]): string => {
    const tracker = createMarkerTracker();
    for (const entry of output.split('\n')) tracker.line(entry);
    return line(judgeDispatch(exitCode, output, paths, { streamed: tracker.markers() }));
  };
  const withRaw = (
    output: string,
    paths: readonly string[],
    records: readonly object[]
  ): string => {
    const raw = parseRawTestLog(records.map((record) => JSON.stringify(record)).join('\n'));
    return line(judgeDispatch(0, output, paths, { raw }));
  };
  const OPEN = { action: 'suite_start', tests: {} };
  const CLOSE = { action: 'suite_end' };
  const started = (test: string): object => ({ action: 'test_start', test });
  const ended = (test: string, status = 'OK'): object => ({ action: 'test_end', test, status });

  it.each([
    ['a test started and the log ends there', `TEST_START: ${A}`, [A], 'crash'],
    [
      'b started and never ended',
      `TEST_START: ${A}\nTEST_END: Test OK\nTEST_START: ${B}\n${SUMMARY}`,
      [A, B],
      'test-failures',
    ],
    [
      'another file ran',
      `TEST_START: browser/x/test/browser_other.js\nTEST_END: Test OK\n${SUMMARY}`,
      [A],
      'test-failures',
    ],
    ['TEST_END is all the output holds', 'TEST_END: Test OK', [A], 'crash'],
    [
      'a mochitest summary that counted zero',
      `TEST-START | ${A}\nPassed: 0\nFailed: 0`,
      [A],
      'no-tests',
    ],
    [
      'a test printed b as started',
      `TEST_START: ${A}\nconsole.log: TEST_START: ${B}\nTEST_END: Test OK\n${SUMMARY}`,
      [A, B],
      'test-failures',
    ],
    [
      'a test printed a skip line for b',
      `TEST_START: ${A}\n 0:01.00 GECKO(12) TEST-SKIP | ${B}\nTEST_END: Test OK\n${SUMMARY}`,
      [A, B],
      'test-failures',
    ],
  ])('fails when %s', (_name, output, paths, reason) => {
    expect(streamed(0, output, paths)).toContain(`FAIL reason=${reason}`);
  });

  it('names the file a test printed as started, because it never ran', () => {
    expect(
      streamed(
        0,
        `TEST_START: ${A}\nconsole.log: TEST_START: ${B}\nTEST_END: Test OK\n${SUMMARY}`,
        [A, B]
      )
    ).toContain(`first-unstarted=${B}`);
  });

  it('reads no failure from a test that prints failure-shaped text, and no summary from one that prints a summary', () => {
    expect(
      streamed(
        0,
        `TEST_START: ${A}\n 0:01.00 console.log: Failed: 2\nconsole.log: Unexpected results: 3\nTEST_END: Test OK\n${SUMMARY}`,
        [A]
      )
    ).toContain('PASS checks=2 unexpected=0');
    expect(
      streamed(
        0,
        `TEST_START: ${A}\nconsole.log: Ran 5 checks\nconsole.log: Unexpected results: 0\nconsole.log: SUITE_END`,
        [A]
      )
    ).toContain('FAIL reason=crash');
  });

  it.each([
    [
      'b started and never ended',
      [A, B],
      [OPEN, started(A), ended(A), started(B), CLOSE],
      'unfinished=1',
    ],
    [
      'a status failed under a green text summary',
      [A],
      [
        OPEN,
        started(A),
        { action: 'test_status', test: A, subtest: 's', status: 'FAIL', expected: 'PASS' },
        ended(A),
        CLOSE,
      ],
      'unexpected=1',
    ],
    [
      'the file ended unexpectedly',
      [A],
      [OPEN, started(A), { ...ended(A, 'TIMEOUT'), expected: 'PASS' }, CLOSE],
      'unexpected=1',
    ],
    ['another file ran', [A], [OPEN, started(B), ended(B), CLOSE], `first-unstarted=${A}`],
    [
      'a directory ran nothing under it',
      ['browser/y/test'],
      [OPEN, started(A), ended(A), CLOSE],
      'first-unstarted=browser/y/test',
    ],
    ['the suite never closed', [A], [OPEN, started(A), ended(A)], 'reason=crash'],
    ['it recorded nothing', [A], [], `first-unstarted=${A}`],
  ])('with a raw log, fails when %s, whatever the text says', (_name, paths, records, marker) => {
    const verdict = withRaw(`TEST_START: ${A}\nTEST_END: Test OK\n${SUMMARY}`, paths, records);
    expect(verdict).toContain('FAIL');
    expect(verdict).toContain(marker);
  });

  it('with a raw log, passes a complete run whatever the text kept', () => {
    const records = [
      OPEN,
      started(A),
      ended(A),
      started(B),
      { ...ended(B), status: 'SKIP' },
      CLOSE,
    ];
    for (const paths of [[A, B], ['browser/x/test'], ['browser/x/test/browser.toml'], []]) {
      expect(withRaw('', paths, records)).toContain('PASS');
    }
  });

  it('with a raw log, does not count a known intermittent as unexpected', () => {
    const records = [
      OPEN,
      started(A),
      {
        action: 'test_status',
        test: A,
        subtest: 's',
        status: 'FAIL',
        expected: 'PASS',
        known_intermittent: ['FAIL'],
      },
      ended(A),
      CLOSE,
    ];
    expect(withRaw('', [A], records)).toContain('PASS');
  });

  it('turns a would-be pass whose raw log recorded nothing into no-tests', () => {
    expect(withRaw(`TEST_START: ${A}\nTEST_END: Test OK\n${SUMMARY}`, [], [OPEN, CLOSE])).toContain(
      'FAIL reason=no-tests'
    );
  });
});
