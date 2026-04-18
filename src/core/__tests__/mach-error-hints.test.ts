// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { explainMachError, MACH_ERROR_HINTS } from '../mach-error-hints.js';

describe('explainMachError', () => {
  it('returns an empty array for empty or unknown stderr', () => {
    expect(explainMachError('')).toEqual([]);
    expect(explainMachError('some unrelated build output')).toEqual([]);
  });

  it('surfaces the preprocessor hint for the JS_PREFERENCE_PP_FILES trap', () => {
    const stderr = [
      'mozbuild.preprocessor.Preprocessor.Error: (',
      "'mybrowser.js', None, 'no preprocessor directives found', None",
      ')',
    ].join('\n');
    const hints = explainMachError(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('JS_PREFERENCE_PP_FILES');
    expect(hints[0]).toContain('JS_PREFERENCE_FILES instead');
  });

  it('deduplicates hints when the same pattern matches multiple times', () => {
    const stderr = [
      "mozbuild.preprocessor.Preprocessor.Error: ('a.js', None, 'no preprocessor directives found', None)",
      "mozbuild.preprocessor.Preprocessor.Error: ('b.js', None, 'no preprocessor directives found', None)",
    ].join('\n');
    const hints = explainMachError(stderr);
    expect(hints).toHaveLength(1);
  });

  it('exposes its pattern table for inspection', () => {
    expect(MACH_ERROR_HINTS.length).toBeGreaterThan(0);
    for (const entry of MACH_ERROR_HINTS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.hint).toBe('string');
      expect(entry.hint.length).toBeGreaterThan(20);
    }
  });
});
