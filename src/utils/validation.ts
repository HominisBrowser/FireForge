// SPDX-License-Identifier: EUPL-1.2
/**
 * Type guards and validation utilities.
 * Used to safely narrow types from unknown values.
 */
import { InvalidArgumentError } from '../errors/base.js';
import type { FirefoxProduct } from '../types/config.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { escapeRegex } from './regex.js';

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
  // Number.isFinite matches the documented contract: NaN AND ±Infinity are
  // excluded (a JSON config field of 1e999 parses to Infinity and used to
  // validate as a legal number).
  return typeof value === 'number' && Number.isFinite(value);
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
 * Parses a CLI flag value as a positive integer. Throws
 * {@link InvalidArgumentError} on NaN, non-integer, or non-positive input.
 *
 * Intended for use inside Commander `argParser` bodies where the raw input
 * arrives as a string. The default pattern (`parseInt(v, 10)`) silently
 * hands NaN to downstream planners, which then embed it into filenames and
 * orders instead of failing fast.
 *
 * Rejects leading-zero forms ("01"), decimals ("1.5"), whitespace, and
 * non-numeric garbage via a strict regex — only the canonical
 * representation is accepted, so there is no ambiguity between what the user
 * typed and what the value becomes on disk.
 *
 * @param flagName - Flag name to include in the error (e.g. `--order`)
 * @param rawValue - Raw string value from Commander
 */
