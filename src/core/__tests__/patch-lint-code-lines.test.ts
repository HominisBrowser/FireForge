// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { countCodeLines as fromPublicApi } from '../../index.js';
import { codeLineMask, countCodeLines, countRawLines } from '../patch-lint-code-lines.js';

describe('countRawLines', () => {
  it('counts like wc -l: a trailing newline adds no line', () => {
    expect(countRawLines('a\nb\n')).toBe(2);
    expect(countRawLines('a\nb')).toBe(2);
    expect(countRawLines('')).toBe(0);
  });
});

describe('countCodeLines', () => {
  it('is the public-API binding', () => {
    expect(fromPublicApi).toBe(countCodeLines);
  });

  it('drops JSDoc, line comments and blank lines', () => {
    const src = [
      '/**',
      ' * Adds two numbers.',
      ' * @param {number} a',
      ' */',
      'export function add(a, b) {',
      '',
      '  // the sum',
      '  return a + b; // trailing comment keeps the line',
      '}',
      '',
    ].join('\n');
    expect(countCodeLines(src)).toEqual({ lines: 3, parsed: true });
  });

  it('keeps a regex literal containing /* and a string containing //', () => {
    const src = ['const re = /a\\/*b/;', 'const url = "https://example.com";', 'let n = 1;'].join(
      '\n'
    );
    expect(countCodeLines(src)).toEqual({ lines: 3, parsed: true });
  });

  it('treats a blank line inside a template literal as blank and keeps nested templates', () => {
    const src = ['const t = `a', '', '${`inner ${1}`}`;', 'f();'].join('\n');
    expect(countCodeLines(src)).toEqual({ lines: 3, parsed: true });
  });

  it('does not count a shebang', () => {
    expect(countCodeLines('#!/usr/bin/env node\nrun();\n')).toEqual({ lines: 1, parsed: true });
  });

  it('parses a chrome subscript that only the script goal accepts', () => {
    // A legacy octal escape is a tokenizer error under the module goal.
    const src = 'var s = "\\07"; // octal\n/* block */\nvar t = 2;\n';
    expect(countCodeLines(src)).toEqual({ lines: 2, parsed: true });
  });

  it('falls back to the raw count (the upper bound) when neither goal tokenizes', () => {
    const src = '// comment\nvar a = 1;\n@@ not js\n';
    expect(countCodeLines(src)).toEqual({ lines: 3, parsed: false });
  });
});

describe('codeLineMask', () => {
  it('masks JS comments by tokenizing the whole post-image', () => {
    const src = ['/*', ' * starts a block', ' */', 'const a = 1;'].join('\n');
    expect(codeLineMask('x.sys.mjs', src)).toEqual({
      code: [false, false, false, true],
      parsed: true,
    });
  });

  it('counts every non-blank line of an untokenizable JS file and says so', () => {
    expect(codeLineMask('x.js', '// c\n@@\n\n')).toEqual({
      code: [true, true, false, false],
      parsed: false,
    });
  });

  it('masks CSS comments and Furnace fragment expansions', () => {
    const css = [
      '/* header */',
      ':host {',
      '/* @fireforge-include shared.css */',
      '@keyframes spin {}',
      '/* @fireforge-end-include shared.css */',
      '  color: red;',
      '}',
    ].join('\n');
    expect(codeLineMask('w.css', css).code).toEqual([false, true, false, false, false, true, true]);
  });

  it('masks markup comments', () => {
    const html = ['<!-- a', 'b -->', '<div></div>', '<!-- unclosed', 'x'].join('\n');
    expect(codeLineMask('a.xhtml', html).code).toEqual([false, false, true, false, false]);
  });

  it('masks whole-line hash comments in manifests and Fluent', () => {
    expect(codeLineMask('browser/jar.mn', '# c\n  content/x.js (x.js)\n').code).toEqual([
      false,
      true,
      false,
    ]);
    expect(codeLineMask('a/moz.build', '# c\nDIRS += ["x"]  # trailing\n').code).toEqual([
      false,
      true,
      false,
    ]);
    expect(codeLineMask('en-US/x.ftl', '## group\nkey = Value\n').code).toEqual([
      false,
      true,
      false,
    ]);
    expect(codeLineMask('mozconfig', '# c\nac_add_options --x').code).toEqual([false, true]);
  });

  it('honours ; in ini and package manifests and ! in properties', () => {
    expect(
      codeLineMask('browser/installer/package-manifest.in', '; c\n#ifdef X\n@BINPATH@/x\n').code
    ).toEqual([false, false, true, false]);
    expect(codeLineMask('a.ini', '; c\n[x]\n').code).toEqual([false, true, false]);
    expect(codeLineMask('a.properties', '! c\n# c\nk=v').code).toEqual([false, false, true]);
  });

  it('counts every non-blank line of any other file kind', () => {
    expect(codeLineMask('a.json', '{\n\n  "a": 1 # not a comment\n}').code).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });
});
