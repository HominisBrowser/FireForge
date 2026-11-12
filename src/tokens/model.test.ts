// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { parseCss } from '../syntax/index.js';
import { TOKENS_CSS } from '../testing/tokens.js';
import { categories, declaredTokens, listTokens, tokenValues } from './model.js';

const css = (...rows: string[]): string => `${rows.join('\n')}\n`;

describe('categories', () => {
  it('reads single-line banners and ends a section at the next banner', () => {
    const found = categories(parseCss(TOKENS_CSS));
    expect(found.map((c) => [c.name, c.line, c.end])).toEqual([
      ['Colors', 3, 8],
      ['Spacing', 8, 10],
    ]);
  });

  it('reads boxed banners by their first text line', () => {
    const sheet = parseCss(
      css(':root {', '  /* ======', '   * Boxed One', '   * ====== */', '  --a: 1;', '}')
    );
    expect(categories(sheet).map((c) => c.name)).toEqual(['Boxed One']);
  });

  it('keeps a decorative rule under its banner and ends the section when it follows tokens', () => {
    const sheet = parseCss(
      css(
        ':root {',
        '  /* = One = */',
        '  /* ======= */',
        '  --a: 1;',
        '  /* ======= */',
        '  --b: 2;',
        '}'
      )
    );
    const [one] = categories(sheet);
    expect(one).toMatchObject({ name: 'One', line: 1, end: 4 });
  });

  it('matches banner names exactly, so a longer banner is another category', () => {
    const names = categories(
      parseCss(css(':root {', '  /* = Colors — Canvas = */', '  /* = Colors = */', '}'))
    ).map((c) => c.name);
    expect(names).toEqual(['Colors — Canvas', 'Colors']);
  });

  it('is empty without a closed base block, and ignores banners outside it', () => {
    expect(categories(parseCss('/* = A = */\n:root {\n'))).toEqual([]);
    expect(categories(parseCss('/* = A = */\n:root {\n}\n'))).toEqual([]);
  });
});

describe('listTokens', () => {
  it('groups the base block by category, in file order, keeping empty categories', () => {
    const groups = listTokens(
      css(':root {', '  --loose: 1;', '  /* = Full = */', '  --a: 2;', '  /* = Empty = */', '}')
    );
    expect(groups.map((g) => [g.category, g.tokens.map((t) => t.name)])).toEqual([
      [null, ['--loose']],
      ['Full', ['--a']],
      ['Empty', []],
    ]);
  });

  it('lists only the base block, with one-based lines and values', () => {
    const groups = listTokens(TOKENS_CSS);
    expect(groups).toEqual([
      {
        category: 'Colors',
        tokens: [
          { name: '--acme-ink', line: 6, value: '#111111' },
          { name: '--acme-paper', line: 7, value: 'light-dark(#ffffff, #222222)' },
        ],
      },
      { category: 'Spacing', tokens: [{ name: '--acme-gap', line: 10, value: '8px' }] },
    ]);
  });
});

describe('tokenValues and declaredTokens', () => {
  it('shows every declaration of a token with its enclosing selectors', () => {
    expect(tokenValues(TOKENS_CSS, '--acme-ink').map((v) => [v.block, v.value])).toEqual([
      [':root', '#111111'],
      ['@media (prefers-color-scheme: dark) > :root', '#eeeeee'],
      [':root[data-theme="dark"]', '#eeeeee'],
      [':root[data-theme="light"]:not([data-private])', '#111111'],
    ]);
    expect(tokenValues(TOKENS_CSS, '--acme-ink-x')).toEqual([]);
  });

  it('collects the names declared in any block, not names in comments or references', () => {
    expect([...declaredTokens(`/* --x: 1 */ a { color: var(--y); --z: 1; }`)]).toEqual(['--z']);
  });
});
