// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { formatFireforgeVerdictLine } from '../test-harness-crash.js';
import { parseRawTestLog } from '../test-raw-log.js';
import {
  buildIncompleteRunMessage,
  countStartedFiles,
  createStartMarkerTracker,
  vetoIncompletePass,
} from '../test-run-completeness.js';

const DIR = 'browser/base/content/test/tiles';
const FILES = [`${DIR}/browser_a.js`, `${DIR}/browser_b.js`, `${DIR}/browser_c.js`];

const SHUTDOWN =
  'TEST-UNEXPECTED-FAIL | browser/base/content/test/tiles/browser_b.js | Application shut down (without crashing) in the middle of a test!';

describe('createStartMarkerTracker', () => {
  it('joins lines split across chunks per stream and keeps an unterminated tail', () => {
    const tracker = createStartMarkerTracker();
    tracker.onChunk('stdout', `TEST-STA`);
    tracker.onChunk('stderr', `TEST-SKIP | ${FILES[1]}\n`);
    tracker.onChunk('stdout', `RT | ${FILES[0]}\nTEST-OK\n TEST_START: ${FILES[2]}`);
    expect(tracker.markers()).toEqual({
      started: [FILES[0], FILES[2]],
      skipped: [FILES[1]],
    });
  });

  it('counts the files the capture tail lost (a 2 MB-tail suite read 10/17 before)', () => {
    const tracker = createStartMarkerTracker();
    for (const file of FILES) tracker.onChunk('stdout', `TEST-START | ${file}\nTEST-OK\n`);
    // The capped capture kept only the last file's lines.
    const tail = `TEST-START | ${FILES[2]}\nTEST-OK\nUnexpected results: 0\n`;
    const verdict = vetoIncompletePass({ kind: 'tests-ran-ok', unexpected: 0 }, tail, FILES, {
      markers: tracker.markers(),
      source: 'stream',
    });
    expect(verdict.kind).toBe('tests-ran-ok');
    expect(
      vetoIncompletePass({ kind: 'tests-ran-ok', unexpected: 0 }, tail, FILES).incomplete
    ).toMatchObject({ started: 1, firstUnstarted: FILES[0], startedSource: 'capture' });
  });

  it('fails a raw log whose starts name none of the requested files (a --jobs instance that ran another list)', () => {
    const own = `${DIR}/browser_b.js`;
    const verdict = vetoIncompletePass({ kind: 'tests-ran-ok', unexpected: 0 }, '', [own], {
      markers: { started: [`${DIR}/browser_a.js`], skipped: [] },
      source: 'raw',
    });
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.incomplete).toMatchObject({
      started: 0,
      requested: 1,
      firstUnstarted: own,
      startedSource: 'raw',
    });
    // Streamed text that names other files fails the same way.
    expect(
      vetoIncompletePass({ kind: 'tests-ran-ok', unexpected: 0 }, '', [own], {
        markers: { started: [`${DIR}/browser_a.js`], skipped: [] },
        source: 'stream',
      }).kind
    ).toBe('test-failures');
    // A start line that shares the basename but not the path cannot be counted.
    expect(
      vetoIncompletePass({ kind: 'tests-ran-ok', unexpected: 0 }, '', [own], {
        markers: { started: [`elsewhere/browser_b.js`], skipped: [] },
        source: 'stream',
      }).kind
    ).toBe('tests-ran-ok');
  });

  it('falls back to the capture when nothing was streamed through the tracker', () => {
    const output = `TEST-START | ${FILES[0]}\nTEST-OK\n`;
    const verdict = vetoIncompletePass({ kind: 'tests-ran-ok' }, output, FILES, {
      markers: { started: [], skipped: [] },
      source: 'stream',
    });
    expect(verdict.incomplete).toMatchObject({ started: 1, startedSource: 'capture' });
  });
});

describe('countStartedFiles', () => {
  it('never counts another directory or an ambiguous basename as the requested file', () => {
    const requested = ['one/browser_same.js', 'two/browser_same.js'];
    expect(
      countStartedFiles({ started: ['wrong/browser_same.js'], skipped: [] }, requested, true)
    ).toMatchObject({ started: 0, requested: 2 });
    expect(
      countStartedFiles({ started: ['browser_same.js'], skipped: [] }, requested, true)
    ).toMatchObject({ started: 0, requested: 2 });
    expect(
      countStartedFiles(
        { started: ['file:///build/one/browser_same.js'], skipped: [] },
        requested,
        true
      )
    ).toMatchObject({ started: 1, firstUnstarted: requested[1] });
  });
  it('counts requested files with a start marker and names the first that never started', () => {
    const output = [`TEST-START | ${FILES[0]}`, 'TEST-OK', `TEST-START | ${FILES[1]}`].join('\n');
    expect(countStartedFiles(output, FILES)).toEqual({
      started: 2,
      requested: 3,
      firstUnstarted: FILES[2],
    });
  });

  it('accounts a manifest-skipped file instead of reporting it unstarted', () => {
    const output = [
      `TEST-START | ${FILES[0]}`,
      `TEST-SKIP | ${FILES[1]} | skip-if`,
      ` 0:01.00 TEST_START: ${FILES[2]}`,
    ].join('\n');
    expect(countStartedFiles(output, FILES)).toEqual({ started: 3, requested: 3 });
  });

  it('cannot count a dialect whose start lines name no requested file', () => {
    expect(countStartedFiles('TEST-START | t\nTEST-OK | t', FILES)).toBeUndefined();
    expect(countStartedFiles('Ran 4 checks\nUnexpected results: 0', FILES)).toBeUndefined();
  });

  it('ignores requests that are not test-file-shaped', () => {
    expect(countStartedFiles(`TEST-START | ${FILES[0]}`, [DIR, `${DIR}/browser.toml`])).toBe(
      undefined
    );
  });
});

