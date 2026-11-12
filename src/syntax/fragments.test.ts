// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { fragmentEnd, fragmentExpansions, fragmentInclude, fragmentIncludes } from './fragments.js';

describe('fragment markers', () => {
  it('reads an include directive on its own line only', () => {
    expect(fragmentInclude('  /* @fireforge-include base/button.css */ ')).toBe('base/button.css');
    expect(fragmentInclude('a { } /* @fireforge-include x.css */')).toBeUndefined();
    expect(fragmentInclude(fragmentEnd('x.css'))).toBeUndefined();
  });

  it('lists each included fragment once, in order', () => {
    const css = [
      '/* @fireforge-include b.css */',
      '/* @fireforge-include a.css */',
      '/* @fireforge-include b.css */',
    ];
    expect(fragmentIncludes(css.join('\n'))).toEqual(['b.css', 'a.css']);
  });

  it('pairs a directive with its own end marker and leaves an unfenced one out', () => {
    const lines = [
      '/* @fireforge-include a.css */',
      '.a {}',
      fragmentEnd('a.css'),
      '/* @fireforge-include b.css */',
      fragmentEnd('c.css'),
      '/* @fireforge-include c.css */',
      fragmentEnd('c.css'),
    ];
    expect(fragmentExpansions(lines)).toEqual([
      [0, 2],
      [5, 6],
    ]);
  });
});
