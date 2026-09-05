// SPDX-License-Identifier: EUPL-1.2
/**
 * RuleTester coverage for the local ESLint rules.
 *
 * These rules are `error`-level in `eslint.config.js`, so an untested false
 * positive blocks the gate on correct code. The two shapes that look like
 * violations but are not appear as `valid` cases below: a regex literal that
 * is a metacharacter class but not a regex escape, and a ternary whose
 * `String(...)` fallback takes a different value than the tested error.
 */
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import plugin from './index.js';

// `RuleTester` drives mocha-style globals. Vitest supplies compatible ones.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const js = new RuleTester();
const ts = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

const { rules } = plugin;

ts.run('no-open-coded-to-error', rules['no-open-coded-to-error'], {
  valid: [
    'const m = toError(error).message;',
    // The fallback names a different value, so this is not the idiom the rule
    // replaces. Reporting it told the author to write `toError(e).message`,
    // which would silently change behaviour.
    'const m = e instanceof Error ? e.message : String(other);',
    'const m = e instanceof Error ? e.message : String();',
    'const m = e instanceof Error ? e.message : String(e, 2);',
    // Not a `.message` read.
    'const m = e instanceof Error ? e.stack : String(e);',
    // Not an `instanceof Error` test.
    'const m = e instanceof TypeError ? e.message : String(e);',
    'const m = (e as Foo).message;',
  ],
  invalid: [
    {
      code: 'const m = e instanceof Error ? e.message : String(e);',
      errors: [{ messageId: 'openCoded', data: { name: 'e' } }],
    },
    {
      code: 'const m = (err as Error).message;',
      errors: [{ messageId: 'errorCast' }],
    },
  ],
});

ts.run('no-errno-cast', rules['no-errno-cast'], {
  valid: [
    'const code = getNodeErrorCode(error);',
    'const x = value as Error;',
    'const x = value as string | undefined;',
  ],
  invalid: [
    {
      code: 'const code = (error as NodeJS.ErrnoException).code;',
      errors: [{ messageId: 'errnoCast' }],
    },
    {
      code: 'const code = (error as NodeJS.ErrnoException | undefined)?.code;',
      errors: [{ messageId: 'errnoCast' }],
    },
    // The errno type buried later in a union: `.find`-based matching only saw
    // the first type reference, so this cast went unreported.
    {
      code: 'const code = (error as Error | NodeJS.ErrnoException).code;',
      errors: [{ messageId: 'errnoCast' }],
    },
    // Bare `ErrnoException` pulled in via import. The same unchecked cast.
    {
      code: 'const code = (error as ErrnoException).code;',
      errors: [{ messageId: 'errnoCast' }],
    },
  ],
});

js.run('prefer-shared-regex-escape', rules['prefer-shared-regex-escape'], {
  valid: [
    'const escaped = escapeRegex(value);',
    // A metacharacter-looking character class that is not a regex escape. The
    // rule used to report every one of these purely on the literal's shape.
    'const parts = value.split(/[.*+?^${}()|[\\]\\\\]/);',
    'const hasMeta = /[.*+?^${}()|[\\]\\\\]/.test(value);',
    "const stripped = value.replace(/[.*+?^${}()|[\\]\\\\]/g, '');",
    "const stripped = value.replace(/[.*+?^${}()|[\\]\\\\]/g, '_');",
    // A real escape, but of a different class: one or two metacharacters is
    // not the shared helper's job.
    "const escaped = value.replace(/[.*]/g, '\\\\$&');",
    // `escapeForX` helpers escape for other targets. Telling them to import
    // a regex escaper is wrong.
    'function escapeForHtml(value) { return value; }',
    'function escapeForShell(value) { return value; }',
    'function escapeForJson(value) { return value; }',
    // A non-function binding that merely shares the name is not a helper.
    'const escapeRegex = imported.escapeRegex;',
  ],
  invalid: [
    {
      code: "const escaped = value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
      errors: [{ messageId: 'inlineEscape' }],
    },
    {
      code: 'function escapeRegex(value) { return value; }',
      errors: [{ messageId: 'localHelper' }],
    },
    {
      code: 'function escapeRegExp(value) { return value; }',
      errors: [{ messageId: 'localHelper' }],
    },
    // Arrow and function-expression spellings of the same local helper. A
    // declaration-only selector let these through.
    {
      code: 'const escapeRegex = (value) => value;',
      errors: [{ messageId: 'localHelper' }],
    },
    {
      code: 'const escapeRegExp = function (value) { return value; };',
      errors: [{ messageId: 'localHelper' }],
    },
  ],
});

