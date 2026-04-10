// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { isFireForgePackageMetadata } from '../package-root.js';

describe('package root helpers', () => {
  it('recognizes FireForge packages without depending on the npm package scope', () => {
    expect(
      isFireForgePackageMetadata({
        name: '@example/renamed-fireforge',
        version: '1.0.0',
        bin: {
          fireforge: './dist/bin/fireforge.js',
        },
      })
    ).toBe(true);
  });

  it('rejects unrelated packages', () => {
    expect(
      isFireForgePackageMetadata({
        name: '@example/tool',
        version: '1.0.0',
        bin: {
          other: './dist/bin/other.js',
        },
      })
    ).toBe(false);
  });
});
