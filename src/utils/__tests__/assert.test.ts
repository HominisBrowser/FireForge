// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it, vi } from 'vitest';

import { InternalInvariantError } from '../../errors/base.js';
import { ExitCode } from '../../errors/codes.js';
import { assert, assertDefined, expectDefined } from '../assert.js';

describe('assert', () => {
  it('returns without throwing when the condition is truthy', () => {
    expect(() => {
      assert(1, 'always true');
    }).not.toThrow();
  });

  it('throws InternalInvariantError when the condition is falsy', () => {
    expect(() => {
      assert(0, 'journal registered before first mutation');
    }).toThrow(InternalInvariantError);
  });

  it('carries the INTERNAL_ERROR exit code', () => {
    try {
      assert(false, 'lock held before write');
      expect.unreachable('assert should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InternalInvariantError);
      expect((error as InternalInvariantError).code).toBe(ExitCode.INTERNAL_ERROR);
    }
  });

  it('names the invariant in the message and the bug in the userMessage', () => {
    try {
      assert(false, 'lock held before write');
      expect.unreachable('assert should have thrown');
    } catch (error: unknown) {
      const invariantError = error as InternalInvariantError;
      expect(invariantError.message).toBe('lock held before write');
      expect(invariantError.userMessage).toContain('lock held before write');
      expect(invariantError.userMessage).toContain('bug in FireForge');
    }
  });

  it('does not build a thunk message on the passing path', () => {
    const message = vi.fn(() => 'never built');

    assert(true, message);

    expect(message).not.toHaveBeenCalled();
  });

  it('builds a thunk message on the failing path', () => {
    const message = vi.fn(() => 'built on failure');

    expect(() => {
      assert(false, message);
    }).toThrow('built on failure');
    expect(message).toHaveBeenCalledTimes(1);
  });
});

describe('assertDefined', () => {
  it('accepts present values, including falsy ones', () => {
    expect(() => {
      assertDefined(0, 'zero is present');
    }).not.toThrow();
    expect(() => {
      assertDefined('', 'empty string is present');
    }).not.toThrow();
    expect(() => {
      assertDefined(false, 'false is present');
    }).not.toThrow();
  });

  it('throws on undefined', () => {
    expect(() => {
      assertDefined(undefined, 'manifest row for the renumbered patch');
    }).toThrow(InternalInvariantError);
  });

  it('throws on null', () => {
    expect(() => {
      assertDefined(null, 'manifest row for the renumbered patch');
    }).toThrow(InternalInvariantError);
  });

  it('narrows the value for subsequent statements', () => {
    const value: string | undefined = 'present';

    assertDefined(value, 'value is present');

    expect(value.length).toBe(7);
  });

  it('does not build a thunk message on the passing path', () => {
    const message = vi.fn(() => 'never built');

    assertDefined('present', message);

    expect(message).not.toHaveBeenCalled();
  });
});

describe('expectDefined', () => {
  it('returns the value when present', () => {
    expect(expectDefined('present', 'value is present')).toBe('present');
    expect(expectDefined(0, 'zero is present')).toBe(0);
  });

  it('throws on undefined', () => {
    expect(() => expectDefined(undefined, 'line at the hunk cursor')).toThrow(
      InternalInvariantError
    );
  });

  it('throws on null', () => {
    expect(() => expectDefined(null, 'line at the hunk cursor')).toThrow(InternalInvariantError);
  });

  it('narrows away null and undefined in the return type', () => {
    const lines: (string | undefined)[] = ['first'];

    expect(expectDefined(lines[0], 'first line').length).toBe(5);
  });

  it('does not build a thunk message on the passing path', () => {
    const message = vi.fn(() => 'never built');

    expectDefined('present', message);

    expect(message).not.toHaveBeenCalled();
  });
});
