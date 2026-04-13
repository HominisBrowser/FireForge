// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { tokenizeJarMn } from '../manifest-tokenizers.js';

describe('tokenizeJarMn', () => {
  it('tokenizes a well-formed jar.mn file', () => {
    const lines = [
      'toolkit.jar:',
      '% content global %content/global/',
      '   content/global/elements/findbar.js  (widgets/findbar/findbar.js)',
      '',
      '# comment line',
    ];

    const tokens = tokenizeJarMn(lines);

    expect(tokens).toEqual([
      { type: 'header', raw: 'toolkit.jar:', lineIndex: 0 },
      { type: 'directive', raw: '% content global %content/global/', lineIndex: 1 },
      {
        type: 'entry',
        raw: '   content/global/elements/findbar.js  (widgets/findbar/findbar.js)',
        lineIndex: 2,
        parsed: {
          target: 'content/global/elements/findbar.js',
          source: 'widgets/findbar/findbar.js',
        },
      },
      { type: 'empty', raw: '', lineIndex: 3 },
      { type: 'comment', raw: '# comment line', lineIndex: 4 },
    ]);
  });

  it('handles a truncated entry line without closing parenthesis', () => {
    const lines = [
      'toolkit.jar:',
      '   content/global/elements/findbar.js  (widgets/findbar/findbar.js',
    ];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[1]?.type).toBe('entry');
    expect(tokens[1]?.parsed).toBeUndefined();
  });

  it('handles an entry with missing source parenthesis entirely', () => {
    const lines = ['toolkit.jar:', '   content/global/elements/findbar.js'];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[1]?.type).toBe('entry');
    expect(tokens[1]?.parsed).toBeUndefined();
  });

  it('handles lines with unexpected whitespace patterns', () => {
    const lines = [
      '  \t  ',
      'toolkit.jar:',
      '\t   content/global/elements/findbar.js  (widgets/findbar/findbar.js)',
    ];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[0]?.type).toBe('empty');
    expect(tokens[1]?.type).toBe('header');
    expect(tokens[2]?.type).toBe('entry');
    expect(tokens[2]?.parsed).toEqual({
      target: 'content/global/elements/findbar.js',
      source: 'widgets/findbar/findbar.js',
    });
  });

  it('handles empty input', () => {
    expect(tokenizeJarMn([])).toEqual([]);
  });

  it('handles whitespace-only input', () => {
    const tokens = tokenizeJarMn(['', '   ', '\t']);

    expect(tokens.every((t) => t.type === 'empty')).toBe(true);
    expect(tokens).toHaveLength(3);
  });

  it('handles entry with extra spaces between target and source', () => {
    const lines = ['   content/global/elements/findbar.js      (widgets/findbar/findbar.js)'];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[0]?.type).toBe('entry');
    expect(tokens[0]?.parsed).toEqual({
      target: 'content/global/elements/findbar.js',
      source: 'widgets/findbar/findbar.js',
    });
  });

  it('handles entry with nested parentheses in source path', () => {
    const lines = ['   content/global/elements/findbar.js  (widgets/findbar/findbar(1).js)'];

    const tokens = tokenizeJarMn(lines);

    // The regex stops at first ), so this is a partial parse
    expect(tokens[0]?.type).toBe('entry');
    expect(tokens[0]?.parsed?.source).toBe('widgets/findbar/findbar(1');
  });

  it('handles a line that looks like a header but uses +=', () => {
    const lines = ['EXTRA_JS_MODULES += ['];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[0]?.type).toBe('header');
  });

  it('handles a mix of comment styles and empty lines', () => {
    const lines = ['# top comment', '', '## double hash', '#! shebang-style'];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[0]?.type).toBe('comment');
    expect(tokens[1]?.type).toBe('empty');
    expect(tokens[2]?.type).toBe('comment');
    expect(tokens[3]?.type).toBe('comment');
  });

  it('treats indented lines without parenthesized source as entries', () => {
    const lines = ['   some/path/file.js'];

    const tokens = tokenizeJarMn(lines);

    expect(tokens[0]?.type).toBe('entry');
    expect(tokens[0]?.parsed).toBeUndefined();
  });

  it('handles multiple jar sections', () => {
    const lines = [
      'toolkit.jar:',
      '% content global %content/global/',
      '   content/global/elements/a.js  (widgets/a/a.js)',
      '',
      'browser.jar:',
      '% content browser %content/browser/',
      '   content/browser/foo.js  (browser/foo.js)',
    ];

    const tokens = tokenizeJarMn(lines);

    const headers = tokens.filter((t) => t.type === 'header');
    expect(headers).toHaveLength(2);

    const entries = tokens.filter((t) => t.type === 'entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.parsed?.target).toBe('content/global/elements/a.js');
    expect(entries[1]?.parsed?.target).toBe('content/browser/foo.js');
  });
});
