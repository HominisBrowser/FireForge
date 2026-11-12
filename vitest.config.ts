// SPDX-License-Identifier: EUPL-1.2
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts', 'eslint-rules/**/*.test.js'],
    // The packaging smoke test builds the package; `npm run pack:verify` runs it.
    exclude: ['**/node_modules/**', '**/*.pack.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
