// SPDX-License-Identifier: EUPL-1.2
/**
 * Dedicated config for the packaging smoke test (`npm run pack:verify`).
 *
 * wrapper-smoke runs a real `npm pack` + install-into-temp-project + tsc
 * (~2 minutes), so it is excluded from the default `npm test` include and
 * runs only through this config — previously it ran in every plain test
 * invocation AND twice per release:check (via test:coverage and
 * pack:verify). A separate config (rather than an env-var toggle) keeps
 * the invocation portable to the Windows CI leg.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/wrapper-smoke.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
