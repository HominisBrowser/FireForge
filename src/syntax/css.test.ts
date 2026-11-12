// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  blankCssComments,
  cssVarReferences,
  customProperties,
  foreignVariables,
  parseCss,
  rawColors,
} from './css.js';

describe('parseCss', () => {
  it('reads blocks, nesting and custom-property declarations with their lines', () => {
    const sheet = parseCss(
      ':root {\n  --a: 1;\n  --b: calc(1px + 2px); /* c */\n}\n@media (x) {\n  :root {\n    --a: 2;\n  }\n}\n'
    );
    expect(sheet.blocks.map((block) => [block.selector, block.open, block.close])).toEqual([
      [':root', 0, 3],
      ['@media (x)', 4, 8],
      [':root', 5, 7],
    ]);
    expect(sheet.declarations.map((d) => [d.name, d.value, d.line, d.block.selector])).toEqual([
      ['--a', '1', 1, ':root'],
      ['--b', 'calc(1px + 2px)', 2, ':root'],
      ['--a', '2', 6, ':root'],
    ]);
    expect(sheet.blocks[2]?.parent?.selector).toBe('@media (x)');
  });

  it('ignores braces, semicolons and declarations in comments and strings', () => {
    const sheet = parseCss(
      ':root {\n  /* --x: 1; } */\n  --a: "}{;"; /* { */\n  --b: url("a;b"); \n}\n--c: 3;\n'
    );
    expect(sheet.blocks).toHaveLength(1);
    expect(sheet.blocks[0]?.close).toBe(4);
    expect(sheet.declarations.map((d) => d.name)).toEqual(['--a', '--b']);
    expect(sheet.declarations[0]?.value).toBe('"}{;"');
  });

  it('does not end a declaration at a semicolon inside parentheses', () => {
    const sheet = parseCss(':root { --img: url(data:image/png;base64,AAA=); --next: 1; }\n');
    expect(sheet.declarations.map((d) => [d.name, d.value])).toEqual([
      ['--img', 'url(data:image/png;base64,AAA=)'],
      ['--next', '1'],
    ]);
  });

  it('reports a block that never closes and keeps what it read', () => {
    const sheet = parseCss(':root {\n  --a: 1;\n');
    expect(sheet.blocks[0]?.close).toBe(-1);
    expect(sheet.declarations).toHaveLength(1);
  });

  it('keeps comment text and positions', () => {
    const sheet = parseCss('/* one */\n/*\n * two\n */\n');
    expect(sheet.comments).toEqual([
      { text: ' one ', start: 0, end: 0 },
      { text: '\n * two\n ', start: 1, end: 3 },
    ]);
  });

  it('reads a long line of repeated openers', () => {
    expect(parseCss(`${'/*'.repeat(200_000)}\n${':root['.repeat(100_000)}`).blocks).toEqual([]);
    expect(parseCss(`${'"'.repeat(200_000)}\n`).declarations).toEqual([]);
  });
});

describe('declarations', () => {
  it('reads properties and custom properties, never a selector with a pseudo-class', () => {
    const sheet = parseCss(
      'a:hover,\nb { color: red; --x: 1 /* c */ }\n.c { &:focus { gap: 0 } }\n'
    );
    expect(sheet.declarations.map((d) => [d.name, d.value, d.line])).toEqual([
      ['color', 'red', 1],
      ['--x', '1', 1],
      ['gap', '0', 2],
    ]);
    expect(customProperties(sheet).map((d) => d.name)).toEqual(['--x']);
  });
});

describe('blankCssComments', () => {
  it('keeps newlines, runs an unclosed comment to the end and leaves strings alone', () => {
    expect(blankCssComments('a /* b\nc */ d /* e')).toBe('a     \n     d     ');
    expect(blankCssComments('a { content: "/*" } b')).toBe('a { content: "/*" } b');
  });
});

describe('cssVarReferences and foreignVariables', () => {
  it('reads references outside comments and strings, with their fallbacks', () => {
    const sheet = parseCss(
      'a {\n  color: var(--b, red); /* var(--c) */\n  content: "var(--d)";\n  gap: var( --e);\n}\n'
    );
    expect(cssVarReferences(sheet)).toEqual([
      { name: '--b', line: 1, fallback: true },
      { name: '--e', line: 3, fallback: false },
    ]);
  });

  it('leaves out prefixed, accepted and locally declared properties', () => {
    const sheet = parseCss(
      'a { --own: 1; color: var(--own) var(--mine-x) var(--ok) var(--x) var(--x); }'
    );
    expect(foreignVariables(sheet, '--mine-', new Set(['--ok'])).map((ref) => ref.name)).toEqual([
      '--x',
      '--x',
    ]);
  });
});

describe('rawColors', () => {
  it.each([
    ['a { color: #fff; }', ['#fff']],
    [
      'a { color: #A1B2C3D4; background: rgb(1 2 3) hsla(1, 2%, 3%, 0.5); }',
      ['#A1B2C3D4', 'rgb(', 'hsla('],
    ],
    ['#add-button, #fade-in, #bad { margin: 0 }', []],
    ['a { background: url("x.svg#fab"); filter: url(#bee); content: "#fff"; }', []],
    ['/* #fff */ a { color: var(--x); }', []],
    ['a { --accent: #123456; }', ['#123456']],
    ['a { grid-area: c#d; }', []],
  ])('%j -> %j', (css, colors) => {
    expect(rawColors(parseCss(css)).map((color) => color.text)).toEqual(colors);
  });

  it('reports the line of a colour in a value spanning lines', () => {
    expect(rawColors(parseCss('a {\n  border: 1px solid\n    #abc;\n}\n'))).toEqual([
      { line: 2, text: '#abc' },
    ]);
  });
});
