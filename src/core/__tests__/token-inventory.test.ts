// SPDX-License-Identifier: EUPL-1.2
/**
 * The read half of token management. `token add` refuses an unknown
 * `--category`, and until 0.46.0 nothing reported the ones a project has —
 * so the inventory walk must agree with the writer about what a banner is
 * and which block owns a declaration, or the report sends an author to a
 * section `token add` will not write into.
 */
import { describe, expect, it } from 'vitest';

import { collectTokenBlockValues, collectTokenInventory } from '../token-inventory.js';

const TOKENS_CSS = `/* Design tokens */
:root {
  --loose-token: 1px;

  /* = Colors = */
  --mybrowser-canvas: #fff;
  --mybrowser-ink: #111;

  /* ============
   * Spacing
   * ============ */
  --mybrowser-gap: 8px;

  /* = Empty Section = */
}

@media (prefers-color-scheme: dark) {
  :root {
    --mybrowser-canvas: #000;
  }
}

:root[data-skin=precision] {
  --mybrowser-canvas: #eee;
}
`.split('\n');

describe('collectTokenInventory', () => {
  it('groups base :root tokens under the banner above them, in file order', () => {
    const groups = collectTokenInventory(TOKENS_CSS);
    expect(groups.map((g) => g.category)).toEqual([null, 'Colors', 'Spacing', 'Empty Section']);
    expect(groups[1]?.tokens.map((t) => t.name)).toEqual(['--mybrowser-canvas', '--mybrowser-ink']);
    expect(groups[2]?.tokens.map((t) => t.value)).toEqual(['8px']);
  });

  it('keeps a declaration that sits above the first banner rather than dropping it', () => {
    // A hand-edited file really has these, and reporting nothing would make
    // the token look undeclared to anyone reading `token list`.
    const groups = collectTokenInventory(TOKENS_CSS);
    expect(groups[0]).toEqual({
      category: null,
      tokens: [{ name: '--loose-token', line: 3, value: '1px' }],
    });
  });

  it('keeps a banner that declares no tokens — token add still accepts it', () => {
    const groups = collectTokenInventory(TOKENS_CSS);
    expect(groups.at(-1)).toEqual({ category: 'Empty Section', tokens: [] });
  });

  it('never reports the dark or variant mirrors as base declarations', () => {
    // They mirror the base declaration rather than owning it; listing them
    // would report --mybrowser-canvas three times, twice under no category.
    const canvasEntries = collectTokenInventory(TOKENS_CSS)
      .flatMap((g) => g.tokens)
      .filter((t) => t.name === '--mybrowser-canvas');
    expect(canvasEntries).toHaveLength(1);
  });

  it('ignores declarations inside comments', () => {
    const lines = [':root {', '  /* --commented: 1px; */', '  --real: 2px;', '}'];
    expect(collectTokenInventory(lines)[0]?.tokens.map((t) => t.name)).toEqual(['--real']);
  });

  it('returns nothing when the file has no :root block', () => {
    expect(collectTokenInventory(['.foo { color: red; }'])).toEqual([]);
  });
});

describe('collectTokenBlockValues', () => {
  it('reports every declaring block with its selector trail', () => {
    expect(collectTokenBlockValues(TOKENS_CSS, '--mybrowser-canvas')).toEqual([
      { block: ':root', value: '#fff', line: 6 },
      {
        block: '@media (prefers-color-scheme: dark) > :root',
        value: '#000',
        line: 19,
      },
      { block: ':root[data-skin=precision]', value: '#eee', line: 24 },
    ]);
  });

  it('matches the name exactly', () => {
    // `--canvas` must not match `--mybrowser-canvas`.
    expect(collectTokenBlockValues(TOKENS_CSS, '--canvas')).toEqual([]);
  });
});
