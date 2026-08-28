// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { warn } from '../../utils/logger.js';
import { consumeParserFallbackEvents, withParserFallback } from '../parser-fallback.js';

describe('withParserFallback', () => {
  beforeEach(() => {
    consumeParserFallbackEvents();
  });

  it('returns primary result with usedFallback=false on success', () => {
    const result = withParserFallback(
      () => 'primary-value',
      () => 'fallback-value',
      'test-file.js'
    );

    expect(result.value).toBe('primary-value');
    expect(result.usedFallback).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-throws when rethrowIf predicate returns true', () => {
    class SpecialError extends Error {}

    expect(() =>
      withParserFallback(
        () => {
          throw new SpecialError('domain error');
        },
        () => 'fallback-value',
        'test-file.js',
        (err) => err instanceof SpecialError
      )
    ).toThrow(SpecialError);
  });

  it('falls back normally when rethrowIf predicate returns false', () => {
    const result = withParserFallback(
      () => {
        throw new TypeError('wrong type');
      },
      () => 'fallback-value',
      'test-file.js',
      (err) => err instanceof SyntaxError
    );

    expect(result.value).toBe('fallback-value');
    expect(result.usedFallback).toBe(true);
  });
});
