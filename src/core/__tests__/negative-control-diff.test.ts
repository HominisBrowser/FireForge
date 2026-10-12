// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { applyControlHunks, parseControlDiff } from '../negative-control-diff.js';
import type { ParsedHunk } from '../patch-parse.js';

const FILE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n') + '\n';

function diffOf(path: string, body: string, header = ''): string {
  return `diff --git a/${path} b/${path}\n${header}index 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
}

const NEUTER = diffOf('browser/x.mjs', '@@ -3,3 +3,3 @@\n three\n-four\n+FOUR\n five\n');

describe('parseControlDiff', () => {
  it('parses one section per file with its hunks', () => {
    const files = parseControlDiff(NEUTER);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('browser/x.mjs');
    expect(files[0]?.hunks).toHaveLength(1);
  });

  it('refuses text without a diff --git header and names the git command', () => {
    expect(() => parseControlDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toThrow(
      /no `diff --git` sections.*git -C engine diff/s
    );
  });

  it.each([
    ['a new file', diffOf('n.js', '@@ -0,0 +1 @@\n+x\n', 'new file mode 100644\n')],
    ['a deleted file', diffOf('d.js', '@@ -1 +0,0 @@\n-x\n', 'deleted file mode 100644\n')],
    ['a binary section', 'diff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ\n'],
    ['a rename', 'diff --git a/old.js b/new.js\nsimilarity index 90%\n@@ -1 +1 @@\n-a\n+b\n'],
    ['an escaping path', diffOf('../outside.js', '@@ -1 +1 @@\n-a\n+b\n')],
    ['a hunk-less section', 'diff --git a/m.js b/m.js\nold mode 100644\nnew mode 100755\n'],
    ['a repeated file', NEUTER + NEUTER],
  ])('refuses %s', (_label, diff) => {
    expect(() => parseControlDiff(diff)).toThrow(/^Negative control diff refused: /);
  });
});

describe('applyControlHunks', () => {
  const hunks = (diff: string): ParsedHunk[] => parseControlDiff(diff)[0]?.hunks ?? [];

  it('applies a hunk at its stated position', () => {
    expect(applyControlHunks(FILE, hunks(NEUTER), 'x')).toBe(FILE.replace('four', 'FOUR'));
  });

  it('tolerates a line offset but never fuzz', () => {
    const shifted = `zero\n${FILE}`;
    expect(applyControlHunks(shifted, hunks(NEUTER), 'x')).toBe(shifted.replace('four', 'FOUR'));
    expect(() => applyControlHunks(FILE.replace('three', 'THREE'), hunks(NEUTER), 'x')).toThrow(
      /hunk 1 of x .* does not apply.*regenerate/s
    );
  });

  it('finds a block that moved up, as git apply does', () => {
    const diff = diffOf('x', '@@ -5,2 +5,2 @@\n five\n-six\n+SIX\n');
    const moved = FILE.replace('one\ntwo\n', '');
    expect(applyControlHunks(moved, hunks(diff), 'x')).toBe(moved.replace('six', 'SIX'));
  });

  it('says so when the mutation is already present', () => {
    expect(() => applyControlHunks(FILE.replace('four', 'FOUR'), hunks(NEUTER), 'x')).toThrow(
      /already present/
    );
  });

  it('applies several hunks in order', () => {
    const diff = diffOf(
      'x',
      '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n@@ -6,2 +6,2 @@\n six\n-seven\n+SEVEN\n'
    );
    expect(applyControlHunks(FILE, hunks(diff), 'x')).toBe(
      FILE.replace('one', 'ONE').replace('seven', 'SEVEN')
    );
  });

  it('handles pure insertions and deletions', () => {
    const insert = diffOf('x', '@@ -2,0 +3 @@\n+inserted\n');
    expect(applyControlHunks(FILE, hunks(insert), 'x')).toBe(
      FILE.replace('two\n', 'two\ninserted\n')
    );
    const remove = diffOf('x', '@@ -1,3 +1,2 @@\n one\n-two\n three\n');
    expect(applyControlHunks(FILE, hunks(remove), 'x')).toBe(FILE.replace('two\n', ''));
  });

  it('refuses a pure insertion past the end of the file', () => {
    const insert = diffOf('x', '@@ -40,0 +41 @@\n+late\n');
    expect(() => applyControlHunks(FILE, hunks(insert), 'x')).toThrow(/does not apply/);
  });

  it('honours the no-newline-at-end markers on either side', () => {
    const noEol = 'a\nb';
    const addEol = diffOf('x', '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    expect(applyControlHunks(noEol, hunks(addEol), 'x')).toBe('a\nb\n');
    const dropEol = diffOf('x', '@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n');
    expect(applyControlHunks('a\nb\n', hunks(dropEol), 'x')).toBe('a\nc');
    // The diff says the old side lacks a final newline; this file has one.
    expect(() => applyControlHunks('a\nb\n', hunks(addEol), 'x')).toThrow(/does not apply/);
  });

  it('keeps CRLF payload bytes intact', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const diff = diffOf('x', '@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n');
    expect(applyControlHunks(crlf, hunks(diff), 'x')).toBe('a\r\nB\r\nc\r\n');
  });

  it('refuses a hunk whose header counts disagree with its body', () => {
    const diff = diffOf('x', '@@ -3,4 +3,3 @@\n three\n-four\n+FOUR\n five\n');
    expect(() => applyControlHunks(FILE, hunks(diff), 'x')).toThrow(/malformed/);
  });

  it('applies to an empty file', () => {
    const diff = diffOf('x', '@@ -0,0 +1 @@\n+first\n');
    expect(applyControlHunks('', hunks(diff), 'x')).toBe('first\n');
  });
});
