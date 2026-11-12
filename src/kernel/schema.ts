// SPDX-License-Identifier: EUPL-1.2
/**
 * Combinators that validate an untrusted document and give it a TypeScript
 * type. A schema is the single description of a document: its type is
 * inferred with {@link Infer}, every refusal names the full key path, and
 * {@link describeKeys} enumerates the keys with their documentation.
 *
 *     const Config = s.object({
 *       name: s.string({ min: 1 }).describe('Display name'),
 *       jobs: s.int({ min: 1, max: 64 }).default(4),
 *       tags: s.array(s.string()).optional(),
 *     });
 *     type Config = Infer<typeof Config>;  // { name: string; jobs: number; tags?: string[] }
 */
import { type ErrorDetails, FireForgeError } from './errors.js';
import { nearest } from './text.js';

/** One refusal: where in the document, and what is wrong there. */
export interface SchemaIssue {
  /** Key path such as `build.targets[2].name`; empty for the document itself. */
  path: string;
  message: string;
}

/** The outcome of {@link Schema.validate}. */
export type SchemaResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

/** How {@link Schema.parse} reports a refusal. */
export interface ParseOptions extends ErrorDetails {
  /** What is being read, for the message: a file path or a document name. */
  source?: string;
  /** Error code of the thrown {@link FireForgeError}. Default `document-invalid`. */
  code?: string;
}

const INVALID = Symbol('invalid');
type Checked<T> = T | typeof INVALID;
type Check<T> = (value: unknown, path: string, issues: SchemaIssue[]) => Checked<T>;

interface Structure {
  shape?: Readonly<Record<string, Schema<unknown, boolean>>>;
  element?: Schema<unknown, boolean>;
}

/** The type a schema accepts and produces. */
export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;

function show(value: unknown): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function refuse(issues: SchemaIssue[], path: string, message: string): typeof INVALID {
  issues.push({ path, message });
  return INVALID;
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  const segment = /^[\w$-]+$/.test(key) ? key : `[${JSON.stringify(key)}]`;
  return path === '' || segment.startsWith('[') ? `${path}${segment}` : `${path}.${segment}`;
}

/**
 * A validator for one value. `Optional` is a type-level marker that makes the
 * key optional in an enclosing {@link s.object}.
 */
export class Schema<T, Optional extends boolean = false> {
  /** Documentation attached with {@link Schema.describe}. */
  readonly doc: string | undefined;
  /** Whether an absent key is accepted. */
  readonly isOptional: Optional;
  /** The value an absent key takes, when one was given with {@link Schema.default}. */
  readonly fallback: { value: T } | undefined;

  /** @internal Use the combinators in {@link s}. */
  constructor(
    /** What the schema accepts, phrased to follow "must be". */
    readonly type: string,
    /** @internal */
    readonly check: Check<T>,
    /** @internal */
    readonly structure: Structure = {},
    extra: { doc?: string | undefined; optional?: Optional; fallback?: { value: T } } = {}
  ) {
    this.doc = extra.doc;
    this.isOptional = (extra.optional ?? false) as Optional;
    this.fallback = extra.fallback;
  }

  /** Validates without throwing, collecting every issue in the document. */
  validate(value: unknown): SchemaResult<T> {
    const issues: SchemaIssue[] = [];
    const checked = this.check(value, '', issues);
    return checked === INVALID || issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: checked };
  }

  /** Validates and returns the typed value, or throws one error listing every issue. */
  parse(value: unknown, options: ParseOptions = {}): T {
    const result = this.validate(value);
    if (result.ok) return result.value;
    const { source, code, ...details } = options;
    const lines = result.issues.map(
      (issue) => `${issue.path === '' ? 'The document' : `"${issue.path}"`} ${issue.message}`
    );
    const prefix = source === undefined ? '' : `${source}: `;
    const message =
      lines.length === 1 ? `${prefix}${lines[0]}` : `${prefix}\n  ${lines.join('\n  ')}`;
    throw new FireForgeError(code ?? 'document-invalid', message, details);
  }

  /** The same schema with a documentation string, shown by {@link describeKeys}. */
  describe(doc: string): Schema<T, Optional> {
    return new Schema(this.type, this.check, this.structure, { ...this.extra(), doc });
  }

  /** Accepts an absent (or `undefined`) value. In an object the key becomes optional. */
  optional(): Schema<T | undefined, true> {
    const check: Check<T | undefined> = (value, path, issues) =>
      value === undefined ? undefined : this.check(value, path, issues);
    return new Schema(this.type, check, this.structure, { doc: this.doc, optional: true });
  }

  /** Fills in `value` when the key is absent. The result is never undefined. */
  default(value: T): Schema<T> {
    const check: Check<T> = (input, path, issues) =>
      input === undefined ? value : this.check(input, path, issues);
    return new Schema(this.type, check, this.structure, { doc: this.doc, fallback: { value } });
  }

  /**
   * Adds a constraint the combinators cannot express. `test` returns what is
   * wrong, phrased to follow the key path ("must name an existing lane"), or
   * undefined when the value is fine.
   */
  refine(test: (value: T) => string | undefined): Schema<T, Optional> {
    const check: Check<T> = (value, path, issues) => {
      const checked = this.check(value, path, issues);
      if (checked === INVALID || (checked === undefined && this.isOptional)) return checked;
      const problem = test(checked);
      return problem === undefined ? checked : refuse(issues, path, problem);
    };
    return new Schema(this.type, check, this.structure, this.extra());
  }

  private extra(): { doc: string | undefined; optional: Optional; fallback?: { value: T } } {
    return {
      doc: this.doc,
      optional: this.isOptional,
      ...(this.fallback === undefined ? {} : { fallback: this.fallback }),
    };
  }
}

