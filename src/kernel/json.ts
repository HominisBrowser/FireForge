// SPDX-License-Identifier: EUPL-1.2
/**
 * JSON values and JSON documents on disk. A document read from a file always
 * passes through a schema, so nothing downstream handles an unchecked shape.
 */
import { type ErrorDetails, FireForgeError, toError } from './errors.js';
import { readTextIfExists, writeFile } from './fs.js';
import type { Schema } from './schema.js';

/** Any value a JSON document can hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/**
 * A JSON object. `undefined` is admitted as a property value so a document can
 * be built from optional inputs; serialisation drops such keys.
 */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/**
 * Narrows an unknown value to a plain object (not an array, not null).
 *
 * @param value - The value
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of an object without the named keys.
 *
 * @param object - The object
 * @param keys - The keys to leave out
 */
export function omitKeys<T extends Record<string, unknown>>(object: T, ...keys: string[]): T {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key))) as T;
}

/**
 * Parses JSON text, reporting a syntax error as a {@link FireForgeError} that
 * names the source.
 *
 * @param text - The JSON text
 * @param details - `source` names what is being parsed; the rest shape the error
 */
export function parseJson(
  text: string,
  details: ErrorDetails & { source?: string } = {}
): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error: unknown) {
    const { source, ...rest } = details;
    throw new FireForgeError(
      'json-invalid',
      `${source ?? 'The document'} is not valid JSON: ${toError(error).message}`,
      { cause: error, ...rest }
    );
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

/** How {@link stringifyJson} lays a document out. */
export interface StringifyOptions {
  /** Emit object keys in sorted order at every depth, for byte-stable output. */
  sortKeys?: boolean;
  /** Indentation width. Default 2; 0 writes one line. */
  indent?: number;
}

/**
 * Serialises a value as JSON text ending in a newline.
 *
 * @param value - The value
 * @param options - See {@link StringifyOptions}
 */
export function stringifyJson(value: unknown, options: StringifyOptions = {}): string {
  const subject = options.sortKeys === true ? sortKeys(value) : value;
  return `${JSON.stringify(subject, null, options.indent ?? 2)}\n`;
}

/** How a document read reports a refusal. `exitCode` and `hint` name the repair. */
export type ReadJsonOptions = ErrorDetails & { code?: string };

/**
 * Reads and validates a JSON document, or returns undefined when the file
 * does not exist. A file that exists but does not parse or does not match the
 * schema is an error naming the file and the key path, never an empty default.
 *
 * @param path - The document
 * @param schema - What it must look like
 * @param options - See {@link ReadJsonOptions}
 */
export async function readJsonIfExists<T>(
  path: string,
  schema: Schema<T>,
  options: ReadJsonOptions = {}
): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  const details = { source: path, ...options };
  return schema.parse(parseJson(text, details), details);
}

/**
 * Reads and validates a JSON document that must exist.
 *
 * @param path - The document
 * @param schema - What it must look like
 * @param options - See {@link ReadJsonOptions}
 */
export async function readJson<T>(
  path: string,
  schema: Schema<T>,
  options: ReadJsonOptions = {}
): Promise<T> {
  const value = await readJsonIfExists(path, schema, options);
  if (value === undefined) {
    const { code, ...details } = options;
    throw new FireForgeError(code ?? 'document-missing', `${path} does not exist`, details);
  }
  return value;
}

/**
 * Writes a JSON document atomically.
 *
 * @param path - The document
 * @param value - Its content
 * @param options - See {@link StringifyOptions}
 */
export async function writeJson(
  path: string,
  value: unknown,
  options: StringifyOptions = {}
): Promise<void> {
  await writeFile(path, stringifyJson(value, options));
}
