// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  assertObject,
  assertString,
  inferProductFromVersion,
  isArray,
  isBoolean,
  isDefined,
  isNumber,
  isObject,
  isString,
  isValidAppId,
  isValidFirefoxProduct,
  isValidFirefoxVersion,
  isValidPatchCategory,
  isValidProjectLicense,
  normalizeTokenName,
  validateFirefoxProductVersionCompatibility,
  validatePatchName,
  validateTokenName,
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
    expect(isDefined('value')).toBe(true);
    expect(isDefined(null)).toBe(false);
    expect(isDefined(undefined)).toBe(false);
  });
});

describe('assertions', () => {
  it('asserts strings and objects with helpful error messages', () => {
    expect(() => {
      assertString(42, 'name');
    }).toThrow('Expected name to be a string, got number');
    expect(() => {
      assertObject('oops', 'config');
    }).toThrow('Expected config to be an object, got string');

    expect(() => {
      assertString('ok', 'name');
    }).not.toThrow();
    expect(() => {
      assertObject({ ok: true }, 'config');
    }).not.toThrow();
  });
});

describe('firefox metadata validation', () => {
  it('accepts valid Firefox versions and rejects invalid ones', () => {
    expect(isValidFirefoxVersion('146.0')).toBe(true);
    expect(isValidFirefoxVersion('146.0.1')).toBe(true);
    expect(isValidFirefoxVersion('140.0esr')).toBe(true);
    expect(isValidFirefoxVersion('147.0b2')).toBe(true);
    expect(isValidFirefoxVersion('0.0')).toBe(false);
    expect(isValidFirefoxVersion('firefox')).toBe(false);
  });

  it('validates Firefox products and infers them from version strings', () => {
    expect(isValidFirefoxProduct('firefox')).toBe(true);
    expect(isValidFirefoxProduct('firefox-esr')).toBe(true);
    expect(isValidFirefoxProduct('firefox-beta')).toBe(true);
    expect(isValidFirefoxProduct('fennec')).toBe(false);

    expect(inferProductFromVersion('140.0esr')).toBe('firefox-esr');
    expect(inferProductFromVersion('147.0b1')).toBe('firefox-beta');
    expect(inferProductFromVersion('146.0')).toBeUndefined();
  });

  it('validates reverse-domain app ids', () => {
    expect(isValidAppId('org.example.browser')).toBe(true);
    expect(isValidAppId('browser')).toBe(false);
    expect(isValidAppId('Org.example.browser')).toBe(false);
  });
});

describe('project metadata validation', () => {
  it('validates supported project licenses and patch categories', () => {
    expect(isValidProjectLicense('MPL-2.0')).toBe(true);
    expect(isValidProjectLicense('Apache-2.0')).toBe(false);
    expect(isValidPatchCategory('ui')).toBe(true);
    expect(isValidPatchCategory('audio')).toBe(false);
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

describe('validatePatchName', () => {
  it('rejects empty names, long names, and unsupported characters', () => {
    expect(validatePatchName('')).toBe('Name is required');
    expect(validatePatchName('a'.repeat(51))).toBe('Name must be 50 characters or less');
    expect(validatePatchName('bad/name')).toBe(
      'Name can only contain letters, numbers, hyphens, underscores, and spaces'
    );
  });

  it('accepts well-formed patch names', () => {
    expect(validatePatchName('UI polish 01')).toBeUndefined();
    expect(validatePatchName('privacy_hardening')).toBeUndefined();
  });
});

describe('validateFirefoxProductVersionCompatibility', () => {
  it('accepts ESR product with ESR version', () => {
    expect(validateFirefoxProductVersionCompatibility('140.0esr', 'firefox-esr')).toBeUndefined();
    expect(validateFirefoxProductVersionCompatibility('128.0.1esr', 'firefox-esr')).toBeUndefined();
  });

  it('accepts stable product with stable version', () => {
    expect(validateFirefoxProductVersionCompatibility('146.0', 'firefox')).toBeUndefined();
    expect(validateFirefoxProductVersionCompatibility('146.0.1', 'firefox')).toBeUndefined();
  });

  it('accepts beta product with beta version', () => {
    expect(validateFirefoxProductVersionCompatibility('147.0b1', 'firefox-beta')).toBeUndefined();
    expect(validateFirefoxProductVersionCompatibility('147.0b2', 'firefox-beta')).toBeUndefined();
  });

  it('rejects ESR product with beta version', () => {
    const result = validateFirefoxProductVersionCompatibility('147.0b1', 'firefox-esr');
    expect(result).toContain('firefox-esr');
    expect(result).toContain('ESR version');
  });

  it('rejects ESR product with stable version', () => {
    const result = validateFirefoxProductVersionCompatibility('146.0', 'firefox-esr');
    expect(result).toBeDefined();
    expect(result).toContain('ESR version');
  });

  it('rejects stable product with ESR version', () => {
    const result = validateFirefoxProductVersionCompatibility('140.0esr', 'firefox');
    expect(result).toContain('firefox-esr');
  });

  it('rejects stable product with beta version', () => {
    const result = validateFirefoxProductVersionCompatibility('147.0b1', 'firefox');
    expect(result).toContain('firefox-beta');
  });

  it('rejects beta product with ESR version', () => {
    const result = validateFirefoxProductVersionCompatibility('140.0esr', 'firefox-beta');
    expect(result).toBeDefined();
    expect(result).toContain('beta version');
  });

  it('rejects beta product with stable version', () => {
    const result = validateFirefoxProductVersionCompatibility('146.0', 'firefox-beta');
    expect(result).toBeDefined();
    expect(result).toContain('beta version');
  });
});

describe('validateTokenName', () => {
  it('accepts valid CSS custom property names', () => {
    expect(validateTokenName('my-token')).toBeUndefined();
    expect(validateTokenName('--my-token')).toBeUndefined();
    expect(validateTokenName('mybrowser-canvas-dot-size')).toBeUndefined();
    expect(validateTokenName('color_primary')).toBeUndefined();
  });

  it('rejects names with spaces', () => {
    expect(validateTokenName('bad token')).toContain('whitespace');
    expect(validateTokenName('--bad token')).toContain('whitespace');
  });

  it('rejects names with */ (comment-breaking)', () => {
    expect(validateTokenName('bad*/token')).toContain('*/');
    expect(validateTokenName('--bad*/token')).toContain('*/');
  });

  it('rejects names with newlines and control characters', () => {
    expect(validateTokenName('bad\nname')).toContain('whitespace');
    expect(validateTokenName('bad\tname')).toContain('whitespace');
    expect(validateTokenName('bad\x00name')).toContain('control');
    expect(validateTokenName('bad\x1fname')).toContain('control');
  });

  it('rejects names with CSS-breaking characters', () => {
    expect(validateTokenName('bad{name')).toContain('corrupt CSS');
    expect(validateTokenName('bad}name')).toContain('corrupt CSS');
    expect(validateTokenName('bad;name')).toContain('corrupt CSS');
    expect(validateTokenName('bad(name')).toContain('corrupt CSS');
    expect(validateTokenName('bad)name')).toContain('corrupt CSS');
  });

  it('rejects empty names', () => {
    expect(validateTokenName('')).toContain('empty');
    expect(validateTokenName('--')).toContain('empty');
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
