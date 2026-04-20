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

  it('surfaces the packager NoneType hint when packager.py trips on None.open', () => {
    // Finding #12: `mach package` dereferences a None sink inside
    // packager.py when the obj-*/dist/ tree is incomplete. The hint
    // explicitly points at running a full `fireforge build` before
    // `fireforge package`, which is the real-world recovery path.
    const stderr = [
      'Traceback (most recent call last):',
      '  File "/engine/python/mozbuild/mozpack/packager.py", line 241, in package_fastload',
      '    zip = self.target.open(path, "wb")',
      "AttributeError: 'NoneType' object has no attribute 'open'",
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints[0]).toMatch(/NoneType\.open.*packager\.py/);
    expect(hints[0]).toContain('fireforge build');
  });

  it('matches the NoneType hint even when the traceback order is reversed', () => {
    // Some mach runs surface the `AttributeError` line before the
    // traceback frame that names packager.py. The regex needs to cope
    // with both orderings so the hint fires regardless.
    const stderr = [
      "AttributeError: 'NoneType' object has no attribute 'open'",
      'File "/engine/python/mozbuild/mozpack/packager.py", line 299, in sink',
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints[0]).toMatch(/NoneType\.open/);
  });

  it('does NOT fire the NoneType hint on unrelated AttributeErrors', () => {
    // Keep the pattern narrow so unrelated NoneType errors elsewhere in
    // mach (e.g. a preprocessor pass) don't train operators to ignore
    // the hint. Maintaining this negative case also pins the branch
    // count for the 100/95/100 coverage threshold.
    const stderr = [
      'Traceback (most recent call last):',
      '  File "/engine/python/mozbuild/mozbuild/config.py", line 42, in load',
      "AttributeError: 'NoneType' object has no attribute 'keys'",
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints).toEqual([]);
  });
});