ts.run('no-untyped-json-document', rules['no-untyped-json-document'], {
  valid: [
    // The replacement types themselves.
    'export function f(doc: JsonObject): JsonValue | undefined { return doc["x"]; }',
    // Non-exported helpers may narrow however they like.
    'function local(data: Record<string, unknown>): void { void data; }',
    // A generic bound constrains a caller-supplied shape. It is not a
    // dictionary contract handed to callers.
    'export function pick<T extends Record<string, unknown>>(obj: T): T { return obj; }',
    // Annotations inside the body are local code, not exported surface.
    'export function g(): void { const x: Record<string, unknown> = {}; void x; }',
    // A nested helper inside an exported function body is not exported.
    'export function h(): void { const inner = (d: Record<string, unknown>): void => { void d; }; void inner; }',
    // Interface members are shapes, not function signatures.
    'export interface Args { args: Record<string, unknown>; }',
    // Class methods are exempt (ParsedRecord's constructor pattern).
    'export class C { constructor(data: Record<string, unknown>) { void data; } }',
    // Other Record instantiations carry a real value contract.
    'export function typed(map: Record<string, string[]>): void { void map; }',
  ],
  invalid: [
    {
      code: 'export function f(data: Record<string, unknown>): void { void data; }',
      errors: [{ messageId: 'untypedDocument' }],
    },
    {
      code: 'export function g(): Record<string, unknown> { return {}; }',
      errors: [{ messageId: 'untypedDocument' }],
    },
    // Wrapped in a generic. The dictionary still reaches the caller.
    {
      code: 'export async function h(): Promise<Record<string, unknown>> { return {}; }',
      errors: [{ messageId: 'untypedDocument' }],
    },
    {
      code: 'export function r(d: Readonly<Record<string, unknown>>): void { void d; }',
      errors: [{ messageId: 'untypedDocument' }],
    },
    // Arrow spelling of an exported function.
    {
      code: 'export const j = (d: Record<string, unknown>): void => { void d; };',
      errors: [{ messageId: 'untypedDocument' }],
    },
    // A callback contract inside an exported signature binds callers too.
    {
      code: 'export function k(cb: (d: Record<string, unknown>) => void): void { void cb; }',
      errors: [{ messageId: 'untypedDocument' }],
    },
    // Overload signatures (TSDeclareFunction) are the exported surface.
    {
      code: 'export function m(d: Record<string, unknown>): void;',
      errors: [{ messageId: 'untypedDocument' }],
    },
  ],
});

js.run('no-empty-jsdoc', rules['no-empty-jsdoc'], {
  valid: [
    '/** Does the thing. */\nfunction f() {}',
    '/**\n * Multi-line contract.\n */\nfunction f() {}',
    '/* not jsdoc */\nfunction f() {}',
    '// line comment\nfunction f() {}',
  ],
  invalid: [
    { code: '/** */\nfunction f() {}', errors: [{ messageId: 'emptyJsdoc' }] },
    { code: '/**\n *\n */\nfunction f() {}', errors: [{ messageId: 'emptyJsdoc' }] },
  ],
});

js.run('no-open-coded-tty-check', rules['no-open-coded-tty-check'], {
  valid: [
    // The spinner gate asks a different question (can output be redrawn), so
    // it must not be routed through a prompt-answerability predicate.
    { code: 'const ok = process.stdout.isTTY && process.stderr.isTTY;' },
    { code: 'const ok = stdioIsInteractive();' },
    { code: 'const ok = process.stdin.isTTY;' },
  ],
  invalid: [
    {
      code: 'const isInteractive = process.stdin.isTTY && process.stdout.isTTY;',
      errors: [{ messageId: 'openCoded' }],
    },
    {
      code: 'if (!(process.stdin.isTTY && process.stdout.isTTY)) { throw new Error("x"); }',
      errors: [{ messageId: 'openCoded' }],
    },
  ],
});

ts.run('no-return-type-of-import', rules['no-return-type-of-import'], {
  valid: [
    // Named type imported instead of derived.
    "import type { ProjectPaths } from '../types/config.js'; let p: ProjectPaths;",
    // Package import: the author cannot export a name from node_modules.
    "import { spinner } from '@clack/prompts'; let s: ReturnType<typeof spinner>;",
    // Global, not imported.
    'let t: ReturnType<typeof setTimeout>;',
    // Local declaration, not imported.
    'function f() { return 1; } let n: ReturnType<typeof f>;',
    // Member expression query is not a bare imported identifier.
    "import { vi } from 'vitest'; let m: ReturnType<typeof vi.fn>;",
    // `typeof X` outside ReturnType is fine.
    "import { getProjectPaths } from './config.js'; let g: typeof getProjectPaths;",
  ],
  invalid: [
    {
      code: "import { getProjectPaths } from './config.js'; let p: ReturnType<typeof getProjectPaths>;",
      errors: [
        {
          messageId: 'returnTypeOfImport',
          data: { name: 'getProjectPaths', source: './config.js' },
        },
      ],
    },
    {
      // `import type` bindings count too.
      code: "import type { loadConfig } from '../core/config.js'; type C = Awaited<ReturnType<typeof loadConfig>>;",
      errors: [
        {
          messageId: 'returnTypeOfImport',
          data: { name: 'loadConfig', source: '../core/config.js' },
        },
      ],
    },
    {
      code: "import * as cfg from './config.js'; let p: ReturnType<typeof cfg>;",
      errors: [{ messageId: 'returnTypeOfImport' }],
    },
  ],
});
