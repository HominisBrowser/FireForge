// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { maskCssComments } from '../patch-lint-css.js';

describe('maskCssComments', () => {
  it('masks closed comments with spaces and keeps newlines', () => {
    expect(maskCssComments('a/*x\ny*/b')).toBe('a   \n   b');
  });

  it('does not let a closer overlap its opener', () => {
    expect(maskCssComments('b/*/c*/d')).toBe('b      d');
  });

  it('masks an unclosed trailing comment to EOF', () => {
    expect(maskCssComments('a{}\n/*open\nz')).toBe('a{}\n      \n ');
  });

  it('returns comment-free source unchanged', () => {
    expect(maskCssComments('a { color: red; }\n')).toBe('a { color: red; }\n');
  });

  it('stays linear on many unclosed openers', () => {
    // Regression for a lazy-regex mask that retried from every `/*` to EOF.
    const source = '/*' + 'a/*'.repeat(200_000);
    const started = performance.now();
    expect(maskCssComments(source)).toBe(' '.repeat(source.length));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