describe('vetoIncompletePass', () => {
  it('fails the truncated exit-0 suite the fork reported (PASS unexpected=1 before)', () => {
    const output = [
      `TEST-START | ${FILES[0]}`,
      'TEST-OK',
      `TEST-START | ${FILES[1]}`,
      SHUTDOWN,
      'Ran 7919 checks',
      'Unexpected results: 1',
    ].join('\n');
    const verdict = vetoIncompletePass(
      { kind: 'tests-ran-ok', checks: 7919, unexpected: 1 },
      output,
      FILES
    );
    expect(verdict).toMatchObject({
      kind: 'test-failures',
      checks: 7919,
      unexpected: 1,
      realFailureLine: SHUTDOWN,
      incomplete: {
        started: 2,
        requested: 3,
        firstUnstarted: FILES[2],
        shutdownLine: SHUTDOWN,
        unexpected: 1,
      },
    });
    expect(formatFireforgeVerdictLine(verdict)).toBe(
      `FIREFORGE-VERDICT: FAIL reason=test-failures checks=7919 unexpected=1 started=2/3 first-unstarted=${FILES[2]} started-source=capture`
    );
  });

  it('fails a non-zero unexpected count even when every file started', () => {
    const output = FILES.map((file) => `TEST-START | ${file}`).join('\n');
    const verdict = vetoIncompletePass(
      { kind: 'tests-ran-ok', unexpected: 2, note: 'harness teardown noise ignored' },
      output,
      FILES
    );
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.note).toBeUndefined();
    expect(verdict.incomplete).toEqual({ started: 3, requested: 3, unexpected: 2 });
    // No first-unstarted file means no truncation keys on the line.
    expect(formatFireforgeVerdictLine(verdict)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=test-failures unexpected=2'
    );
  });

  it('fails a short start count with a clean summary and drops the override flag', () => {
    const verdict = vetoIncompletePass(
      { kind: 'tests-ran-ok', unexpected: 0, greenSummaryOverride: true },
      `TEST-START | ${FILES[0]}`,
      FILES
    );
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.greenSummaryOverride).toBeUndefined();
    expect(verdict.incomplete?.firstUnstarted).toBe(FILES[1]);
    expect(verdict.realFailureLine).toBeUndefined();
  });

  it('keeps a complete clean pass, an uncountable run, and every non-pass verdict', () => {
    const complete = FILES.map((file) => `TEST-START | ${file}`).join('\n');
    const pass = { kind: 'tests-ran-ok' as const, unexpected: 0 };
    expect(vetoIncompletePass(pass, complete, FILES)).toBe(pass);
    expect(vetoIncompletePass(pass, 'Ran 3 checks', FILES)).toBe(pass);
    const failed = { kind: 'test-failures' as const, unexpected: 1 };
    expect(vetoIncompletePass(failed, 'TEST-UNEXPECTED-FAIL | assertion', FILES)).toBe(failed);
  });

  it('annotates an already red suite with its missing files without replacing its failure', () => {
    const failed = {
      kind: 'test-failures' as const,
      unexpected: 11,
      realFailureLine: 'original assertion',
    };
    const verdict = vetoIncompletePass(
      failed,
      `TEST-START | ${FILES[0]}\nMain app process: killed by SIGSEGV`,
      FILES
    );
    expect(verdict).toMatchObject({
      ...failed,
      incomplete: { started: 1, requested: 3, firstUnstarted: FILES[1] },
    });
    expect(formatFireforgeVerdictLine(verdict)).toContain(
      `started=1/3 first-unstarted=${FILES[1]}`
    );
    expect(formatFireforgeVerdictLine(verdict)).toContain('app-exit=SIGSEGV');
  });
});

