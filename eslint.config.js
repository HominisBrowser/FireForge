// SPDX-License-Identifier: EUPL-1.2
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

import fireforge from './eslint-rules/index.js';

const jsToolingFiles = ['eslint.config.js', 'scripts/**/*.mjs', 'eslint-rules/**/*.js'];

const sharedRules = {
  'no-throw-literal': 'error',
  // `Object.hasOwn` everywhere. One straggler still called
  // `Object.prototype.hasOwnProperty.call(...)`.
  'prefer-object-has-own': 'error',
  'prefer-const': 'error',
  'no-var': 'error',
  // Ceiling chosen in 0.31.0, after refactoring everything that exceeded it.
  // Command orchestrators legitimately sit in the 20s, so a lower bar would
  // force splits that spread linear flows across helpers.
  complexity: ['error', 30],
  // Twenty functions had grown to 7-10 positional parameters, which forced
  // callers to pad with `undefined` to reach a trailing optional. All of them
  // now take one options object. 6 is the ceiling the tree already meets.
  'max-params': ['error', 6],
  'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': [
    'error',
    {
      max: 150,
      skipBlankLines: true,
      skipComments: true,
      IIFEs: true,
    },
  ],
  'simple-import-sort/imports': [
    'error',
    {
      groups: [['^\\u0000'], ['^node:'], ['^@?\\w'], ['^'], ['^\\.']],
    },
  ],
  'simple-import-sort/exports': 'error',
};

const jsdocSourceFiles = ['src/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      'coverage/',
      'dist/',
      'node_modules/',
      // Test fixtures: real-shape Firefox engine files copied verbatim into
      // the suite. They are not part of the project's TypeScript graph and do
      // not follow project lint rules (BSD/MPL header style, var/let mix,
      // unused parameters, and so on). The tests that consume them assert
      // behavior, not style.
      'src/core/__tests__/__fixtures__/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    plugins: {
      'simple-import-sort': simpleImportSort,
      fireforge,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      // Local rules (eslint-rules/index.js). Each one pins a convention that
      // the 2026-08-06 quality survey found hand-rolled across dozens of
      // files, in two cases with a silently broken copy. They landed in 0.41.0
      // together with the last of the corresponding fixes, so they start
      // clean.
      'fireforge/no-open-coded-to-error': 'error',
      'fireforge/no-errno-cast': 'error',
      'fireforge/prefer-shared-regex-escape': 'error',
      'fireforge/no-empty-jsdoc': 'error',
      // Raw JSON documents are typed JsonObject/JsonValue (src/types/json.ts).
      // This stops the untyped-dictionary contract from re-accreting on
      // exported functions.
      'fireforge/no-untyped-json-document': 'error',
      // The TTY pair check was open-coded at eighteen sites, with nine
      // different non-TTY refusal strings between them.
      // `stdioIsInteractive()` in core/destructive.ts is now the single
      // spelling.
      'fireforge/no-open-coded-tty-check': 'error',
      // `ReturnType<typeof getProjectPaths>` spelled the parameter type at
      // fourteen sites while `ProjectPaths` sat exported next to the
      // function. Name the type. Derive it only from package imports.
      // Every former `Awaited<ReturnType<typeof loadConfig>>` /
      // `ReturnType<typeof parseObject>` site now imports the named type the
      // function is declared to return (FireForgeConfig, ParsedRecord, ...).
      'fireforge/no-return-type-of-import': 'error',
      // `X as unknown as Y` launders any type into any other. The two
      // sanctioned bridge casts (ast-utils.toPositionedProgram, and
      // furnace-config-order's FurnaceConfig-to-JsonObject re-entry) carry
      // targeted disables with their justification.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSAsExpression.expression',
          message:
            'No `as unknown as` chains — parse the value at its boundary, or route through a ' +
            'documented bridge helper (see toPositionedProgram in src/core/ast-utils.ts).',
        },
      ],
      // `${String(n)}` inside a template literal was spelled 204 times, while
      // `restrict-template-expressions` already allows numbers. The removal
      // pass is only worth doing once, so the rule keeps it done.
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
        },
      ],
      'no-console': ['error', { allow: ['error'] }],
      // The "process.exit only in bin/" invariant used to be enforced by
      // comments alone. The bin/** override below grants the one legitimate
      // caller. Setting process.exitCode stays legal everywhere.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message:
            'Only bin/fireforge.ts may call process.exit(); set process.exitCode or throw a FireForgeError instead.',
        },
      ],
    },
  },
  {
    files: ['bin/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    files: jsToolingFiles,
    ...tseslint.configs.disableTypeChecked,
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'module',
      globals: {
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      ...sharedRules,
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts', 'src/test-utils/**/*.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      // Test assertions legitimately construct and inspect raw throwables to
      // pin the shapes production code must survive. Routing those through
      // `toError` would assert the helper rather than the behaviour.
      'fireforge/no-open-coded-to-error': 'off',
      'fireforge/no-errno-cast': 'off',
      // Tests deliberately forge malformed inputs (`as unknown as X`) and
      // untyped fixtures to pin the shapes production code must reject.
      'fireforge/no-untyped-json-document': 'off',
      // Test doubles are typed off the real function on purpose
      // (`Awaited<ReturnType<typeof readdir>>` fixtures and the like).
      'fireforge/no-return-type-of-import': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: jsdocSourceFiles,
    ignores: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    plugins: {
      jsdoc,
    },
    settings: {
      jsdoc: {
        mode: 'typescript',
      },
    },
    rules: {
      // `check-param-names` catches an @param list that has drifted from the
      // signature. 37 doc blocks had drifted, including two attached to the
      // wrong declaration. Destructured-property checking is off on purpose:
      // with it on, the rule demands an `@param options.x` line for every
      // field of every options bag, which is 29 complaints about a convention
      // this codebase does not follow and never claimed to.
      'jsdoc/check-param-names': ['error', { checkDestructured: false, checkRestProperty: false }],
      // Cheap and independent: flags a documented @returns on a function that
      // returns nothing.
      'jsdoc/require-returns-check': 'error',
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: {
            ancestorsOnly: true,
            esm: true,
          },
          require: {
            ClassDeclaration: false,
            FunctionDeclaration: true,
            MethodDefinition: false,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
    },
  },
  eslintConfigPrettier
);
