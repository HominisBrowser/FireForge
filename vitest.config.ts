// SPDX-License-Identifier: EUPL-1.2
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      exclude: ['**/__tests__/**', '**/types/**', 'bin/**', 'src/core/wire-targets.ts'],
      thresholds: {
        lines: 88,
        statements: 87,
        functions: 91,
        branches: 77,
      },
    },
  },
});
