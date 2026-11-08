// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import {
  forwardedRawLogPath,
  hasForwardedRawLog,
  parseRawTestLog,
  readRawTestLog,
  trimsAnnouncedTests,
} from '../test-raw-log.js';

const line = (record: Record<string, unknown>): string => JSON.stringify(record);

const LOG = [
  line({ action: 'suite_start', tests: {} }),
  line({ action: 'test_start', test: 'd/browser_a.js', time: 1000 }),
  line({ action: 'test_status', test: 'd/browser_a.js', subtest: 'ok', status: 'PASS' }),
  line({ action: 'test_end', test: 'd/browser_a.js', status: 'OK', time: 1250 }),
  line({ action: 'test_start', test: 'd/browser_b.js', time: 2000 }),
  line({
    action: 'test_status',
    test: 'd/browser_b.js',
    subtest: 'x',
    status: 'FAIL',
    expected: 'PASS',
  }),
  line({ action: 'test_end', test: 'd/browser_b.js', status: 'OK' }),
  line({ action: 'test_start', test: 'd/browser_c.js', time: 3000 }),
  line({ action: 'test_end', test: 'd/browser_c.js', status: 'TIMEOUT', expected: 'OK' }),
  line({ action: 'test_end', test: 'd/browser_s.js', status: 'SKIP' }),
  line({ action: 'test_start', test: 'd/browser_d.js' }),
  '{"action": "test_end", "test": "d/browser_d.js", "sta',
  'not json',
  '{',
  line({ action: 'test_end', status: 'OK' }),
  'null',
].join('\n');

describe('parseRawTestLog', () => {
  it('reads per-file outcomes, subtest failures, durations and unfinished files', () => {
    const parsed = parseRawTestLog(LOG);
    expect(parsed.results).toEqual([
      {
        test: 'd/browser_a.js',
        status: 'OK',
        expected: 'OK',
        unexpected: false,
        unexpectedSubtests: 0,
        durationMs: 250,
      },
      {
        test: 'd/browser_b.js',
        status: 'OK',
        expected: 'OK',
        unexpected: true,
        unexpectedSubtests: 1,
        unexpectedAssertions: ['x'],
        unexpectedAssertionResults: [{ assertion: 'x', status: 'FAIL', expected: 'PASS' }],
      },
      {
        test: 'd/browser_c.js',
        status: 'TIMEOUT',
        expected: 'OK',
        unexpected: true,
        unexpectedSubtests: 0,
      },
      {
        test: 'd/browser_s.js',
        status: 'SKIP',
        expected: 'SKIP',
        unexpected: false,
        unexpectedSubtests: 0,
      },
    ]);
    expect(parsed.markers).toEqual({
      started: ['d/browser_a.js', 'd/browser_b.js', 'd/browser_c.js', 'd/browser_d.js'],
      skipped: ['d/browser_s.js'],
    });
    expect(parsed.unfinished).toEqual(['d/browser_d.js']);
  });
  it('requires a real status mismatch and preserves unexpected-pass direction', () => {
    const parsed = parseRawTestLog(
      [
        line({ action: 'test_start', test: 'a.js' }),
        line({
          action: 'test_status',
          test: 'a.js',
          subtest: 'ordinary green',
          status: 'PASS',
          expected: 'PASS',
        }),
        line({
          action: 'test_status',
          test: 'a.js',
          subtest: 'unexpected pass',
          status: 'PASS',
          expected: 'FAIL',
        }),
        line({ action: 'test_end', test: 'a.js', status: 'OK' }),
      ].join('\n')
    );
    expect(parsed.results[0]?.unexpectedAssertions).toEqual(['unexpected pass']);
    expect(parsed.results[0]?.unexpectedAssertionResults).toEqual([
      { assertion: 'unexpected pass', status: 'PASS', expected: 'FAIL' },
    ]);
  });
});

describe('the suite_start roster', () => {
  it('joins every suite_start, by manifest in sorted order, each test once', () => {
    // mochitest announces tests keyed by manifest; a list arrives as mozlog's `default` group.
    const parsed = parseRawTestLog(
      [
        line({
          action: 'suite_start',
          name: 'mochitest-browser',
          tests: {
            'd/z/browser.toml': ['d/z/browser_z.js'],
            'd/a/browser.toml': ['d/a/browser_a.js', 'd/a/browser_b.js'],
            'd/missing/browser.toml': [],
          },
        }),
        line({ action: 'suite_end' }),
        line({
          action: 'suite_start',
          tests: { default: ['d/a/browser_a.js', 'd/y/browser_y.js'] },
        }),
        line({ action: 'suite_end' }),
        line({ action: 'suite_start', tests: ['d/x/browser_x.js', 7] }),
        line({ action: 'suite_end' }),
      ].join('\n')
    );
    expect(parsed.roster).toEqual([
      'd/a/browser_a.js',
      'd/a/browser_b.js',
      'd/z/browser_z.js',
      'd/y/browser_y.js',
      'd/x/browser_x.js',
    ]);
    expect(parsed.suiteCompleted).toBe(true);
    expect(parseRawTestLog(LOG).roster).toEqual([]);
  });

  it('is no count for a run --start-at or --end-at trims in the browser', () => {
    expect(trimsAnnouncedTests(['--start-at=d/browser_b.js'])).toBe(true);
    expect(trimsAnnouncedTests(['--end-at', 'd/browser_b.js'])).toBe(true);
    expect(trimsAnnouncedTests(['--headless', '--start-attempt'])).toBe(false);
  });
});

describe('readRawTestLog', () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempProject('ff-raw-log-');
  });
  afterEach(async () => {
    await removeTempProject(root);
  });

  it('parses a file and returns undefined for a missing one', async () => {
    await writeFiles(root, { 'raw.jsonl': LOG });
    expect((await readRawTestLog(join(root, 'raw.jsonl')))?.results).toHaveLength(4);
    await expect(readRawTestLog(join(root, 'missing.jsonl'))).resolves.toBeUndefined();
  });
});

describe('forwarded --log-raw', () => {
  it('finds a forwarded file in either form, and ignores stdout', () => {
    expect(forwardedRawLogPath(['--headless', '--log-raw=/tmp/a.jsonl'])).toBe('/tmp/a.jsonl');
    expect(forwardedRawLogPath(['--log-raw', '/tmp/b.jsonl'])).toBe('/tmp/b.jsonl');
    expect(forwardedRawLogPath(['--log-raw=-'])).toBeUndefined();
    expect(forwardedRawLogPath(['--headless'])).toBeUndefined();
    expect(hasForwardedRawLog(['--log-raw=-'])).toBe(true);
    expect(hasForwardedRawLog(['--log-raw'])).toBe(true);
    expect(hasForwardedRawLog(['--log-mach=x'])).toBe(false);
  });
});
