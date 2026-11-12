// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDir, writeTree } from '../testing/temp.js';
import { parseRawTestLog, readRawTestLog } from './rawLog.js';

const dir = useTempDir();
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
        failures: [],
        durationMs: 250,
      },
      {
        test: 'd/browser_b.js',
        status: 'OK',
        expected: 'OK',
        unexpected: true,
        failures: [{ assertion: 'x', status: 'FAIL', expected: 'PASS' }],
      },
      { test: 'd/browser_c.js', status: 'TIMEOUT', expected: 'OK', unexpected: true, failures: [] },
      { test: 'd/browser_s.js', status: 'SKIP', expected: 'SKIP', unexpected: false, failures: [] },
    ]);
    expect(parsed.started).toEqual([
      'd/browser_a.js',
      'd/browser_b.js',
      'd/browser_c.js',
      'd/browser_d.js',
    ]);
    expect(parsed.skipped).toEqual(['d/browser_s.js']);
    expect(parsed.unfinished).toEqual(['d/browser_d.js']);
    expect(parsed.suiteCompleted).toBe(false);
  });

  it('requires a real status mismatch and keeps the direction of an unexpected pass', () => {
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
    expect(parsed.results[0]?.failures).toEqual([
      { assertion: 'unexpected pass', status: 'PASS', expected: 'FAIL' },
    ]);
  });

  it("keeps an xpcshell red's assertion text beside its task label, and a mochitest diagnostic out", () => {
    const parsed = parseRawTestLog(
      [
        line({ action: 'test_start', test: 'u/test_wire.js' }),
        line({
          action: 'test_status',
          test: 'u/test_wire.js',
          subtest: 'test_wire_three_streams',
          status: 'FAIL',
          expected: 'PASS',
          message: '[test_wire_three_streams : 42] the stream settled - false == true',
        }),
        line({ action: 'test_end', test: 'u/test_wire.js', status: 'FAIL', expected: 'PASS' }),
        line({ action: 'test_start', test: 'b/browser_a.js' }),
        line({
          action: 'test_status',
          test: 'b/browser_a.js',
          subtest: 'the guard holds',
          status: 'FAIL',
          expected: 'PASS',
          message: 'Got false, expected true',
        }),
        line({ action: 'test_end', test: 'b/browser_a.js', status: 'OK' }),
      ].join('\n')
    );
    expect(parsed.results[0]?.failures).toEqual([
      {
        assertion: 'test_wire_three_streams',
        status: 'FAIL',
        expected: 'PASS',
        message: 'the stream settled - false == true',
      },
    ]);
    expect(parsed.results[1]?.failures).toEqual([
      { assertion: 'the guard holds', status: 'FAIL', expected: 'PASS' },
    ]);
  });

  it('joins every suite_start roster, by manifest in sorted order, each test once', () => {
    const parsed = parseRawTestLog(
      [
        line({
          action: 'suite_start',
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
});

describe('readRawTestLog', () => {
  it('parses a file and returns undefined for a missing one', async () => {
    await writeTree(dir(), { 'run.raw.jsonl': LOG });
    expect((await readRawTestLog(join(dir(), 'run.raw.jsonl')))?.results).toHaveLength(4);
    expect(await readRawTestLog(join(dir(), 'absent.jsonl'))).toBeUndefined();
  });
});
