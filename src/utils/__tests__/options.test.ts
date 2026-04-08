// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { pickDefined } from '../options.js';

describe('pickDefined', () => {
  it('strips undefined values', () => {
    const result = pickDefined({ a: 1, b: undefined, c: 'hello' });
    expect(result).toEqual({ a: 1, c: 'hello' });
    expect('b' in result).toBe(false);
  });

  it('keeps falsy non-undefined values (false, 0, empty string, null)', () => {
    const result = pickDefined({ a: false, b: 0, c: '', d: null });
    expect(result).toEqual({ a: false, b: 0, c: '', d: null });
  });

  it('returns empty object when all values are undefined', () => {
    const result = pickDefined({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });

  it('returns empty object for empty input', () => {
    const result = pickDefined({});
    expect(result).toEqual({});
  });

  it('preserves all values when none are undefined', () => {
    const result = pickDefined({ x: 1, y: 'two', z: true });
    expect(result).toEqual({ x: 1, y: 'two', z: true });
  });
});
