// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../../errors/base.js';
import { parseShare, resolveAddEntries } from '../lint-ignore-from.js';

describe('parseShare', () => {
  it('accepts the two shares and refuses anything else', () => {
    expect(parseShare('test')).toBe('test');
    expect(parseShare('product')).toBe('product');
    expect(() => parseShare('docs')).toThrow(InvalidArgumentError);
  });
});

describe('resolveAddEntries', () => {
  it('mixes per-entry and --max ceilings', () => {
    expect(
      resolveAddEntries(['file-too-large=900', 'large-patch-files'], { max: 12, reason: 'r' })
    ).toEqual([
      { rule: 'file-too-large', max: 900, reason: 'r' },
      { rule: 'large-patch-files', max: 12, reason: 'r' },
    ]);
  });

  it('keeps plain IDs bare when no ceiling is asked for', () => {
    expect(resolveAddEntries(['a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('refuses a duplicate rule in one call', () => {
    expect(() =>
      resolveAddEntries(['file-too-large=1', 'file-too-large=2'], { reason: 'r' })
    ).toThrow(/more than once/);
  });
});
