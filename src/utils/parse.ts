// SPDX-License-Identifier: EUPL-1.2
/**
 * Lightweight runtime object parsing and field extraction helpers.
 *
 * Reduces repetitive "validate unknown → cast" boilerplate across
 * config validation, manifest parsing, and metadata validation.
 */

import { isArray, isNumber, isObject, isString } from './validation.js';

/**
 * A parsed record wrapper that provides typed field extraction
 * with clear error messages. Construct via {@link parseObject}.
 */
export class ParsedRecord {
  readonly #data: Record<string, unknown>;
  readonly #label: string;

  constructor(data: Record<string, unknown>, label: string) {
    this.#data = data;
    this.#label = label;
  }

  /**
   * Extracts a required string field.
   * @param key - Field name
   * @returns The string value
   * @throws Error if the field is missing or not a string
   */
  string(key: string): string {
    const value = this.#data[key];
    if (!isString(value)) {
      throw new Error(`${this.#label}.${key} must be a string`);
    }
    return value;
  }

  /**
   * Extracts an optional string field.
   * @param key - Field name
   * @returns The string value or undefined
   * @throws Error if the field is present but not a string
   */
  optionalString(key: string): string | undefined {
    const value = this.#data[key];
    if (value === undefined) return undefined;
    if (!isString(value)) {
      throw new Error(`${this.#label}.${key} must be a string`);
    }
    return value;
  }

  /**
   * Extracts a required number field.
   * @param key - Field name
   * @returns The number value
   * @throws Error if the field is missing or not a number
   */
  number(key: string): number {
    const value = this.#data[key];
    if (!isNumber(value)) {
      throw new Error(`${this.#label}.${key} must be a number`);
    }
    return value;
  }

  /**
   * Extracts an optional number field.
   * @param key - Field name
   * @returns The number value or undefined
   * @throws Error if the field is present but not a number
   */
  optionalNumber(key: string): number | undefined {
    const value = this.#data[key];
    if (value === undefined) return undefined;
    if (!isNumber(value)) {
      throw new Error(`${this.#label}.${key} must be a number`);
    }
    return value;
  }

  /**
   * Extracts a required non-negative integer field.
   * @param key - Field name
   * @returns The integer value
   * @throws Error if the field is missing, not a number, or negative
   */
  nonNegativeInteger(key: string): number {
    const value = this.#data[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`${this.#label}.${key} must be a non-negative integer`);
    }
    return value;
  }

  /**
   * Extracts an optional non-negative integer field.
   * @param key - Field name
   * @returns The integer value or undefined
   * @throws Error if the field is present but not a non-negative integer
   */
  optionalNonNegativeInteger(key: string): number | undefined {
    const value = this.#data[key];
    if (value === undefined) return undefined;
    if (!isNumber(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${this.#label}.${key} must be a non-negative integer`);
    }
    return value;
  }

  /**
   * Extracts a required string field and validates it against a predicate.
   * @param key - Field name
   * @param predicate - Validation function
   * @param allowed - Description of allowed values for the error message
   * @returns The validated string value
   */
  stringEnum<T extends string>(
    key: string,
    predicate: (value: string) => value is T,
    allowed: string
  ): T {
    const value = this.string(key);
    if (!predicate(value)) {
      throw new Error(`${this.#label}.${key} must be ${allowed}`);
    }
    return value;
  }

  /**
   * Extracts a required string field and validates it with a custom check.
   * @param key - Field name
   * @param check - Validation function returning true if valid
   * @param constraint - Description of the constraint for the error message
   * @returns The validated string value
   */
  validatedString(key: string, check: (value: string) => boolean, constraint: string): string {
    const value = this.string(key);
    if (!check(value)) {
      throw new Error(`${this.#label}.${key} must be ${constraint}`);
    }
    return value;
  }

  /**
   * Extracts a required array-of-strings field.
   * @param key - Field name
   * @returns The string array
   * @throws Error if the field is missing or not an array of strings
   */
  stringArray(key: string): string[] {
    const value = this.#data[key];
    if (!isArray(value) || !value.every(isString)) {
      throw new Error(`${this.#label}.${key} must be an array of strings`);
    }
    return [...value];
  }

  /**
   * Extracts a required nested object field.
   * @param key - Field name
   * @returns A new ParsedRecord wrapping the nested object
   * @throws Error if the field is missing or not an object
   */
  object(key: string): ParsedRecord {
    const value = this.#data[key];
    if (!isObject(value)) {
      throw new Error(`${this.#label}.${key} must be an object`);
    }
    return new ParsedRecord(value, `${this.#label}.${key}`);
  }

  /**
   * Extracts an optional nested object field.
   * @param key - Field name
   * @returns A new ParsedRecord wrapping the nested object, or undefined
   * @throws Error if the field is present but not an object
   */
  optionalObject(key: string): ParsedRecord | undefined {
    const value = this.#data[key];
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      throw new Error(`${this.#label}.${key} must be an object`);
    }
    return new ParsedRecord(value, `${this.#label}.${key}`);
  }

  /**
   * Returns the raw value of a field without validation.
   * @param key - Field name
   */
  raw(key: string): unknown {
    return this.#data[key];
  }

  /**
   * Returns all keys in the underlying record.
   */
  keys(): string[] {
    return Object.keys(this.#data);
  }
}

/**
 * Wraps an unknown value as a ParsedRecord after verifying it is an object.
 * @param data - The unknown value to parse
 * @param label - Label for error messages (e.g. "Config", "patches[0]")
 * @returns A ParsedRecord for typed field extraction
 * @throws Error if data is not a plain object
 */
export function parseObject(data: unknown, label: string): ParsedRecord {
  if (!isObject(data)) {
    throw new Error(`${label} must be an object`);
  }
  return new ParsedRecord(data, label);
}
