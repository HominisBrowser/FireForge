// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, expectTypeOf, it } from 'vitest';

import { ExitCode, FireForgeError } from './errors.js';
import { describeKeys, type Infer, s, schemaAt } from './schema.js';

const Config = s.object({
  name: s.string({ min: 1 }).describe('Display name of the browser'),
  mode: s.enum(['patches', 'source']).default('patches'),
  firefox: s.object({
    version: s.string({ pattern: /^\d+\.\d+/, format: 'a Firefox version such as 140.0' }),
    sha256: s.string().optional(),
  }),
  build: s
    .object({
      jobs: s.int({ min: 1, max: 256 }).describe('Parallel compile jobs').default(4),
      lanes: s
        .array(s.object({ name: s.string(), paths: s.array(s.string(), { min: 1 }) }))
        .optional(),
    })
    .optional(),
  env: s.record(s.string()).optional(),
  check: s.union(s.boolean(), s.object({ maxWarnings: s.int({ min: 0 }) })).optional(),
});

function issues(schema: { validate(value: unknown): unknown }, value: unknown): string[] {
  const result = schema.validate(value) as {
    ok: boolean;
    issues?: { path: string; message: string }[];
  };
  return (result.issues ?? []).map((issue) => `${issue.path}: ${issue.message}`);
}

describe('type inference', () => {
  it('derives required, optional and defaulted keys from the declaration', () => {
    expectTypeOf<Infer<typeof Config>>().toEqualTypeOf<{
      name: string;
      mode: 'patches' | 'source';
      firefox: { version: string; sha256?: string };
      build?: { jobs: number; lanes?: { name: string; paths: string[] }[] };
      env?: Record<string, string>;
      check?: boolean | { maxWarnings: number };
    }>();
  });
});