export function parsePositiveIntegerFlag(flagName: string, rawValue: string): number {
  if (!/^[1-9]\d*$/.test(rawValue)) {
    throw new InvalidArgumentError(
      `${flagName} must be a positive integer, got "${rawValue}".`,
      flagName
    );
  }
  return Number.parseInt(rawValue, 10);
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
 * Narrows a JSON value to a JSON object node (excludes arrays and `null`).
 *
 * Unlike {@link isObject} this accepts only values already known to be JSON
 * data, so the narrowed `JsonObject` keeps its concrete value contract —
 * use it when walking a `JsonValue` tree rather than at `unknown` boundaries.
 * @param value - JSON value to check
 * @returns True if value is a JSON object node
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a Firefox version string.
 * Accepts formats like "140.9.0", "140.9.1", "140.9.0esr", "147.0b1"
 */
export function isValidFirefoxVersion(version: string): boolean {
  // Stable/ESR: 140.9.0, 140.9.1, 140.9.0esr, 128.0.1esr
  // Beta: 147.0b1, 147.0b2
  return /^[1-9]\d{0,2}\.\d+(?:b[1-9]\d*|\.\d+(?:esr)?|esr)?$/.test(version);
}

/**
 * Validates a release-candidate build directory name.
 * Accepts formats like "build1", "build2", "build12" (no leading zero).
 */
export function isValidFirefoxCandidate(candidate: string): boolean {
  return /^build[1-9]\d{0,3}$/.test(candidate);
}

/**
 * Naming contract for this module's checks.
 *
 * `validate*` is easy to spread across incompatible return contracts — some
 * throwing and returning void, some returning an issue list, some a parsed
 * value, some a boolean, some an error MESSAGE — and a caller cannot tell
 * which from the name. Passing a THROWING `validate*` to a clack `validate`
 * callback, which expects a returned message, kills the prompt instead of
 * re-prompting.
 *
 * The two dominant contracts keep the prefix:
 *   - `validate*` — throws on failure, or returns an issue list.
 *   - `is*` / `has*` — a type predicate or boolean.
 * The message-returning minority is `describe*Problem`, which reads as what
 * it is: a description of what is wrong, or `undefined`.
 *
 * `assert*` is uniform throughout: throw-or-continue.
 */

/**
 * Valid Firefox product identifiers.
 *
 * `satisfies readonly FirefoxProduct[]` links the runtime list to the union
 * in ONE direction: it rejects an entry here that the union does not
 * declare. It cannot see a union member missing from this list — widening a
 * `readonly T[]` check never fails for being short. The reverse direction is
 * covered by the exhaustive switch in `utils/__tests__/validation.test.ts`,
 * which fails to compile when the union grows.
 */
export const FIREFOX_PRODUCTS = [
  'firefox',
  'firefox-esr',
  'firefox-beta',
  'firefox-devedition',
] as const satisfies readonly FirefoxProduct[];

/**
 * Validates a Firefox product string.
 *
 * A type predicate, matching its siblings {@link isValidPatchCategory} and
 * {@link isValidProjectLicense}. Returning plain `boolean` would force
 * `as FirefoxProduct` casts at the call sites even though the `.includes`
 * check IS the runtime proof.
 */
export const isValidFirefoxProduct = makeEnumGuard(FIREFOX_PRODUCTS);

/**
 * Builds a type predicate from a `readonly` tuple of allowed values.
 *
 * Deriving the type from the list — rather than declaring a union and
 * hand-maintaining a matching array — removes a whole class of drift: a
 * union can otherwise accept a stale allowlist with no compile error, and a
 * copy of the member list on the `fireforge.json` read path can silently
 * reject a newly added value.
 *
 * Returning a predicate rather than a boolean is what removes the `as`
 * casts: `.includes` IS the runtime proof, so the caller should not have to
 * re-assert it. `ParsedRecord.stringEnum` (src/utils/parse.ts) consumes
 * exactly this shape.
 *
 * @param values - The allowed values, as a `readonly` tuple
 * @returns A type predicate narrowing a string to one of `values`
 */
export function makeEnumGuard<const T extends readonly string[]>(
  values: T
): (value: string) => value is T[number] {
  return (value: string): value is T[number] => (values as readonly string[]).includes(value);
}

/**
 * Valid project license SPDX identifiers.
 */
export const PROJECT_LICENSES = ['EUPL-1.2', 'MPL-2.0', '0BSD', 'GPL-2.0-or-later'] as const;

/**
 * Validates a project license string.
 */
export const isValidProjectLicense = makeEnumGuard(PROJECT_LICENSES);

/**
 * Valid patch categories.
 */
export const PATCH_CATEGORIES = ['branding', 'ui', 'privacy', 'security', 'infra'] as const;

/**
 * Validates a patch category string.
 */
export const isValidPatchCategory = makeEnumGuard(PATCH_CATEGORIES);

/**
 * Checks whether a Firefox version string has an ESR suffix.
 */
function isEsrVersion(version: string): boolean {
  return /esr$/i.test(version);
}

/**
 * Checks whether a Firefox version string is a beta version (e.g. "147.0b1").
 */
function isBetaVersion(version: string): boolean {
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
 * - `firefox-esr` requires an ESR version (e.g. "140.9.0esr", "128.0.1esr").
 * - `firefox-beta` and `firefox-devedition` require a beta version (e.g. "147.0b1").
 * - `firefox` (stable) rejects both ESR and beta version strings.
 *
 * @returns An error message if incompatible, or undefined if valid.
 */
export function describeProductVersionIncompatibility(
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
    case 'firefox-devedition':
      if (!versionIsBeta) {
        return (
          `Product "${product}" requires a beta version (e.g. "147.0b1"), ` + `but got "${version}"`
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
export function describeTokenNameProblem(name: string): string | undefined {
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

  if (ident.includes('*/') || ident.includes('/*')) {
    // `/*` is the worse of the two by this function's own standard: an
    // ident containing it opens an UNTERMINATED comment in tokens.css
    // that swallows every following declaration.
    return `Token name must not contain "/*" or "*/" (would break CSS comments): "${name}"`;
  }

  // Reject characters that would break CSS declaration syntax. Quotes are
  // included: a quote character in an ident opens a CSS string that eats
  // the rest of the declaration block.
  if (/[{}();!'"]/.test(ident)) {
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
  const error = describeTokenNameProblem(name);
  if (error) {
    throw new InvalidArgumentError(error, 'tokenName');
  }
  const stripped = name.replace(/^--/, '');
  return `--${stripped}`;
}

/**
 * Normalizes a patch display name against its category:
 * strips a trailing `.patch` and any redundant `NNN-<category>-` /
 * `<category>-` prefixes, case-insensitively and repeatedly, mirroring
 * the filename slug pipeline's require-the-category-token rule — a bare
 * leading number is never stripped, so names like `2-step-verification`
 * survive intact. Falls back to the `.patch`-stripped stem when the
 * strip would empty the name.
 */
export function normalizePatchDisplayName(name: string, category: string): string {
  const stem = name.trim().replace(/\.patch$/i, '');
  const escaped = escapeRegex(category);
  const prefixes = [
    new RegExp(`^\\d+[-_ ]+${escaped}[-_ ]+`, 'i'),
    new RegExp(`^${escaped}[-_ ]+`, 'i'),
  ];
  let stripped = stem;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (prefix.test(stripped)) {
        stripped = stripped.replace(prefix, '');
        changed = true;
      }
    }
  }
  return stripped.length > 0 ? stripped : stem;
}

/**
 * Validates a patch name.
 * @param name - The patch name to validate
 * @returns Error message if invalid, undefined if valid
 */
export function describePatchNameProblem(name: string): string | undefined {
  if (!name.trim()) return 'Name is required';
  if (name.length > 50) return 'Name must be 50 characters or less';
  if (!/^[a-zA-Z0-9\-_ ]+$/.test(name))
    return 'Name can only contain letters, numbers, hyphens, underscores, and spaces';
  return undefined;
}
