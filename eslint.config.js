// SPDX-License-Identifier: EUPL-1.2
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

const jsToolingFiles = ['eslint.config.js', 'scripts/**/*.mjs'];

const sharedRules = {
  'no-throw-literal': 'error',
  'prefer-const': 'error',
  'no-var': 'error',
  // Ceiling chosen in 0.31.0 after refactoring everything that exceeded
  // it; command orchestrators legitimately sit in the 20s, so a lower
  // bar would force splits that spread linear flows across helpers.
  complexity: ['error', 30],
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
      // the suite. They are not part of the project's TypeScript graph and
      // do not follow project lint rules (BSD/MPL header style, var/let mix,
      // unused parameters, etc.). The tests that consume them assert
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
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
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
      // The "process.exit only in bin/" invariant was previously enforced
      // by comments alone; the bin/** override below grants the one
      // legitimate caller. Setting process.exitCode stays legal everywhere.
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
