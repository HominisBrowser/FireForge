// SPDX-License-Identifier: EUPL-1.2
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    // `eslint-rules/` is plain JS tooling outside `src/`, but its rules are
    // `error`-level in eslint.config.js — they need the same regression cover
    // as the code they police.
    include: ['src/**/*.test.ts', 'eslint-rules/**/*.test.js'],
    // The pack smoke test runs a real `npm pack` + install + tsc (~2 min);
    // it runs only via `pack:verify` (vitest.pack.config.ts), not in every
    // plain `npm test` — and no longer twice per release:check.
    exclude: ['**/node_modules/**', 'src/__tests__/wrapper-smoke.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      // Vitest 4 removed `coverage.all`; without an explicit include, a new
      // src/ module that no test ever imports is INVISIBLE to the global
      // thresholds below (and to the per-module pins, which only hard-fail
      // on missing entries for files they list).
      include: ['src/**'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/__tests__/**',
        '**/test-utils/**',
        '**/types/**',
        'bin/**',
        'src/core/wire-targets.ts',
      ],
      thresholds: {
        lines: 88,
        statements: 87,
        functions: 91,
        branches: 77,
      },
    },
  },
});
