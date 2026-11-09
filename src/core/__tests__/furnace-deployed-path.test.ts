// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { FurnaceConfig } from '../../types/furnace.js';
import { deployedComponentPath } from '../furnace-composed-source.js';

const config = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {
    'moz-card': {
      type: 'full',
      description: '',
      basePath: 'toolkit/content/widgets/moz-card',
      baseVersion: '1',
    },
    'moz-badge': {
      type: 'css-only',
      description: '',
      basePath: 'toolkit/content/widgets/moz-badge',
      baseVersion: '1',
    },
  },
  custom: {
    'my-w': { description: '', targetPath: 'browser/w', register: false, localized: false },
  },
} as unknown as FurnaceConfig;

describe('deployedComponentPath', () => {
  it('maps a file to where furnace apply deploys it', () => {
    expect(deployedComponentPath('components/custom/my-w/test_w.mjs', config)).toBe(
      'browser/w/test_w.mjs'
    );
    expect(deployedComponentPath('components/overrides/moz-card/test_card.mjs', config)).toBe(
      'toolkit/content/widgets/moz-card/test_card.mjs'
    );
  });

  it('maps nothing apply deploys nowhere', () => {
    for (const path of [
      'components/custom/my-w/browser_w.js',
      'components/custom/my-w/test/test_w.mjs',
      'components/custom/other/test_w.mjs',
      'components/overrides/moz-badge/test_badge.mjs',
      'components/shared/test_x.mjs',
      'tools/test_x.mjs',
    ])
      expect(deployedComponentPath(path, config)).toBeUndefined();
  });
});