function primitive<T>(type: string, accepts: (value: unknown) => value is T): Schema<T> {
  return new Schema<T>(type, (value, path, issues) =>
    accepts(value) ? value : refuse(issues, path, `must be ${type} (got ${show(value)})`)
  );
}

function range(noun: string, bounds: { min?: number; max?: number }): string {
  const { min, max } = bounds;
  if (min !== undefined && max !== undefined) return `${noun} between ${min} and ${max}`;
  if (min !== undefined) return `${noun} of at least ${min}`;
  return max !== undefined ? `${noun} of at most ${max}` : noun;
}

function numeric(
  noun: string,
  bounds: { min?: number; max?: number },
  accepts: (value: number) => boolean
): Schema<number> {
  return primitive(
    range(noun, bounds),
    (value): value is number =>
      typeof value === 'number' &&
      accepts(value) &&
      value >= (bounds.min ?? -Infinity) &&
      value <= (bounds.max ?? Infinity)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Shape = Readonly<Record<string, Schema<unknown, boolean>>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Schema<unknown, true> ? K : never;
}[keyof S];
type ObjectOf<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

function object<S extends Shape>(
  shape: S,
  options: { unknownKeys?: 'refuse' | 'keep' } = {}
): Schema<ObjectOf<S>> {
  const known = Object.keys(shape);
  const check: Check<ObjectOf<S>> = (value, path, issues) => {
    if (!isPlainObject(value))
      return refuse(issues, path, `must be an object (got ${show(value)})`);
    const result: Record<string, unknown> = {};
    let valid = true;
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(shape, key)) continue;
      if (options.unknownKeys === 'keep') {
        result[key] = value[key];
        continue;
      }
      const suggestion = nearest(key, known);
      const hint = suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`;
      refuse(issues, childPath(path, key), `is not a known key.${hint}`);
      valid = false;
    }
    for (const [key, schema] of Object.entries(shape)) {
      const raw = value[key];
      if (raw === undefined && !schema.isOptional && schema.fallback === undefined) {
        refuse(issues, childPath(path, key), 'is required');
        valid = false;
        continue;
      }
      const checked = schema.check(raw, childPath(path, key), issues);
      if (checked === INVALID) valid = false;
      else if (checked !== undefined) result[key] = checked;
    }
    return valid ? (result as ObjectOf<S>) : INVALID;
  };
  return new Schema('an object', check, { shape });
}

function array<T>(
  item: Schema<T, boolean>,
  bounds: { min?: number; max?: number } = {}
): Schema<T[]> {
  const type = `an array of ${item.type}`;
  const check: Check<T[]> = (value, path, issues) => {
    if (!Array.isArray(value)) return refuse(issues, path, `must be ${type} (got ${show(value)})`);
    if (value.length < (bounds.min ?? 0) || value.length > (bounds.max ?? Infinity)) {
      return refuse(issues, path, `must have ${range('a length', bounds)} (got ${value.length})`);
    }
    const checked = value.map((entry, index) => item.check(entry, childPath(path, index), issues));
    return checked.includes(INVALID) ? INVALID : (checked as T[]);
  };
  return new Schema(type, check, { element: item });
}

function record<T>(
  value: Schema<T, boolean>,
  options: { key?: Schema<string> } = {}
): Schema<Record<string, T>> {
  const check: Check<Record<string, T>> = (input, path, issues) => {
    if (!isPlainObject(input))
      return refuse(issues, path, `must be an object (got ${show(input)})`);
    const result: Record<string, T> = {};
    let valid = true;
    for (const [key, raw] of Object.entries(input)) {
      const at = childPath(path, key);
      const keyOk = options.key === undefined || options.key.check(key, at, issues) !== INVALID;
      const checked = value.check(raw, at, issues);
      if (!keyOk || checked === INVALID) valid = false;
      else result[key] = checked;
    }
    return valid ? result : INVALID;
  };
  return new Schema(`an object of ${value.type}`, check, { element: value });
}

function union<S extends readonly Schema<unknown, boolean>[]>(
  ...members: S
): Schema<Infer<S[number]>> {
  const type = members.map((member) => member.type).join(', or ');
  const check: Check<Infer<S[number]>> = (value, path, issues) => {
    const attempts: SchemaIssue[][] = [];
    for (const member of members) {
      const own: SchemaIssue[] = [];
      const checked = member.check(value, path, own);
      if (checked !== INVALID && own.length === 0) return checked as Infer<S[number]>;
      attempts.push(own);
    }
    // A member that accepted the value's outer type and failed inside it is the
    // one the author meant, so its issues are the useful ones.
    const inner = attempts.filter((own) => own.every((issue) => issue.path !== path));
    const [only] = inner;
    if (inner.length === 1 && only !== undefined) {
      issues.push(...only);
      return INVALID;
    }
    return refuse(issues, path, `must be ${type} (got ${show(value)})`);
  };
  return new Schema(type, check);
}

/** The schema combinators. */
export const s = {
  /** A string, optionally bounded in length or matching `pattern` (described by `format`). */
  string(options: { min?: number; max?: number; pattern?: RegExp; format?: string } = {}) {
    const bounded = options.min !== undefined || options.max !== undefined;
    const noun =
      options.format ??
      (options.pattern !== undefined
        ? `a string matching ${String(options.pattern)}`
        : options.min === 1 && options.max === undefined
          ? 'a non-empty string'
          : range(bounded ? 'a string with a length' : 'a string', options));
    return primitive(
      noun,
      (value): value is string =>
        typeof value === 'string' &&
        value.length >= (options.min ?? 0) &&
        value.length <= (options.max ?? Infinity) &&
        (options.pattern?.test(value) ?? true)
    );
  },
  /** A finite number within optional bounds. */
  number: (bounds: { min?: number; max?: number } = {}) =>
    numeric('a number', bounds, Number.isFinite),
  /** A safe integer within optional bounds. */
  int: (bounds: { min?: number; max?: number } = {}) =>
    numeric('an integer', bounds, Number.isSafeInteger),
  /** `true` or `false`. */
  boolean: () => primitive('a boolean', (value): value is boolean => typeof value === 'boolean'),
  /** Exactly one value. */
  literal: <const V extends string | number | boolean | null>(expected: V) =>
    primitive(show(expected), (value): value is V => value === expected),
  /** One of a fixed set of strings. */
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    primitive(`one of: ${values.join(', ')}`, (value): value is V[number] =>
      values.some((candidate) => candidate === value)
    ),
  /** Anything at all. For a subtree a later reader validates. */
  unknown: () => new Schema<unknown>('any value', (value) => value),
  /**
   * An object with exactly the keys of `shape`. An unknown key is refused,
   * naming the nearest known one, unless `unknownKeys: 'keep'` passes it through.
   */
  object,
  /** An array of `item`, optionally bounded in length. */
  array,
  /** An object used as a dictionary: any keys (optionally validated), values of one schema. */
  record,
  /** The first member that accepts the value. */
  union,
};

/** One key of a document, as {@link describeKeys} reports it. */
export interface KeyInfo {
  /** Dotted path from the document root. */
  path: string;
  /** What the key accepts, in words. */
  type: string;
  doc: string | undefined;
  required: boolean;
  /** Whether the key holds further keys rather than a value. */
  container: boolean;
  /** The key's own schema, for validating a single edited value. */
  schema: Schema<unknown, boolean>;
}

/**
 * Lists every key an object schema declares, depth first, including the
 * containers. Arrays and dictionaries are values: their inside is not listed.
 *
 * @param schema - An object schema
 * @param prefix - Path of `schema` itself within a larger document
 */
export function describeKeys(schema: Schema<unknown, boolean>, prefix = ''): KeyInfo[] {
  const keys: KeyInfo[] = [];
  for (const [name, child] of Object.entries(schema.structure.shape ?? {})) {
    const path = childPath(prefix, name);
    keys.push({
      path,
      type: child.type,
      doc: child.doc,
      required: !child.isOptional && child.fallback === undefined,
      container: child.structure.shape !== undefined,
      schema: child,
    });
    keys.push(...describeKeys(child, path));
  }
  return keys;
}

/**
 * The schema of the value at a dotted key path, following object keys,
 * dictionary keys and array indices, or undefined when the path names nothing.
 *
 * @param schema - The document's schema
 * @param path - Dotted path such as `build.targets.0.name`
 */
export function schemaAt(
  schema: Schema<unknown, boolean>,
  path: string
): Schema<unknown, boolean> | undefined {
  let current: Schema<unknown, boolean> | undefined = schema;
  for (const segment of path.split('.').filter((part) => part.length > 0)) {
    if (current === undefined) return undefined;
    const { shape, element }: Structure = current.structure;
    current =
      shape === undefined ? element : Object.hasOwn(shape, segment) ? shape[segment] : undefined;
  }
  return current;
}
