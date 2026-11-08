// SPDX-License-Identifier: EUPL-1.2
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

// The job coordinator needs POSIX process groups and `ps`: the CLI refuses to start it on Windows.
// Its suites, and the proof and command tests that run a real supervisor, run on POSIX hosts only.
const posixOnly =
  process.platform === 'win32'
    ? [
        'src/core/jobs/**',
        'src/core/proof/**',
        'src/commands/__tests__/job-cli.test.ts',
        'src/commands/__tests__/job-flow.integration.test.ts',
        'src/commands/__tests__/slot-cli.test.ts',
        'src/__tests__/machine-output-job-slot-prove.test.ts',
        'src/__tests__/supervisor-leak-guard.test.ts',
      ]
    : [];

export default defineConfig({
  test: {
    root: '.',
    // `eslint-rules/` is plain JS tooling outside `src/`, but its rules run at
    // `error` level in eslint.config.js, so they need the same regression cover
    // as the code they police.
    include: ['src/**/*.test.ts', 'eslint-rules/**/*.test.js'],
    // The pack smoke test runs a real `npm pack` plus install plus tsc
    // (~2 min). It runs only via `pack:verify` (vitest.pack.config.ts).
    exclude: ['**/node_modules/**', 'src/__tests__/wrapper-smoke.test.ts', ...posixOnly],
    globalSetup: process.platform === 'win32' ? [] : ['src/test-utils/supervisor-leak-guard.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      // Vitest 4 removed `coverage.all`. Without an explicit include, a new
      // src/ module that no test ever imports is invisible to the global
      // thresholds below, and to the per-module pins, which only hard-fail on
      // missing entries for files they list.
      include: ['src/**', 'runtime/**/*.cjs'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/__tests__/**',
        '**/test-utils/**',
        '**/types/**',
        'bin/**',
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
