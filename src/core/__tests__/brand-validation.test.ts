// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import { validateBrandOverride } from '../brand-validation.js';

describe('validateBrandOverride', () => {
  it('allows missing and matching overrides', () => {
    expect(() => {
      validateBrandOverride('stable');
    }).not.toThrow();
    expect(() => {
      validateBrandOverride('stable', 'stable');
    }).not.toThrow();
  });

  it('throws an InvalidArgumentError for mismatched overrides', () => {
    const error = (() => {
      try {
        validateBrandOverride('stable', 'beta');
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as InvalidArgumentError).argument).toBe('brand');
    expect((error as InvalidArgumentError).message).toContain('Brand override "beta"');
  });
});
