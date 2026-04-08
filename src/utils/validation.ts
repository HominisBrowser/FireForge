// SPDX-License-Identifier: EUPL-1.2
/**
 * Type guards and validation utilities.
 * Used to safely narrow types from unknown values.
 */
import { InvalidArgumentError } from '../errors/base.js';

/**
 * Checks whether a value is a string.
 * @param value - Value to check
 * @returns True if value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Checks whether a value is a finite number (excludes NaN).
 * @param value - Value to check
 * @returns True if value is a finite number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

/**
 * Checks whether a value is a positive integer (greater than zero).
 * @param value - Value to check
 * @returns True if value is a positive integer
 */
export function isPositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value > 0;
}

/**
 * Checks whether a value is a boolean.
 * @param value - Value to check
 * @returns True if value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Checks whether a value is a non-null, non-array object.
 * @param value - Value to check
 * @returns True if value is a plain object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is an array.
 * @param value - Value to check
 * @returns True if value is an array
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Asserts that a value is a string or throws.
 * @param value - Value to check
 * @param name - Name of the field for error messages
 */
export function assertString(value: unknown, name: string): asserts value is string {
  if (!isString(value)) {
    throw new InvalidArgumentError(`Expected ${name} to be a string, got ${typeof value}`, name);
  }
}

/**
 * Asserts that a value is a non-null object or throws.
 * @param value - Value to check
 * @param name - Name of the field for error messages
 */
export function assertObject(
  value: unknown,
  name: string
): asserts value is Record<string, unknown> {
  if (!isObject(value)) {
    throw new InvalidArgumentError(`Expected ${name} to be an object, got ${typeof value}`, name);
  }
}

/**
 * Validates a Firefox version string.
 * Accepts formats like "146.0", "146.0.1", "140.0esr", "147.0b1"
 */
export function isValidFirefoxVersion(version: string): boolean {
  // Stable/ESR: 146.0, 146.0.1, 140.0esr, 128.0.1esr
  // Beta: 147.0b1, 147.0b2
  return /^[1-9]\d{0,2}\.\d+(?:b[1-9]\d*|\.\d+(?:esr)?|esr)?$/.test(version);
}

/**
 * Validates a Firefox product string.
 * Accepts: firefox, firefox-esr, firefox-beta
 */
export function isValidFirefoxProduct(product: string): boolean {
  return ['firefox', 'firefox-esr', 'firefox-beta'].includes(product);
}

/**
 * Valid project license SPDX identifiers.
 */
export const PROJECT_LICENSES = ['EUPL-1.2', 'MPL-2.0', '0BSD', 'GPL-2.0-or-later'] as const;

/**
 * Validates a project license string.
 */
export function isValidProjectLicense(
  license: string
): license is (typeof PROJECT_LICENSES)[number] {
  return PROJECT_LICENSES.includes(license as (typeof PROJECT_LICENSES)[number]);
}

/**
 * Valid patch categories.
 */
export const PATCH_CATEGORIES = ['branding', 'ui', 'privacy', 'security', 'infra'] as const;

/**
 * Validates a patch category string.
 */
export function isValidPatchCategory(
  category: string
): category is (typeof PATCH_CATEGORIES)[number] {
  return PATCH_CATEGORIES.includes(category as (typeof PATCH_CATEGORIES)[number]);
}

/**
 * Checks whether a Firefox version string has an ESR suffix.
 */
export function isEsrVersion(version: string): boolean {
  return /esr$/i.test(version);
}

/**
 * Checks whether a Firefox version string is a beta version (e.g. "147.0b1").
 */
export function isBetaVersion(version: string): boolean {
  return /b\d+$/.test(version);
}

/**
 * Infers the Firefox product type from a version string.
 * Returns undefined if no clear inference can be made.
 */
export function inferProductFromVersion(
  version: string
): 'firefox' | 'firefox-esr' | 'firefox-beta' | undefined {
  if (isEsrVersion(version)) {
    return 'firefox-esr';
  }
  if (isBetaVersion(version)) {
    return 'firefox-beta';
  }
  return undefined;
}

