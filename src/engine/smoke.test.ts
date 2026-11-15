// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import {
  compileAllowlist,
  createSmokeScan,
  isBrowserLine,
  isLaunchLine,
  isSmokeError,
  parseAllowlistFile,
  smokeFailure,
  type SmokeReport,
} from './smoke.js';

describe('smoke error lines', () => {
  it.each([
    ['JavaScript error: chrome://browser/content/browser.js, line 1: TypeError: x', true],
    ['  console.error: "boom"', true],
    ['[JavaScript Error] "x" {file: "y" line: 1}', true],
    ['[JavaScript Warning] "x"', true],
    ['###!!! [Parent][MessageChannel] Error: closed', true],
    ['Missing chrome or resource URL: chrome://browser/skin/x.css', true],
    ['Missing chrome or resource URLs: chrome://browser/skin/x.css', true],
    ['console.warn: RSLoader: something', false],
    ['pending JavaScript error: cleanup', false],
    ['###!!! [Child] Error', false],
    ['', false],
  ])('%j → %s', (line, expected) => {
    expect(isSmokeError(line)).toBe(expected);
  });

  it('tells the browser output from mach log lines', () => {
    expect(isBrowserLine(' 0:00.42 /obj/dist/bin/firefox -profile /tmp/p')).toBe(false);
    expect(isBrowserLine('   ')).toBe(false);
    expect(isBrowserLine('console.log: started')).toBe(true);
  });

  it.each([
    '/opt/mach/pip.py:12: DeprecationWarning: imp is deprecated',
    'UserWarning: psutil failed to run',
    'Traceback (most recent call last):',
    '  File "/opt/mach/x.py", line 4, in <module>',
  ])("does not take the launcher's %j for the browser", (line) => {
    expect(isBrowserLine(line)).toBe(false);
  });

  it('finds the line mach logs as it starts the browser', () => {
    expect(isLaunchLine(' 0:00.42 /obj/dist/bin/firefox -profile /tmp/p')).toBe(true);
    expect(isLaunchLine(' 0:00.42 C:\\obj\\dist\\bin\\fork.exe -no-remote -profile C:\\t')).toBe(
      true
    );
    expect(isLaunchLine(' 0:00.42 Reading build config for -profile support')).toBe(false);
    expect(isLaunchLine('/obj/dist/bin/firefox -profile /tmp/p')).toBe(false);
  });
});

