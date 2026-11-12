// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { escapeRegExp, lineSplitter, nearest, splitLines, tailLines, unquoteC } from './text.js';

describe('escapeRegExp', () => {
  it('escapes every metacharacter so the text matches itself literally', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.c')}$`).test('abc')).toBe(false);
  });
});

describe('splitLines and tailLines', () => {
  it('splits on LF and CRLF without a trailing empty line', () => {
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(splitLines('')).toEqual([]);
  });

  it('keeps the last non-empty lines', () => {
    expect(tailLines('a\n\nb\nc\n  \n', 2)).toEqual(['b', 'c']);
  });
});

describe('lineSplitter', () => {
  function collect(chunks: string[]): string[] {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    for (const chunk of chunks) splitter.push(chunk);
    splitter.flush();
    return lines;
  }

  it.each([
    ['one line per LF, final partial line flushed', ['a\nb', 'c\nd'], ['a', 'bc', 'd']],
    ['CRLF leaves no carriage return', ['a\r\nb\r\n'], ['a', 'b']],
    ['a lone CR repaint ends a line', ['10%\r20%\rdone\n'], ['10%', '20%', 'done']],
    ['a CRLF split across chunks is one terminator', ['a\r', '\nb\n'], ['a', 'b']],
    ['a trailing CR at the end is not an extra line', ['a\r'], ['a']],
    ['empty lines are kept', ['a\n\nb\n'], ['a', '', 'b']],
  ])('%s', (_name, chunks, expected) => {
    expect(collect(chunks)).toEqual(expected);
  });

  it('dispatches an oversized partial line instead of buffering without bound', () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    splitter.push('x'.repeat(1024 * 1024 + 1));
    expect(lines).toHaveLength(1);
    splitter.flush();
    expect(lines).toHaveLength(1);
  });
});

describe('nearest', () => {
  it('suggests a close candidate and nothing for a distant one', () => {
    const keys = ['binaryName', 'vendor', 'firefox', 'license'];
    expect(nearest('binaryname', keys)).toBe('binaryName');
    expect(nearest('vendr', keys)).toBe('vendor');
    expect(nearest('licence', keys)).toBe('license');
    expect(nearest('completelyDifferent', keys)).toBeUndefined();
  });
});

describe('unquoteC', () => {
  it('decodes octal bytes and named escapes, with or without the quotes', () => {
    expect(unquoteC('"f\\303\\274r.js"').toString('utf8')).toBe('f\u00fcr.js');
    expect(unquoteC('a\\tb\\"c\\\\d').toString('utf8')).toBe('a\tb"c\\d');
    expect(unquoteC('"plain"').toString('utf8')).toBe('plain');
  });

  it('maps literal characters through the given encoding', () => {
    expect([...unquoteC('\u00e9\\351', 'latin1')]).toEqual([0xe9, 0xe9]);
    expect([...unquoteC('\u00e9')]).toEqual([0xc3, 0xa9]);
  });
});