describe('parse', () => {
  it('returns the typed value, filling defaults and omitting absent optional keys', () => {
    const parsed = Config.parse({ name: 'Mine', firefox: { version: '140.0' }, build: {} });
    expect(parsed).toEqual({
      name: 'Mine',
      mode: 'patches',
      firefox: { version: '140.0' },
      build: { jobs: 4 },
    });
    expect(Object.hasOwn(parsed, 'env')).toBe(false);
  });

  it('names the full key path of every problem in one error', () => {
    expect(
      issues(Config, {
        name: '',
        mode: 'both',
        firefox: { version: 'latest' },
        build: {
          jobs: 0,
          lanes: [
            { name: 'a', paths: ['x'] },
            { name: 3, paths: [] },
          ],
        },
        env: { PATH: 1 },
      })
    ).toEqual([
      'name: must be a non-empty string (got "")',
      'mode: must be one of: patches, source (got "both")',
      'firefox.version: must be a Firefox version such as 140.0 (got "latest")',
      'build.jobs: must be an integer between 1 and 256 (got 0)',
      'build.lanes[1].name: must be a string (got 3)',
      'build.lanes[1].paths: must have a length of at least 1 (got 0)',
      'env.PATH: must be a string (got 1)',
    ]);
  });

  it('refuses an unknown key and suggests the nearest known one', () => {
    expect(
      issues(Config, { name: 'x', firefox: { version: '1.0', sha265: 'x' }, extra: 1 })
    ).toEqual([
      'extra: is not a known key.',
      'firefox.sha265: is not a known key. Did you mean "sha256"?',
    ]);
  });

  it('reports a missing required key', () => {
    expect(issues(Config, { firefox: {} })).toEqual([
      'name: is required',
      'firefox.version: is required',
    ]);
  });

  it('reports the wrong outer type at the document root', () => {
    expect(issues(Config, [])).toEqual([': must be an object (got [])']);
    expect(issues(s.int(), 1.5)).toEqual([': must be an integer (got 1.5)']);
  });

  it('throws a FireForgeError carrying the source, code, exit code and hint', () => {
    let thrown: unknown;
    try {
      Config.parse(
        { name: 'x', firefox: { version: 1 } },
        {
          source: 'fireforge.json',
          code: 'invalid-config',
          exitCode: ExitCode.CONFIG_ERROR,
          hint: 'Fix it',
        }
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FireForgeError);
    expect(thrown).toMatchObject({
      code: 'invalid-config',
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Fix it',
      message: 'fireforge.json: "firefox.version" must be a Firefox version such as 140.0 (got 1)',
    });
    expect(() => s.string().parse(1)).toThrow('The document must be a string (got 1)');
  });

  it('lists several problems on separate lines', () => {
    expect(() => Config.parse({}, { source: 'fireforge.json' })).toThrow(
      'fireforge.json: \n  "name" is required\n  "firefox" is required'
    );
  });
});

describe('combinators', () => {
  it.each([
    [
      'number bounds',
      s.number({ min: 0, max: 1 }),
      2,
      ': must be a number between 0 and 1 (got 2)',
    ],
    ['number rejects NaN', s.number(), NaN, ': must be a number (got null)'],
    ['int lower bound', s.int({ min: 1 }), 0, ': must be an integer of at least 1 (got 0)'],
    ['int upper bound', s.int({ max: 9 }), 10, ': must be an integer of at most 9 (got 10)'],
    ['boolean', s.boolean(), 'yes', ': must be a boolean (got "yes")'],
    ['literal', s.literal(1), 2, ': must be 1 (got 2)'],
    [
      'string length',
      s.string({ min: 2, max: 3 }),
      'a',
      ': must be a string with a length between 2 and 3 (got "a")',
    ],
    [
      'string pattern',
      s.string({ pattern: /^a/ }),
      'b',
      ': must be a string matching /^a/ (got "b")',
    ],
    ['array', s.array(s.int()), 'x', ': must be an array of an integer (got "x")'],
    [
      'array length',
      s.array(s.int(), { max: 1 }),
      [1, 2],
      ': must have a length of at most 1 (got 2)',
    ],
    ['record', s.record(s.int()), [], ': must be an object (got [])'],
  ])('%s', (_name, schema, value, expected) => {
    expect(issues(schema, value)).toEqual([expected]);
  });

  it('accepts what each combinator describes', () => {
    expect(s.literal(null).parse(null)).toBeNull();
    expect(s.unknown().parse({ any: ['thing'] })).toEqual({ any: ['thing'] });
    expect(s.record(s.int(), { key: s.string({ pattern: /^[a-z]+$/ }) }).parse({ a: 1 })).toEqual({
      a: 1,
    });
    expect(s.object({ a: s.int() }, { unknownKeys: 'keep' }).parse({ a: 1, b: 2 })).toEqual({
      a: 1,
      b: 2,
    });
  });

  it('validates record keys when given a key schema', () => {
    const schema = s.record(s.int(), {
      key: s.string({ pattern: /^[a-z]+$/, format: 'a lowercase name' }),
    });
    expect(issues(schema, { Bad: 1 })).toEqual(['Bad: must be a lowercase name (got "Bad")']);
  });

  it('quotes a key that is not a plain identifier in the path', () => {
    expect(issues(s.record(s.int()), { 'a.b': 'x' })).toEqual([
      '["a.b"]: must be an integer (got "x")',
    ]);
    expect(issues(s.object({ o: s.record(s.int()) }), { o: { 'a b': 'x' } })).toEqual([
      'o["a b"]: must be an integer (got "x")',
    ]);
  });

  it('reports the inner problem of the union member whose outer type matched', () => {
    expect(
      issues(Config, { name: 'x', firefox: { version: '1.0' }, check: { maxWarnings: -1 } })
    ).toEqual(['check.maxWarnings: must be an integer of at least 0 (got -1)']);
    expect(issues(Config, { name: 'x', firefox: { version: '1.0' }, check: 'yes' })).toEqual([
      'check: must be a boolean, or an object (got "yes")',
    ]);
  });

  it('runs a refinement only on a value that passed, with its own message', () => {
    const even = s.int().refine((value) => (value % 2 === 0 ? undefined : 'must be even'));
    expect(even.parse(4)).toBe(4);
    expect(issues(even, 3)).toEqual([': must be even']);
    expect(issues(even, 'x')).toEqual([': must be an integer (got "x")']);
    const optional = s.object({ n: even.optional() });
    expect(optional.parse({})).toEqual({});
  });

  it('truncates a long value in the message', () => {
    const [message] = issues(s.int(), 'x'.repeat(200));
    expect(message?.length).toBeLessThan(120);
    expect(message).toContain('...');
  });
});

describe('describeKeys and schemaAt', () => {
  it('lists every declared key with its type, documentation and requiredness', () => {
    expect(
      describeKeys(Config).map(({ path, type, doc, required, container }) => ({
        path,
        type,
        doc,
        required,
        container,
      }))
    ).toEqual([
      {
        path: 'name',
        type: 'a non-empty string',
        doc: 'Display name of the browser',
        required: true,
        container: false,
      },
      {
        path: 'mode',
        type: 'one of: patches, source',
        doc: undefined,
        required: false,
        container: false,
      },
      { path: 'firefox', type: 'an object', doc: undefined, required: true, container: true },
      {
        path: 'firefox.version',
        type: 'a Firefox version such as 140.0',
        doc: undefined,
        required: true,
        container: false,
      },
      {
        path: 'firefox.sha256',
        type: 'a string',
        doc: undefined,
        required: false,
        container: false,
      },
      { path: 'build', type: 'an object', doc: undefined, required: false, container: true },
      {
        path: 'build.jobs',
        type: 'an integer between 1 and 256',
        doc: 'Parallel compile jobs',
        required: false,
        container: false,
      },
      {
        path: 'build.lanes',
        type: 'an array of an object',
        doc: undefined,
        required: false,
        container: false,
      },
      {
        path: 'env',
        type: 'an object of a string',
        doc: undefined,
        required: false,
        container: false,
      },
      {
        path: 'check',
        type: 'a boolean, or an object',
        doc: undefined,
        required: false,
        container: false,
      },
    ]);
  });

  it('finds the schema of one key, so a single edited value can be validated', () => {
    const jobs = schemaAt(Config, 'build.jobs');
    expect(jobs?.parse(8)).toBe(8);
    expect(() => jobs?.parse(0, { source: 'build.jobs' })).toThrow('between 1 and 256');
    expect(schemaAt(Config, 'env.ANYTHING')?.type).toBe('a string');
    expect(schemaAt(Config, 'build.lanes.0.name')?.type).toBe('a string');
    expect(schemaAt(Config, 'build.nope')).toBeUndefined();
    expect(schemaAt(Config, 'name.deeper')).toBeUndefined();
    expect(schemaAt(Config, '')).toBe(Config);
  });
});
