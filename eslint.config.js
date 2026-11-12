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
  // `Object.hasOwn` everywhere, not `Object.prototype.hasOwnProperty.call(...)`.
  'prefer-object-has-own': 'error',
  'prefer-const': 'error',
  'no-var': 'error',
  complexity: ['error', 25],
  // Past five positional parameters, take one options object.
  'max-params': ['error', 5],
  // A file is one cohesive unit and is never split to satisfy this number
  // (contributing/architecture.md). The ceiling only catches a module that
  // has stopped being one unit.
  'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': [
    'error',
    {
      max: 120,
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

const testFiles = ['src/**/*.test.ts', 'src/testing/**/*.ts'];

// The layering in contributing/architecture.md. Each module lists the modules
// it may import; everything else under src/ is refused. A module other than
// kernel, cli and testing is imported only through its index.ts.
const OPEN_MODULES = ['kernel', 'cli', 'testing'];
const BASE = ['kernel', 'cli'];
const SHARED = [...BASE, 'config', 'git', 'diff', 'mozbuild', 'syntax'];
const FEATURE = [...SHARED, 'project'];
const MODULE_IMPORTS = {
  kernel: [],
  cli: ['kernel'],
  config: BASE,
  git: BASE,
  diff: BASE,
  mozbuild: BASE,
  syntax: ['kernel'],
  project: SHARED,
  engine: FEATURE,
  queue: [...FEATURE, 'engine'],
  source: [...FEATURE, 'engine'],
  lint: [...FEATURE, 'engine'],
  typecheck: [...FEATURE, 'engine', 'lint'],
  test: [...FEATURE, 'engine'],
  furnace: [...FEATURE, 'engine', 'register', 'tokens'],
  tokens: FEATURE,
  register: FEATURE,
  mode: [...FEATURE, 'engine', 'queue', 'source', 'lint', 'furnace'],
};
const ALL_MODULES = [...Object.keys(MODULE_IMPORTS), 'check', 'doctor', 'commands'];
MODULE_IMPORTS.check = ALL_MODULES.filter(
  (name) => !['check', 'doctor', 'commands'].includes(name)
);
MODULE_IMPORTS.doctor = ALL_MODULES.filter((name) => !['doctor', 'commands'].includes(name));
MODULE_IMPORTS.commands = ALL_MODULES.filter((name) => name !== 'commands');

const NODE_IO = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:crypto'];

function layeringFor(moduleName, production) {
  const allowed = new Set([...MODULE_IMPORTS[moduleName], moduleName]);
  if (!production) allowed.add('testing');
  const patterns = [];
  const refused = ALL_MODULES.filter((name) => !allowed.has(name));
  if (refused.length > 0) {
    patterns.push({
      regex: `^(?:\\.\\./)+(?:${refused.join('|')})/`,
      message: `src/${moduleName} may import only: ${[...allowed].join(', ')} (contributing/architecture.md).`,
    });
  }
  const viaIndex = [...allowed].filter(
    (name) => name !== moduleName && !OPEN_MODULES.includes(name)
  );
  if (viaIndex.length > 0) {
    patterns.push({
      regex: `^(?:\\.\\./)+(?:${viaIndex.join('|')})/(?!index\\.js$)`,
      message: 'Import another module through its index.js, not its internal files.',
    });
  }
  const paths =
    production && moduleName !== 'kernel'
      ? NODE_IO.map((name) => ({
          name,
          message: 'File, process and hashing primitives live in src/kernel; use them.',
        }))
      : [];
  return { 'no-restricted-imports': ['error', { paths, patterns }] };
}

const layeringConfigs = ALL_MODULES.flatMap((moduleName) => [
  {
    files: [`src/${moduleName}/**/*.ts`],
    ignores: testFiles,
    rules: layeringFor(moduleName, true),
  },
  {
    files: [`src/${moduleName}/**/*.test.ts`],
    rules: layeringFor(moduleName, false),
  },
]);

const jsdocSourceFiles = ['src/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      'coverage/',
      'dist/',
      'node_modules/',
      // Real-shape Firefox files copied verbatim for tests to read. They are
      // data, not part of the TypeScript graph.
      'src/**/__fixtures__/',
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
      // Local rules (eslint-rules/index.js). Each keeps one kernel helper the
      // only spelling of a pattern that is easy to hand-roll wrongly.
      'fireforge/no-open-coded-to-error': 'error',
      'fireforge/no-errno-cast': 'error',
      'fireforge/prefer-shared-regex-escape': 'error',
      'fireforge/no-empty-jsdoc': 'error',
      // Raw JSON documents are typed JsonObject/JsonValue (src/kernel/json.ts),
      // never an untyped dictionary on an exported function.
      'fireforge/no-untyped-json-document': 'error',
      // `isInteractive()` in src/kernel/tty.ts is the one TTY pair check.
      'fireforge/no-open-coded-tty-check': 'error',
      // A parameter type is named, not derived from a local function with
      // `ReturnType<typeof f>`. Deriving from a package import stays legal.
      'fireforge/no-return-type-of-import': 'error',
      // `X as unknown as Y` launders any type into any other.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSAsExpression.expression',
          message:
            'No `as unknown as` chains: validate the value at its boundary with a schema ' +
            '(src/kernel/schema.ts) instead.',
        },
      ],
      // `${String(n)}` inside a template literal is noise:
      // `restrict-template-expressions` allows numbers.
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      '@typescript-eslint/no-useless-constructor': 'error',
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
      // `process.exit` is only legal in bin/: the bin/** override below grants
      // the one legitimate caller. Setting process.exitCode stays legal everywhere.
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
  ...layeringConfigs,
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
    files: testFiles,
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
    ignores: testFiles,
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
      // signature. Destructured-property checking is off on purpose: options
      // bags document their fields on the type, not as `@param options.x`.
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
