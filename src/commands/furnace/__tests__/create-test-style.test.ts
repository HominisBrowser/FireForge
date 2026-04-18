// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { resolveTestStyle } from '../create.js';

describe('resolveTestStyle', () => {
  it('returns "none" when no test flags are set', () => {
    expect(resolveTestStyle({})).toBe('none');
  });

  it('defaults --with-tests alone to mochikit (the new non-tabbrowser-safe default)', () => {
    expect(resolveTestStyle({ withTests: true })).toBe('mochikit');
  });

  it('treats --xpcshell alone as xpcshell for backwards compat', () => {
    expect(resolveTestStyle({ xpcshell: true })).toBe('xpcshell');
  });

  it('honors an explicit --test-style when provided', () => {
    expect(resolveTestStyle({ withTests: true, testStyle: 'browser-chrome' })).toBe(
      'browser-chrome'
    );
    expect(resolveTestStyle({ withTests: true, testStyle: 'xpcshell' })).toBe('xpcshell');
    expect(resolveTestStyle({ testStyle: 'mochikit' })).toBe('mochikit');
  });

  it('allows --xpcshell + --test-style=xpcshell (no conflict)', () => {
    expect(resolveTestStyle({ xpcshell: true, testStyle: 'xpcshell' })).toBe('xpcshell');
  });

  it('throws on conflicting --xpcshell + --test-style=mochikit', () => {
    expect(() => resolveTestStyle({ xpcshell: true, testStyle: 'mochikit' })).toThrow(
      /cannot be combined/
    );
  });
});
