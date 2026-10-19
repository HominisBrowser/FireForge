// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { parsePatchLintTokenScales } from '../config-validate-token-scales.js';

describe('parsePatchLintTokenScales', () => {
  it('accepts a prefix list and the calc, exclude and floor keys', () => {
    const scale = {
      properties: ['gap'],
      prefix: ['--x-space-', '--x-gap-'],
      allowLiterals: ['0'],
      allowInCalc: ['2'],
      offsetCap: 2,
      exclude: ['**/vendor/*.css'],
      minFiles: 3,
    };
    expect(parsePatchLintTokenScales([scale])).toEqual([scale]);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['an unknown key', { prefixes: [] }, /has unknown key "prefixes"/],
    ['an empty prefix list', { prefix: [] }, /\.prefix" must be a custom-property prefix/],
    ['a malformed listed prefix', { prefix: ['--a-', 'b'] }, /\.prefix" must be/],
    ['a negative offsetCap', { offsetCap: -1 }, /offsetCap" must be a non-negative number/],
    ['a zero minFiles', { minFiles: 0 }, /minFiles" must be a positive integer/],
    ['a fractional minFiles', { minFiles: 1.5 }, /minFiles" must be a positive integer/],
    ['a non-list exclude', { exclude: 'x' }, /exclude" must be an array/],
  ])('refuses %s', (_label, extra, message) => {
    expect(() =>
      parsePatchLintTokenScales([{ properties: ['gap'], prefix: '--x-space-', ...extra }])
    ).toThrow(message);
  });
});
