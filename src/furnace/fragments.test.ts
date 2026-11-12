// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { useTempDir, writeTree } from '../testing/temp.js';
import { expandFragments } from './fragments.js';

const dir = useTempDir();

describe('expandFragments', () => {
  it('leaves a stylesheet without directives unchanged', async () => {
    expect(await expandFragments(':host { gap: 0; }\n', dir())).toBe(':host { gap: 0; }\n');
  });

  it('inlines each fragment after its directive and fences it, idempotently', async () => {
    const shared = dir();
    await writeTree(shared, { 'base.css': ':host { display: block; }\n' });
    const source = '/* @fireforge-include base.css */\n.a { gap: 0; }\n';
    const once = await expandFragments(source, shared);
    expect(once).toBe(
      [
        '/* @fireforge-include base.css */',
        ':host { display: block; }',
        '/* @fireforge-end-include base.css */',
        '.a { gap: 0; }',
        '',
      ].join('\n')
    );
    expect(await expandFragments(once, shared)).toBe(once);
  });

  it('replaces a stale expansion with the fragment as it is now', async () => {
    const shared = dir();
    await writeTree(shared, { 'base.css': ':host { display: grid; }\n' });
    const stale =
      '/* @fireforge-include base.css */\n:host { display: block; }\n/* @fireforge-end-include base.css */\n';
    expect(await expandFragments(stale, shared)).toContain(':host { display: grid; }');
    expect(await expandFragments(stale, shared)).not.toContain('display: block');
  });

  it('refuses a missing fragment and a fragment that includes another', async () => {
    const shared = dir();
    await writeTree(shared, { 'outer.css': '/* @fireforge-include inner.css */\n' });
    await expect(
      expandFragments('/* @fireforge-include gone.css */\n', shared)
    ).rejects.toMatchObject({
      code: 'furnace-fragment-missing',
      message: /"gone\.css" does not exist/,
    });
    await expect(expandFragments('/* @fireforge-include outer.css */\n', shared)).rejects.toThrow(
      /fragments do not nest/
    );
  });
});
