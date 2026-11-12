// SPDX-License-Identifier: EUPL-1.2
/**
 * The packaging smoke test (`npm run pack:verify`): a real `npm pack`, an
 * install into a temporary project, and the installed executable. It builds
 * the package, so it runs through this configuration only and never with
 * the unit tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.pack.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
