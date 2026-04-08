// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

import { warn } from '../../utils/logger.js';
import {
  consumeParserFallbackEvents,
  peekParserFallbackEvents,
  withParserFallback,
} from '../parser-fallback.js';

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

  it('returns fallback result with usedFallback=true when primary throws', () => {
    const result = withParserFallback(
      () => {
        throw new Error('parse failed');
      },
      () => 'fallback-value',
      'test-file.js'
    );

    expect(result.value).toBe('fallback-value');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('parse failed');
    expect(peekParserFallbackEvents()).toEqual([
      { context: 'test-file.js', reason: 'parse failed' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
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

  it('consumes fallback events so command layers can report them once', () => {
    withParserFallback(
      () => {
        throw new Error('first failure');
      },
      () => 'fallback-1',
      'first.js'
    );
    withParserFallback(
      () => {
        throw new Error('second failure');
      },
      () => 'fallback-2',
      'second.js'
    );

    expect(consumeParserFallbackEvents()).toEqual([
      { context: 'first.js', reason: 'first failure' },
      { context: 'second.js', reason: 'second failure' },
    ]);
    expect(peekParserFallbackEvents()).toEqual([]);
  });
});
