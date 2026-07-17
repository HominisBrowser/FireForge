// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { pickDefined, resolveWaitLockSeconds } from '../options.js';

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

describe('resolveWaitLockSeconds', () => {
  it('returns undefined when the flag is absent', () => {
    expect(resolveWaitLockSeconds(undefined)).toBeUndefined();
  });

  it('maps the bare flag to the 60-second default', () => {
    expect(resolveWaitLockSeconds(true)).toBe(60);
  });

  it('parses an explicit seconds value', () => {
    expect(resolveWaitLockSeconds('120')).toBe(120);
  });

  it('passes through an already-parsed number', () => {
    expect(resolveWaitLockSeconds(45)).toBe(45);
  });

  it.each(['0', '3601', 'abc', '-5'])('rejects %s with the exact range message', (raw) => {
    expect(() => resolveWaitLockSeconds(raw)).toThrow(
      `--wait-lock must be an integer in 1..3600 (got "${raw}")`
    );
  });
});
