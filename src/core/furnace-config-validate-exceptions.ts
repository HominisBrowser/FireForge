// SPDX-License-Identifier: EUPL-1.2
/**
 * Validators for the two `furnace validate` policy fields of furnace.json:
 * `validationExceptions[]` and `optInChecks[]`.
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

const EXCEPTION_KEYS = new Set(['component', 'check', 'reason']);

function requireNonEmptyString(entry: Record<string, unknown>, key: string, field: string): string {
  const value = entry[key];
  if (!isString(value) || value.trim().length === 0) {
    throw new FurnaceError(`Furnace config: "${field}.${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Parses `validationExceptions[]`: `{ component, check, reason }` objects,
 * no other keys, every field a non-empty string, and no two entries for the
 * same component and check.
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
    const identity = `${exception.component}\u0000${exception.check}`;
    if (seen.has(identity)) {
      throw new FurnaceError(
        `Furnace config: "${field}" repeats the exception for ${exception.component} [${exception.check}]`
      );
    }
    seen.add(identity);
    return exception;
  });
}

function isOptInCheck(value: string): value is FurnaceOptInCheck {
  return (FURNACE_OPT_IN_CHECKS as readonly string[]).includes(value);
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