describe('a directory request counted from the raw log roster', () => {
  const line = (record: Record<string, unknown>): string => JSON.stringify(record);
  const ROSTER = [...FILES, `${DIR}/browser_d.js`, `${DIR}/browser_e.js`];
  /** A mochitest raw log: the roster, the preamble's skip-if records, then each file that ran. */
  const rawLog = (ran: readonly string[], skipped: readonly string[] = [], end = true): string =>
    [
      line({
        action: 'suite_start',
        name: 'mochitest-browser',
        tests: { [`${DIR}/browser.toml`]: ROSTER },
      }),
      ...skipped.flatMap((test) => [
        line({ action: 'test_start', test }),
        line({ action: 'test_end', test, status: 'SKIP', message: 'skip-if' }),
      ]),
      ...ran.flatMap((test) => [
        line({ action: 'test_start', test }),
        line({ action: 'test_end', test, status: 'OK' }),
      ]),
      ...(end ? [line({ action: 'suite_end' })] : []),
    ].join('\n');

  it('names the files a harness timeout left unjudged (no started= count before)', () => {
    const raw = parseRawTestLog(
      [
        rawLog(FILES.slice(0, 2), [], false),
        line({ action: 'test_start', test: FILES[2] }),
        line({ action: 'test_end', test: FILES[2], status: 'TIMEOUT', expected: 'OK' }),
      ].join('\n')
    );
    const failed = { kind: 'test-failures' as const, unexpected: 1 };
    const verdict = vetoIncompletePass(failed, '', [DIR], undefined, raw);
    expect(verdict.incomplete).toMatchObject({
      started: 3,
      requested: 5,
      firstUnstarted: `${DIR}/browser_d.js`,
      startedSource: 'raw',
    });
    expect(formatFireforgeVerdictLine(verdict)).toBe(
      `FIREFORGE-VERDICT: FAIL reason=test-failures unexpected=1 started=3/5 first-unstarted=${DIR}/browser_d.js started-source=raw`
    );
  });

  it('fails an exit-0 run that stopped before the roster ran', () => {
    const raw = parseRawTestLog(rawLog(FILES));
    const verdict = vetoIncompletePass(
      { kind: 'tests-ran-ok', unexpected: 0 },
      '',
      [DIR],
      undefined,
      raw
    );
    expect(verdict.kind).toBe('test-failures');
    expect(verdict.incomplete).toMatchObject({ started: 3, requested: 5 });
  });

  it('keeps a complete directory pass, its skip-if files counted as accounted for', () => {
    const pass = { kind: 'tests-ran-ok' as const, unexpected: 0 };
    const skippedTwo = parseRawTestLog(rawLog(ROSTER.slice(0, 3), ROSTER.slice(3)));
    expect(vetoIncompletePass(pass, '', [DIR], undefined, skippedTwo)).toBe(pass);
    expect(vetoIncompletePass(pass, '', [`${DIR}/browser.toml`], undefined, skippedTwo)).toBe(pass);
    // A file requested by name and announced again is one file.
    expect(vetoIncompletePass(pass, '', [`engine/${FILES[0]}`, DIR], undefined, skippedTwo)).toBe(
      pass
    );
    // A trimmed run's empty roster leaves the count to the requested files.
    const trimmed = { ...parseRawTestLog(rawLog(FILES)), roster: [] };
    expect(vetoIncompletePass(pass, '', [DIR], undefined, trimmed)).toBe(pass);
  });

  it('joins the rosters of several suite_start records', () => {
    const raw = parseRawTestLog(
      [
        rawLog(ROSTER),
        line({ action: 'suite_start', tests: { 'other/browser.toml': ['other/browser_o.js'] } }),
        line({ action: 'suite_end' }),
      ].join('\n')
    );
    const verdict = vetoIncompletePass(
      { kind: 'tests-ran-ok' },
      '',
      [DIR, 'other'],
      undefined,
      raw
    );
    expect(verdict.incomplete).toMatchObject({
      started: 5,
      requested: 6,
      firstUnstarted: 'other/browser_o.js',
    });
  });
});

describe('buildIncompleteRunMessage', () => {
  it('names the first unstarted file, the shutdown line and the count', () => {
    const message = buildIncompleteRunMessage({
      started: 105,
      requested: 314,
      firstUnstarted: FILES[2] ?? '',
      shutdownLine: SHUTDOWN,
      unexpected: 1,
    });
    expect(message).toContain('only 105 of 314 requested test files started');
    expect(message).toContain(`the first that never started is ${FILES[2]}`);
    expect(message).toContain(`shut down in the middle of a test: ${SHUTDOWN}`);
    expect(message).toContain('reported 1 unexpected result(s)');
    expect(message).toContain(`Re-run from ${FILES[2]} onward`);
  });

  it('points at the unexpected results when nothing was truncated', () => {
    const message = buildIncompleteRunMessage({ started: 3, requested: 3, unexpected: 2 });
    expect(message).not.toContain('never started');
    expect(message).toContain('Read the unexpected results in the output above.');
  });
});