describe('the allowlist', () => {
  it('compiles command-line patterns with their position as origin', () => {
    const [first, second] = compileAllowlist(['^a', 'b$']);
    expect(first).toMatchObject({ source: '^a', origin: '--console-allow #1' });
    expect(second?.pattern.test('ab')).toBe(true);
    expect(() => compileAllowlist(['('])).toThrow(/--console-allow #1/);
  });

  it('parses a file, with a max-hits cap on the entry that follows the directive', () => {
    const entries = parseAllowlistFile(
      '# header\n\n# max-hits: 2\n# why\nconsole\\.error: known\r\nJavaScript error: other\n',
      'allow.txt'
    );
    expect(entries.map(({ source, origin, maxHits }) => ({ source, origin, maxHits }))).toEqual([
      { source: 'console\\.error: known', origin: 'allow.txt:5', maxHits: 2 },
      { source: 'JavaScript error: other', origin: 'allow.txt:6', maxHits: undefined },
    ]);
  });

  it('refuses a bad pattern, a bad cap, and a cap nothing follows', () => {
    expect(() => parseAllowlistFile('(\n', 'a.txt')).toThrow(/a\.txt:1/);
    expect(() => parseAllowlistFile('# max-hits: 0\nx\n', 'a.txt')).toThrow(/positive integer/);
    expect(() => parseAllowlistFile('# max-hits: 2\n\nx\n', 'a.txt')).toThrow(/a\.txt:1/);
    expect(() => parseAllowlistFile('x\n# max-hits: 2\n', 'a.txt')).toThrow(/not followed/);
  });
});

describe('a smoke scan', () => {
  it('counts unallowed errors, allowed errors, and credits the first matching entry', () => {
    const allow = [
      ...compileAllowlist(['RSLoader', 'known']),
      ...parseAllowlistFile('# max-hits: 1\nflood\n', 'f'),
    ];
    const scan = createSmokeScan(allow);
    for (const line of [
      ' 0:00.10 /obj/dist/bin/firefox -profile x',
      'console.warn: RSLoader: fine',
      'console.error: known RSLoader issue',
      'JavaScript error: real, line 1',
      'console.log: flood',
      'console.log: flood',
    ]) {
      scan.line(line);
    }
    const report = scan.report();
    expect(report.errors).toEqual(['JavaScript error: real, line 1']);
    expect(report.allowedErrors).toBe(1);
    expect(report.browserLines).toBe(5);
    expect(report.entries.map((entry) => entry.hits)).toEqual([2, 0, 2]);
    expect(report.overCap).toEqual([{ source: 'flood', origin: 'f:2', hits: 2, maxHits: 1 }]);
  });
});

describe('what counts as the browser having started', () => {
  const scanned = (lines: string[]): number => {
    const scan = createSmokeScan([]);
    for (const line of lines) scan.line(line);
    return scan.report().browserLines;
  };
  const LAUNCH = ' 0:01.20 /obj/dist/bin/firefox -no-remote -profile /tmp/p';

  it('counts nothing a launcher printed before the browser was started', () => {
    expect(
      scanned([
        '/opt/mach/pip.py:12: DeprecationWarning: imp is deprecated',
        'Creating local Python environment',
        ' 0:00.50 Adding configure options',
      ])
    ).toBe(0);
    expect(scanned(['mach prints a plain line first', ' 0:00.50 Reading config'])).toBe(0);
  });

  it('counts nothing after the launch line but launcher diagnostics', () => {
    expect(scanned([LAUNCH, 'UserWarning: psutil failed to run', ' 0:01.90 exit'])).toBe(0);
  });

  it('counts the browser lines after the launch line', () => {
    expect(scanned(['UserWarning: before', LAUNCH, 'console.log: ready', '###!!! x'])).toBe(2);
  });
});

describe('the smoke judgement', () => {
  const report = (overrides: Partial<SmokeReport>): SmokeReport => ({
    errors: [],
    allowedErrors: 0,
    browserLines: 3,
    entries: [],
    overCap: [],
    ...overrides,
  });

  it('passes a browser still running at the deadline, and one that left cleanly after printing', () => {
    expect(smokeFailure(report({}), { timedOut: true, exitCode: 143 })).toBeUndefined();
    expect(smokeFailure(report({}), { timedOut: false, exitCode: 0 })).toBeUndefined();
  });

  it('fails with exit code 12 on console errors, even when the window elapsed', () => {
    const failure = smokeFailure(report({ errors: ['JavaScript error: x'] }), {
      timedOut: true,
      exitCode: 143,
    });
    expect(failure).toMatchObject({
      code: 'smoke-console-errors',
      exitCode: ExitCode.SMOKE_EXIT_FAILURE,
    });
    const flood = smokeFailure(
      report({ overCap: [{ source: 'x', origin: 'f:1', hits: 3, maxHits: 1 }] }),
      { timedOut: true, exitCode: 143 }
    );
    expect(flood?.exitCode).toBe(12);
  });

  it('fails with exit code 13 when the browser left early: crashed, or silently', () => {
    expect(smokeFailure(report({}), { timedOut: false, exitCode: 1 })).toMatchObject({
      code: 'smoke-launch-failed',
      exitCode: ExitCode.SMOKE_LAUNCH_FAILURE,
    });
    expect(
      smokeFailure(report({ browserLines: 0 }), { timedOut: false, exitCode: 0 })?.message
    ).toMatch(/without printing anything/);
  });

  it('fails with exit code 13 when the window elapsed without a line from the browser', () => {
    expect(
      smokeFailure(report({ browserLines: 0 }), { timedOut: true, exitCode: 143 })
    ).toMatchObject({ code: 'smoke-launch-failed', exitCode: ExitCode.SMOKE_LAUNCH_FAILURE });
  });
});
