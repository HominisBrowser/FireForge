// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import {
  describePatchNameProblem,
  describeProductVersionIncompatibility,
  describeTokenNameProblem,
  FIREFOX_PRODUCTS,
  inferProductFromVersion,
  isArray,
  isBoolean,
  isJsonObject,
  isNumber,
  isObject,
  isString,
  isValidAppId,
  isValidFirefoxProduct,
  isValidFirefoxVersion,
  isValidProjectLicense,
  normalizePatchDisplayName,
  normalizeTokenName,
  parsePositiveIntegerFlag,
} from '../validation.js';

describe('type guards', () => {
  it('validates primitive and structured types', () => {
    expect(isString('hello')).toBe(true);
    expect(isString(42)).toBe(false);
    expect(isNumber(42)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(false);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean('false')).toBe(false);
    expect(isObject({ key: 'value' })).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject(['array'])).toBe(false);
    expect(isArray(['array'])).toBe(true);
    expect(isArray({ key: 'value' })).toBe(false);
  });

  it('narrows JSON values to JSON object nodes', () => {
    expect(isJsonObject({ key: 'value' })).toBe(true);
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject(['array'])).toBe(false);
    expect(isJsonObject('string')).toBe(false);
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe('parsePositiveIntegerFlag', () => {
  it('accepts canonical positive integer strings', () => {
    expect(parsePositiveIntegerFlag('--order', '1')).toBe(1);
    expect(parsePositiveIntegerFlag('--order', '42')).toBe(42);
    expect(parsePositiveIntegerFlag('--to', '1000')).toBe(1000);
  });

  it('rejects NaN, zero, negative, decimal, and leading-zero inputs', () => {
    for (const bad of ['foo', '', '0', '-1', '1.5', ' 1', '1 ', '01', '+1']) {
      expect(() => parsePositiveIntegerFlag('--order', bad)).toThrow(InvalidArgumentError);
    }
  });

  it('includes the flag name and the offending value in the error message', () => {
    try {
      parsePositiveIntegerFlag('--to', 'garbage');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as InvalidArgumentError).message).toContain('--to');
      expect((error as InvalidArgumentError).message).toContain('garbage');
      return;
    }
    throw new Error('expected parsePositiveIntegerFlag to throw');
  });
});

describe('firefox metadata validation', () => {
  it('accepts valid Firefox versions and rejects invalid ones', () => {
    expect(isValidFirefoxVersion('140.9.0')).toBe(true);
    expect(isValidFirefoxVersion('140.9.1')).toBe(true);
    expect(isValidFirefoxVersion('140.9.0esr')).toBe(true);
    expect(isValidFirefoxVersion('147.0b2')).toBe(true);
    expect(isValidFirefoxVersion('0.0')).toBe(false);
    expect(isValidFirefoxVersion('firefox')).toBe(false);
  });

  it('validates Firefox products and infers them from version strings', () => {
    expect(isValidFirefoxProduct('firefox')).toBe(true);
    expect(isValidFirefoxProduct('firefox-esr')).toBe(true);
    expect(isValidFirefoxProduct('firefox-beta')).toBe(true);
    expect(isValidFirefoxProduct('fennec')).toBe(false);

    expect(inferProductFromVersion('140.9.0esr')).toBe('firefox-esr');
    expect(inferProductFromVersion('147.0b1')).toBe('firefox-beta');
    expect(inferProductFromVersion('140.9.0')).toBeUndefined();
  });

  it('validates reverse-domain app ids', () => {
    expect(isValidAppId('org.example.browser')).toBe(true);
    expect(isValidAppId('browser')).toBe(false);
    expect(isValidAppId('Org.example.browser')).toBe(false);
  });
});

describe('project metadata validation', () => {
  it('validates supported project licenses', () => {
    expect(isValidProjectLicense('MPL-2.0')).toBe(true);
    expect(isValidProjectLicense('Apache-2.0')).toBe(false);
  });
});

describe('normalizeTokenName', () => {
  it('prepends -- to a bare name', () => {
    expect(normalizeTokenName('mybrowser-canvas-dot-size')).toBe('--mybrowser-canvas-dot-size');
  });

  it('does not double-prefix a name that already starts with --', () => {
    expect(normalizeTokenName('--mybrowser-canvas-dot-size')).toBe('--mybrowser-canvas-dot-size');
  });

  it('handles a single-segment name', () => {
    expect(normalizeTokenName('color')).toBe('--color');
  });

  it('handles an already-prefixed single-segment name', () => {
    expect(normalizeTokenName('--color')).toBe('--color');
  });
});

describe('describePatchNameProblem', () => {
  it('rejects empty names, long names, and unsupported characters', () => {
    expect(describePatchNameProblem('')).toBe('Name is required');
    expect(describePatchNameProblem('a'.repeat(51))).toBe('Name must be 50 characters or less');
    expect(describePatchNameProblem('bad/name')).toBe(
      'Name can only contain letters, numbers, hyphens, underscores, and spaces'
    );
  });

  it('accepts well-formed patch names', () => {
    expect(describePatchNameProblem('UI polish 01')).toBeUndefined();
    expect(describePatchNameProblem('privacy_hardening')).toBeUndefined();
  });
});

