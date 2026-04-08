// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { toError } from '../errors.js';

describe('toError', () => {
  it('returns Error instances unchanged', () => {
    const error = new Error('boom');

    expect(toError(error)).toBe(error);
  });

  it('wraps objects with a string message and preserves the original cause', () => {
    const original = { message: 'object failure', code: 'EFAIL' };
    const error = toError(original);

    expect(error.message).toBe('object failure');
    expect(error.cause).toBe(original);
  });

  it('wraps string throwables', () => {
    const error = toError('plain failure');

    expect(error.message).toBe('plain failure');
    expect(error.cause).toBe('plain failure');
  });

  it('stringifies non-string primitives', () => {
    const error = toError(404);

    expect(error.message).toBe('404');
    expect(error.cause).toBe(404);
  });
});
