// SPDX-License-Identifier: EUPL-1.2
/**
 * Validators for the `furnace validate` and `token lint` policy fields of
 * furnace.json: `validationExceptions[]`, `optInChecks[]`, `minComponents`
 * and `tokenSiblingSheets`.
 *
 * Strict on purpose, like `buildAudit.unpackaged`: every exception is a
 * standing suppression of a finding, so a malformed one must fail at load
 * rather than quietly suppress nothing (or everything).
 */
import { FurnaceError } from '../errors/furnace.js';
import {
  FURNACE_OPT_IN_CHECKS,
  type FurnaceOptInCheck,
  type FurnaceValidationException,
} from '../types/furnace.js';
import { isArray, isObject, isString } from '../utils/validation.js';

const EXCEPTION_KEYS = new Set(['component', 'check', 'tag', 'file', 'reason']);

function requireNonEmptyString(entry: Record<string, unknown>, key: string, field: string): string {
  const value = entry[key];
  if (!isString(value) || value.trim().length === 0) {
    throw new FurnaceError(`Furnace config: "${field}.${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Parses `validationExceptions[]`: `{ component, check, tag?, file?, reason }`
 * objects, no other keys, every field a non-empty string, at most one of
 * `tag` and `file` (a bare file name of the component), and no two entries
 * for the same component, check and scope.
 */
export function parseValidationExceptions(raw: unknown): FurnaceValidationException[] {
  if (!isArray(raw)) {
    throw new FurnaceError('Furnace config: "validationExceptions" must be an array');
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `validationExceptions[${String(index)}]`;
    if (!isObject(entry)) {
      throw new FurnaceError(
        `Furnace config: "${field}" must be an object with "component", "check" and "reason"`
      );
    }
    for (const key of Object.keys(entry)) {
      if (!EXCEPTION_KEYS.has(key)) {
        throw new FurnaceError(`Furnace config: "${field}" has unknown key "${key}"`);
      }
    }
    const exception: FurnaceValidationException = {
      component: requireNonEmptyString(entry, 'component', field),
      check: requireNonEmptyString(entry, 'check', field),
      reason: requireNonEmptyString(entry, 'reason', field),
    };
    if (entry['tag'] !== undefined) exception.tag = requireNonEmptyString(entry, 'tag', field);
    if (entry['file'] !== undefined) {
      if (exception.tag !== undefined) {
        throw new FurnaceError(`Furnace config: "${field}" may name a "tag" or a "file", not both`);
      }
      const file = requireNonEmptyString(entry, 'file', field);
      if (/[\\/]/.test(file) || file === '.' || file === '..') {
        throw new FurnaceError(
          `Furnace config: "${field}.file" must be a file name in the component's directory, not a path`
        );
      }
      exception.file = file;
    }
    const scope =
      exception.tag !== undefined
        ? `tag:${exception.tag}`
        : exception.file !== undefined
          ? `file:${exception.file}`
          : '';
    const identity = `${exception.component}\u0000${exception.check}\u0000${scope}`;
    if (seen.has(identity)) {
      const on =
        exception.tag !== undefined
          ? ` on <${exception.tag}>`
          : exception.file !== undefined
            ? ` in ${exception.file}`
            : '';
      throw new FurnaceError(
        `Furnace config: "${field}" repeats the exception for ${exception.component} [${exception.check}]${on}`
      );
    }
    seen.add(identity);
    return exception;
  });
}

function isOptInCheck(value: string): value is FurnaceOptInCheck {
  return (FURNACE_OPT_IN_CHECKS as readonly string[]).includes(value);
}

/**
 * Parses `tokenSiblingSheets`: an object from a sheet glob to a non-empty
 * list of partner paths or globs.
 */
export function parseTokenSiblingSheets(raw: unknown): Record<string, string[]> {
  if (!isObject(raw)) {
    throw new FurnaceError('Furnace config: "tokenSiblingSheets" must be an object');
  }
  const out: Record<string, string[]> = {};
  for (const [pattern, partners] of Object.entries(raw)) {
    const valid =
      isArray(partners) &&
      partners.length > 0 &&
      partners.every((partner) => isString(partner) && partner.trim() !== '');
    if (pattern.includes('..') || !valid || partners.some((p) => String(p).includes('..'))) {
      throw new FurnaceError(
        `Furnace config: "tokenSiblingSheets.${pattern}" must be a non-empty list of engine-relative paths or globs (no "..")`
      );
    }
    out[pattern] = partners as string[];
  }
  return out;
}

/** Parses `minComponents`: a positive integer. */
export function parseMinComponents(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new FurnaceError('Furnace config: "minComponents" must be a positive integer');
  }
  return raw;
}

/** Parses `optInChecks[]`: names from {@link FURNACE_OPT_IN_CHECKS}. */
export function parseOptInChecks(raw: unknown): FurnaceOptInCheck[] {
  if (!isArray(raw)) {
    throw new FurnaceError('Furnace config: "optInChecks" must be an array');
  }
  const checks: FurnaceOptInCheck[] = [];
  for (const value of raw) {
    if (!isString(value) || !isOptInCheck(value)) {
      throw new FurnaceError(
        `Furnace config: "optInChecks" entry ${JSON.stringify(value)} is not an opt-in check. Valid: ${FURNACE_OPT_IN_CHECKS.join(', ')}`
      );
    }
    if (!checks.includes(value)) checks.push(value);
  }
  return checks;
}
