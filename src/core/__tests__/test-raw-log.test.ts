// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import {
  forwardedRawLogPath,
  hasForwardedRawLog,
  parseRawTestLog,
  readRawTestLog,
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
