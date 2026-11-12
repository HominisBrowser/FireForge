// SPDX-License-Identifier: EUPL-1.2
/**
 * Reading and editing single keys of `fireforge.json` through the schema: a
 * key exists when the schema declares it, a value is typed by the key's
 * schema, and the whole document is validated before anything is written.
 * An edit rewrites only the changed value, so the file keeps its layout.
 * `mode` is the one key an edit cannot change: it moves together with the
 * `source` section and the project's files, which a single-key edit cannot do.
 *
 * A key is written the way validation reports paths: dotted names, array
 * indices as `[2]` or `.2`, and a dictionary key that is not a plain word in
 * brackets, as in `typecheck.projectOverrides["browser/jsconfig.json"]`.
 */
import { join } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { writeFile } from '../kernel/fs.js';
import {
  isRecord,
  type JsonObject,
  type JsonValue,
  parseJson,
  stringifyJson,
} from '../kernel/json.js';
import { editJsonText } from '../kernel/json-edit.js';
import { withLock } from '../kernel/lock.js';
import { describeKeys, type Schema, type SchemaIssue } from '../kernel/schema.js';
import { nearest } from '../kernel/text.js';
import { CONFIG_FILE, readConfigDocument } from './load.js';
import { configSchema } from './schema/index.js';
import { modeKey } from './schema/source.js';

/** One key of `fireforge.json`, as help and documentation list it. */
export interface ConfigKey {
  /** Dotted path from the root. */
  path: string;
  /** What the key accepts, in words. */
  type: string;
  doc: string | undefined;
  required: boolean;
  /** Whether the key holds further keys rather than a value. */
  container: boolean;
  /** The value an absent key takes, if the schema gives one. */
  defaultValue: JsonValue | undefined;
}

/** A key's value in the file, beside what the schema says about it. */
export interface ConfigValue extends ConfigKey {
  /** The value as written in the file, or undefined when the key is absent. */
  value: JsonValue | undefined;
}

/** What {@link setConfigValue} did. */
export interface ConfigEdit {
  path: string;
  value: JsonValue;
  /** False when the file already held the value and was left untouched. */
  changed: boolean;
}

type AnySchema = Schema<unknown, boolean>;

const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function unknownKey(key: string, why: string): FireForgeError {
  const suggestion = nearest(
    key,
    describeKeys(configSchema).map((info) => info.path)
  );
  return new FireForgeError('config-unknown-key', `"${key}" ${why}`, {
    exitCode: ExitCode.INVALID_ARGUMENT,
    hint:
      suggestion === undefined
        ? 'docs/configuration.md lists the keys of fireforge.json.'
        : `Did you mean "${suggestion}"?`,
  });
}

/** The text of a bracketed, JSON-quoted key segment. */
function quoted(key: string, body: string): string {
  let value: JsonValue | undefined;
  try {
    value = parseJson(`"${body}"`);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'string') throw unknownKey(key, 'has a malformed quoted segment');
  return value;
}

/** Splits a key into its segments, refusing a malformed or prototype-reaching one. */
function segmentsOf(key: string): string[] {
  const segments: string[] = [];
  let rest = key;
  while (rest !== '') {
    const match =
      /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest) ??
      /^\[(\d+)\]/.exec(rest) ??
      (segments.length === 0 ? /^([^.[\]]+)/ : /^\.([^.[\]]+)/).exec(rest);
    const segment = match?.[1];
    if (match === null || segment === undefined) throw unknownKey(key, 'is not a valid key path');
    const name = match[0].startsWith('["') ? quoted(key, segment) : segment;
    if (RESERVED_SEGMENTS.has(name)) throw unknownKey(key, `cannot name "${name}"`);
    segments.push(name);
    rest = rest.slice(match[0].length);
  }
  if (segments.length === 0) throw unknownKey(key, 'is empty');
  return segments;
}

/** The schema of the value a key path names, following object keys, dictionary keys and indices. */
function schemaOf(key: string, segments: readonly string[]): AnySchema {
  let current: AnySchema | undefined = configSchema;
  for (const segment of segments) {
    const structure: { shape?: Readonly<Record<string, AnySchema>>; element?: AnySchema } =
      current.structure;
    const { shape, element } = structure;
    current =
      shape === undefined ? element : Object.hasOwn(shape, segment) ? shape[segment] : undefined;
    if (current === undefined) throw unknownKey(key, 'is not a key of fireforge.json');
  }
  return current;
}

function describeKey(path: string, schema: AnySchema): ConfigKey {
  return {
    path,
    type: schema.type,
    doc: schema.doc,
    required: !schema.isOptional && schema.fallback === undefined,
    container: schema.structure.shape !== undefined,
    defaultValue: schema.fallback?.value as JsonValue | undefined,
  };
}

/** Every key `fireforge.json` declares, depth first, containers included. */
export function configKeys(): ConfigKey[] {
  return describeKeys(configSchema).map((info) => describeKey(info.path, info.schema));
}

