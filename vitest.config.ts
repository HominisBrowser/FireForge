// SPDX-License-Identifier: EUPL-1.2
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

// Process starts and file operations cost several times more on Windows: a
// test that takes four seconds elsewhere takes fifteen there on a busy host.
const TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 30_000;

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts', 'eslint-rules/**/*.test.js'],
    // The packaging smoke test builds the package; `npm run pack:verify` runs it.
    exclude: ['**/node_modules/**', '**/*.pack.test.ts'],
    testTimeout: TIMEOUT_MS,
    hookTimeout: TIMEOUT_MS,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/*.test.ts',
        'src/testing/**',
        'src/**/__fixtures__/**',
      ],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
    },
  },
});