describe('describeProductVersionIncompatibility', () => {
  it.each([
    ['140.9.0esr', 'firefox-esr'],
    ['128.0.1esr', 'firefox-esr'],
    ['140.9.0', 'firefox'],
    ['140.9.1', 'firefox'],
    ['147.0b1', 'firefox-beta'],
    ['147.0b2', 'firefox-beta'],
  ] as const)('accepts %s for %s', (version, product) => {
    expect(describeProductVersionIncompatibility(version, product)).toBeUndefined();
  });

  // The message must name both halves of the mismatch: the operator has to
  // know which of the two to change.
  it.each([
    ['147.0b1', 'firefox-esr', 'firefox-esr', 'ESR version'],
    ['140.9.0', 'firefox-esr', 'firefox-esr', 'ESR version'],
    ['140.9.0esr', 'firefox', 'firefox-esr', 'firefox-esr'],
    ['147.0b1', 'firefox', 'firefox-beta', 'firefox-beta'],
    ['140.9.0esr', 'firefox-beta', 'beta version', 'beta version'],
    ['140.9.0', 'firefox-beta', 'beta version', 'beta version'],
  ] as const)('rejects %s for %s', (version, product, names, explains) => {
    const result = describeProductVersionIncompatibility(version, product);
    expect(result).toContain(names);
    expect(result).toContain(explains);
  });
});

describe('describeTokenNameProblem', () => {
  it('accepts valid CSS custom property names', () => {
    expect(describeTokenNameProblem('my-token')).toBeUndefined();
    expect(describeTokenNameProblem('--my-token')).toBeUndefined();
    expect(describeTokenNameProblem('mybrowser-canvas-dot-size')).toBeUndefined();
    expect(describeTokenNameProblem('color_primary')).toBeUndefined();
  });

  it('rejects names with spaces', () => {
    expect(describeTokenNameProblem('bad token')).toContain('whitespace');
    expect(describeTokenNameProblem('--bad token')).toContain('whitespace');
  });

  it('rejects names with */ (comment-breaking)', () => {
    expect(describeTokenNameProblem('bad*/token')).toContain('*/');
    expect(describeTokenNameProblem('--bad*/token')).toContain('*/');
  });

  it('rejects names with newlines and control characters', () => {
    expect(describeTokenNameProblem('bad\nname')).toContain('whitespace');
    expect(describeTokenNameProblem('bad\tname')).toContain('whitespace');
    expect(describeTokenNameProblem('bad\x00name')).toContain('control');
    expect(describeTokenNameProblem('bad\x1fname')).toContain('control');
  });

  it('rejects names with CSS-breaking characters', () => {
    expect(describeTokenNameProblem('bad{name')).toContain('corrupt CSS');
    expect(describeTokenNameProblem('bad}name')).toContain('corrupt CSS');
    expect(describeTokenNameProblem('bad;name')).toContain('corrupt CSS');
    expect(describeTokenNameProblem('bad(name')).toContain('corrupt CSS');
    expect(describeTokenNameProblem('bad)name')).toContain('corrupt CSS');
  });

  it('rejects empty names', () => {
    expect(describeTokenNameProblem('')).toContain('empty');
    expect(describeTokenNameProblem('--')).toContain('empty');
  });
});

describe('normalizeTokenName with validation', () => {
  it('throws on invalid names with spaces', () => {
    expect(() => normalizeTokenName('bad token')).toThrow('whitespace');
  });

  it('throws on invalid names with newlines', () => {
    expect(() => normalizeTokenName('bad\nname')).toThrow('whitespace');
  });

  it('throws on invalid names with */', () => {
    expect(() => normalizeTokenName('bad*/token')).toThrow('*/');
  });
});

describe('normalizePatchDisplayName', () => {
  it('strips a single category prefix', () => {
    expect(normalizePatchDisplayName('ui-foo', 'ui')).toBe('foo');
  });

  it('strips an ordinal + category prefix, repeatedly', () => {
    expect(normalizePatchDisplayName('203-ui-foo', 'ui')).toBe('foo');
    expect(normalizePatchDisplayName('203-ui-ui-foo', 'ui')).toBe('foo');
  });

  it('strips a trailing .patch extension case-insensitively', () => {
    expect(normalizePatchDisplayName('ui-foo.patch', 'ui')).toBe('foo');
    expect(normalizePatchDisplayName('foo.PATCH', 'ui')).toBe('foo');
  });

  it('is case-insensitive on the category token but preserves the remainder', () => {
    expect(normalizePatchDisplayName('UI-Foo', 'ui')).toBe('Foo');
  });

  it('never strips a bare leading number', () => {
    expect(normalizePatchDisplayName('2-step-verification', 'ui')).toBe('2-step-verification');
  });

  it('leaves other-category and unprefixed names untouched', () => {
    expect(normalizePatchDisplayName('core-foo', 'ui')).toBe('core-foo');
    expect(normalizePatchDisplayName('foo', 'ui')).toBe('foo');
  });

  it('falls back to the stem when stripping would empty the name', () => {
    expect(normalizePatchDisplayName('ui-', 'ui')).toBe('ui-');
    expect(normalizePatchDisplayName('203-ui-', 'ui')).toBe('203-ui-');
  });
});

describe('FIREFOX_PRODUCTS', () => {
  it('accepts every member of the union and rejects near-misses', () => {
    for (const p of FIREFOX_PRODUCTS) {
      expect(isValidFirefoxProduct(p)).toBe(true);
    }
    for (const bad of ['Firefox', 'firefox-nightly', 'esr', '', 'firefox ']) {
      expect(isValidFirefoxProduct(bad)).toBe(false);
    }
  });
});