/**
 * Validates that a Firefox product and version are compatible.
 *
 * Rules:
 * - `firefox-esr` requires an ESR version (e.g. "140.0esr", "128.0.1esr").
 * - `firefox-beta` requires a beta version (e.g. "147.0b1").
 * - `firefox` (stable) rejects both ESR and beta version strings.
 *
 * @returns An error message if incompatible, or undefined if valid.
 */
export function validateFirefoxProductVersionCompatibility(
  version: string,
  product: string
): string | undefined {
  const versionIsEsr = isEsrVersion(version);
  const versionIsBeta = isBetaVersion(version);

  switch (product) {
    case 'firefox-esr':
      if (!versionIsEsr) {
        return (
          `Product "firefox-esr" requires an ESR version (e.g. "128.0esr"), ` +
          `but got "${version}"`
        );
      }
      break;
    case 'firefox-beta':
      if (!versionIsBeta) {
        return (
          `Product "firefox-beta" requires a beta version (e.g. "147.0b1"), ` +
          `but got "${version}"`
        );
      }
      break;
    case 'firefox':
      if (versionIsEsr) {
        return (
          `Product "firefox" does not accept ESR versions. ` +
          `Use product "firefox-esr" with version "${version}", or remove the "esr" suffix`
        );
      }
      if (versionIsBeta) {
        return (
          `Product "firefox" does not accept beta versions. ` +
          `Use product "firefox-beta" with version "${version}", or remove the beta suffix`
        );
      }
      break;
  }

  return undefined;
}

/**
 * Validates an application ID string.
 * Accepts reverse-domain format like "org.example.browser"
 */
export function isValidAppId(appId: string): boolean {
  return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(appId);
}

/**
 * Checks if a value is defined (not undefined or null).
 */
export function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

/**
 * Validates that a string is a legal CSS custom property identifier (the part after `--`).
 *
 * A valid CSS custom property name requires the ident portion to:
 * - Be non-empty
 * - Contain no whitespace or control characters
 * - Contain no sequences that would break CSS syntax
 * - Consist of printable, CSS-safe characters (letters, digits, hyphens, underscores, etc.)
 *
 * @returns An error message if invalid, or undefined if valid.
 */
export function validateTokenName(name: string): string | undefined {
  // Strip leading -- for validation (callers may pass with or without)
  const ident = name.replace(/^--/, '');

  if (!ident) {
    return 'Token name must not be empty';
  }

  if (/\s/.test(ident)) {
    return `Token name must not contain whitespace: "${name}"`;
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(ident)) {
    return `Token name must not contain control characters: "${name}"`;
  }

  if (ident.includes('*/')) {
    return `Token name must not contain "*/" (would break CSS comments): "${name}"`;
  }

  // Reject characters that would break CSS declaration syntax
  if (/[{}();!]/.test(ident)) {
    return `Token name contains characters that would corrupt CSS syntax: "${name}"`;
  }

  return undefined;
}

/**
 * Normalizes a CSS custom property token name.
 * Strips leading `--` if present, then always prepends `--`.
 * This allows users to pass either `--my-token` or `my-token`.
 *
 * @throws InvalidArgumentError if the resulting name is not a valid CSS custom property.
 */
export function normalizeTokenName(name: string): string {
  const error = validateTokenName(name);
  if (error) {
    throw new InvalidArgumentError(error, 'tokenName');
  }
  const stripped = name.replace(/^--/, '');
  return `--${stripped}`;
}

/**
 * Validates a patch name.
 * @param name - The patch name to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validatePatchName(name: string): string | undefined {
  if (!name.trim()) return 'Name is required';
  if (name.length > 50) return 'Name must be 50 characters or less';
  if (!/^[a-zA-Z0-9\-_ ]+$/.test(name))
    return 'Name can only contain letters, numbers, hyphens, underscores, and spaces';
  return undefined;
}
