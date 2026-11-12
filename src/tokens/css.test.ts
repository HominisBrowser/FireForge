// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { defined } from '../kernel/errors.js';
import { type CssBlock, parseCss } from '../syntax/index.js';
import { appendToBlock, baseRoot, declarationsIn, isolateClose } from './css.js';

/** The base block of a stylesheet that has one. */
function rootOf(text: string): CssBlock {
  return defined(baseRoot(parseCss(text)), 'the stylesheet has a :root block');
}

describe('editing blocks', () => {
  it('finds the base :root among top-level rules only', () => {
    const sheet = parseCss(
      '@media (x) { :root { --a: 1; } }\n:root, :host {\n  --b: 2;\n}\n:root[a] { --c: 3; }\n'
    );
    const root = baseRoot(sheet);
    expect(root?.open).toBe(1);
    expect(declarationsIn(sheet, defined(root, 'a root')).map((d) => d.name)).toEqual(['--b']);
  });

  it('appends after the last non-blank line of the block', () => {
    const lines = ':root {\n  --a: 1;\n\n}\n'.split('\n');
    appendToBlock(lines, rootOf(lines.join('\n')), ['  --b: 2;']);
    expect(lines.join('\n')).toBe(':root {\n  --a: 1;\n  --b: 2;\n\n}\n');
  });

  it('appends into an empty block and into a block closed on its last declaration', () => {
    const empty = ':root {\n}\n'.split('\n');
    appendToBlock(empty, rootOf(empty.join('\n')), ['  --a: 1;']);
    expect(empty.join('\n')).toBe(':root {\n  --a: 1;\n}\n');
    const tight = ':root {\n  --a: 1; }\n'.split('\n');
    appendToBlock(tight, rootOf(tight.join('\n')), ['  --b: 2;']);
    expect(tight.join('\n')).toBe(':root {\n  --a: 1;\n  --b: 2;\n}\n');
  });

  it('splits a block written on one line', () => {
    const lines = ['  :root { --a: 1; }'];
    const close = isolateClose(lines, rootOf(lines.join('\n')));
    expect(lines).toEqual(['  :root {', '    --a: 1;', '  }']);
    expect(close).toBe(2);
    const bare = [':root {}'];
    appendToBlock(bare, rootOf(bare.join('\n')), ['  --b: 2;']);
    expect(bare).toEqual([':root {', '  --b: 2;', '}']);
  });
});
