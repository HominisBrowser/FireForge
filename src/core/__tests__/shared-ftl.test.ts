// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateSharedFtl } from '../shared-ftl.js';

describe('validateSharedFtl', () => {
  it('accepts a plain relative path and returns it trimmed', () => {
    const result = validateSharedFtl('  browser/mybrowser-dock.ftl  ', { localized: true });
    expect(result).toEqual({ ok: true, value: 'browser/mybrowser-dock.ftl' });
  });

  it('rejects a non-string value', () => {
    const result = validateSharedFtl(42, { localized: true });
    expect(result).toEqual({ ok: false, reason: 'must be a string when set' });
  });

  it('rejects undefined', () => {
    const result = validateSharedFtl(undefined, { localized: true });
    expect(result).toEqual({ ok: false, reason: 'must be a string when set' });
  });

  it('rejects an empty string', () => {
    const result = validateSharedFtl('', { localized: true });
    expect(result).toEqual({ ok: false, reason: 'must not be empty' });
  });

  it('rejects a whitespace-only string', () => {
    const result = validateSharedFtl('   ', { localized: true });
    expect(result).toEqual({ ok: false, reason: 'must not be empty' });
  });

  it.each([
    ['backtick', 'browser/`evil`.ftl'],
    ['backslash', 'browser\\dock.ftl'],
    ['template expression opener', 'browser/${injected}.ftl'],
  ])('rejects a path containing a %s', (_label, value) => {
    const result = validateSharedFtl(value, { localized: true });
    expect(result).toEqual({
      ok: false,
      reason: 'must not contain backticks, backslashes, or ${ (would break the generated .mjs)',
    });
  });

  it('rejects when the component is not localized', () => {
    const result = validateSharedFtl('browser/mybrowser-dock.ftl', { localized: false });
    expect(result).toEqual({ ok: false, reason: 'requires localized to be true' });
  });
});
