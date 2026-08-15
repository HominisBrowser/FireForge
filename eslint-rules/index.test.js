// SPDX-License-Identifier: EUPL-1.2
/**
 * RuleTester coverage for the local ESLint rules.
 *
 * These rules are `error`-level in `eslint.config.js` and shipped with no
 * tests, so their false positives were only discoverable by running the linter
 * over hypothetical code. Both of the ones fixed in 0.41.0 are `valid` cases
 * below: a regex literal that is a metacharacter class but is not a regex
 * escape, and a ternary whose `String(...)` fallback takes a different value
 * than the tested error.
 */
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import plugin from './index.js';

// `RuleTester` drives mocha-style globals; vitest supplies compatible ones.
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
    // The fallback names a DIFFERENT value, so this is not the idiom the rule
    // replaces — reporting it told the author to write `toError(e).message`,
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
    // the FIRST type reference, so this cast went unreported.
    {
      code: 'const code = (error as Error | NodeJS.ErrnoException).code;',
      errors: [{ messageId: 'errnoCast' }],
    },
    // Bare `ErrnoException` pulled in via import — the same unchecked cast.
    {
      code: 'const code = (error as ErrnoException).code;',
      errors: [{ messageId: 'errnoCast' }],
    },
  ],
});

js.run('prefer-shared-regex-escape', rules['prefer-shared-regex-escape'], {
  valid: [
    'const escaped = escapeRegex(value);',
    // A metacharacter-looking character class that is NOT a regex escape. The
    // rule used to report every one of these purely on the literal's shape.
    'const parts = value.split(/[.*+?^${}()|[\\]\\\\]/);',
    'const hasMeta = /[.*+?^${}()|[\\]\\\\]/.test(value);',
    "const stripped = value.replace(/[.*+?^${}()|[\\]\\\\]/g, '');",
    "const stripped = value.replace(/[.*+?^${}()|[\\]\\\\]/g, '_');",
    // A real escape, but of a different class — one or two metacharacters is
    // not the shared helper's job.
    "const escaped = value.replace(/[.*]/g, '\\\\$&');",
    // `escapeForX` helpers escape for OTHER targets; telling them to import a
    // regex escaper is wrong.
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
    // Arrow and function-expression spellings of the same local helper — a
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
