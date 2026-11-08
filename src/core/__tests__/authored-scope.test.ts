// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import { resolveSourceScope } from '../authored-scope.js';

const KNOWN = ['m/a.sys.mjs', 'm/b.sys.mjs', 'm/sub/c.sys.mjs', 'm2/d.sys.mjs', 'x/style.css'];

describe('resolveSourceScope', () => {
  it('expands a directory to the files beneath it, not to sibling prefixes', () => {
    expect([...resolveSourceScope(KNOWN, ['m'], '--source-files')].sort()).toEqual([
      'm/a.sys.mjs',
      'm/b.sys.mjs',
      'm/sub/c.sys.mjs',
    ]);
    expect([...resolveSourceScope(KNOWN, ['m/'], '--source-files')]).toHaveLength(3);
  });

  it('accepts an exact file and non-script files that exist', () => {
    expect([
      ...resolveSourceScope(KNOWN, ['m/a.sys.mjs', 'x/style.css'], '--source-files'),
    ]).toEqual(['m/a.sys.mjs', 'x/style.css']);
  });

  it('refuses an entry that matches nothing, naming it', () => {
    expect(() =>
      resolveSourceScope(KNOWN, ['m/a.sys.mjs', 'm/typo.sys.mjs'], '--source-files')
    ).toThrow(InvalidArgumentError);
    expect(() => resolveSourceScope(KNOWN, ['mm'], '--source-files')).toThrow(
      /"mm" matches no file/
    );
  });
});
