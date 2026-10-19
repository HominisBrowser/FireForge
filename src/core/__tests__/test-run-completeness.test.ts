// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { formatFireforgeVerdictLine } from '../test-harness-crash.js';
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
    expect(vetoIncompletePass(failed, SHUTDOWN, FILES)).toBe(failed);
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