function valueAt(document: JsonValue, segments: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const segment of segments) {
    if (Array.isArray(current))
      current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined;
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/**
 * Reads one key from `fireforge.json` as written, beside its type,
 * documentation and default.
 *
 * @param projectRoot - The project directory
 * @param key - A key path such as `firefox.version`
 * @throws `config-unknown-key` (exit code 8) for a key the schema does not declare
 */
export async function getConfigValue(projectRoot: string, key: string): Promise<ConfigValue> {
  const segments = segmentsOf(key);
  const schema = schemaOf(key, segments);
  const { document } = await readConfigDocument(projectRoot);
  return { ...describeKey(key, schema), value: valueAt(document, segments) };
}

function issueLines(prefix: string, issues: readonly SchemaIssue[]): string {
  return issues
    .map((issue) => {
      const path =
        issue.path === ''
          ? prefix
          : issue.path.startsWith('[') || prefix === ''
            ? `${prefix}${issue.path}`
            : `${prefix}.${issue.path}`;
      return `"${path}" ${issue.message}`;
    })
    .join('\n  ');
}

function invalidValue(key: string, issues: readonly SchemaIssue[]): FireForgeError {
  return new FireForgeError('config-invalid-value', issueLines(key, issues), {
    exitCode: ExitCode.INVALID_ARGUMENT,
  });
}

/**
 * Turns command-line text into the value a key takes. JSON is read as JSON
 * when the key accepts the result (`4`, `true`, `null`, `["a"]`), and the text
 * stays a string otherwise, so a string key never turns `128` into a number.
 *
 * @param key - A key path
 * @param text - The value as typed
 * @throws `config-invalid-value` (exit code 8) when the key accepts neither reading
 */
export function coerceConfigValue(key: string, text: string): JsonValue {
  const schema = schemaOf(key, segmentsOf(key));
  let parsed: JsonValue | undefined;
  try {
    parsed = parseJson(text);
  } catch {
    parsed = undefined;
  }
  const asJson = parsed === undefined ? undefined : schema.validate(parsed);
  if (asJson?.ok === true && parsed !== undefined) return parsed;
  const asText = schema.validate(text);
  if (asText.ok) return text;
  const issues =
    asJson !== undefined && !asJson.ok && typeof parsed !== 'string'
      ? asJson.issues
      : asText.issues;
  throw invalidValue(key, issues);
}

/** A copy of `document` with `value` at the key path, creating missing objects on the way. */
function withValue(
  document: JsonObject,
  key: string,
  segments: readonly string[],
  value: JsonValue
): JsonObject {
  const next = structuredClone(document);
  let parent: JsonValue = next;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (Array.isArray(parent)) {
      const position = /^\d+$/.test(segment) ? Number(segment) : Number.NaN;
      if (!(position <= parent.length)) {
        throw unknownKey(key, `names index ${segment} of a list of ${parent.length}`);
      }
      if (last) parent[position] = value;
      else parent = parent[position] ??= {};
    } else if (isRecord(parent)) {
      const object: JsonObject = parent;
      if (last) object[segment] = value;
      else parent = object[segment] ??= {};
    } else {
      throw unknownKey(key, 'reaches inside a value that is not an object or a list');
    }
  }
  return next;
}

/** The refusal to move a project to another mode by editing its `mode` key. */
function modeSwitch(target: JsonValue): FireForgeError {
  return new FireForgeError(
    'config-mode-switch',
    `"mode" cannot be set to ${JSON.stringify(target)} with "config set": the mode changes together with the "source" section and the files that hold the owned changes`,
    {
      exitCode: ExitCode.INVALID_ARGUMENT,
      hint:
        target === 'source'
          ? 'Run "fireforge migrate --to-source" to convert a patch-mode project to source mode.'
          : 'Run "fireforge export" to write the patch queue, then edit fireforge.json by hand: set "mode" to "patches" and remove "source" (docs/source-workflow.md, "Coming from patch mode, going back").',
    }
  );
}

/**
 * Sets one key of `fireforge.json` from command-line text. The value is typed
 * by the key's schema ({@link coerceConfigValue}), the whole resulting document
 * must validate, and only the changed value is rewritten. Concurrent edits are
 * serialised, so none is lost.
 *
 * @param projectRoot - The project directory
 * @param key - A key path such as `build.jobs`
 * @param text - The value as typed
 * @throws `config-unknown-key`, `config-invalid-value`, or `config-mode-switch` for a
 *   change of `mode` (exit code 8)
 */
export async function setConfigValue(
  projectRoot: string,
  key: string,
  text: string
): Promise<ConfigEdit> {
  const segments = segmentsOf(key);
  const value = coerceConfigValue(key, text);
  const lock = join(projectRoot, '.fireforge', 'config.lock');
  return withLock(lock, { label: CONFIG_FILE, info: { command: 'config set' } }, async () => {
    const current = await readConfigDocument(projectRoot);
    if (key === 'mode' && value !== (current.document['mode'] ?? modeKey.fallback?.value)) {
      throw modeSwitch(value);
    }
    const next = withValue(current.document, key, segments, value);
    const result = configSchema.validate(next);
    if (!result.ok) throw invalidValue('', result.issues);
    const edited = editJsonText(current.text, next) ?? stringifyJson(next);
    const changed = edited !== current.text;
    if (changed) await writeFile(join(projectRoot, CONFIG_FILE), edited);
    return { path: key, value, changed };
  });
}
