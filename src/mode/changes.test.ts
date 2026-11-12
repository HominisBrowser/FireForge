// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { makeEngineProject, makeSourceProject, useMachSandbox } from '../testing/engine.js';
import { useTempDir } from '../testing/temp.js';
import { mutationRoots } from './index.js';

const dir = useTempDir();
useMachSandbox();

const FURNACE = JSON.stringify({
  version: 1,
  componentPrefix: 'moz-',
  custom: {
    'moz-acme-chip': {
      description: 'A chip',
      targetPath: 'toolkit/content/widgets/moz-acme-chip',
      register: true,
      localized: false,
    },
  },
  overrides: {
    'moz-card': {
      type: 'css-only',
      description: 'Brand colours',
      basePath: 'toolkit/content/widgets/moz-card',
      baseVersion: '140.9.0esr',
    },
  },
});

describe('mutationRoots', () => {
  it('names the source root and every component directory with the engine directory it fills', async () => {
    const project = await makeSourceProject(dir(), { files: { 'furnace.json': FURNACE } });
    expect(await mutationRoots(project)).toEqual([
      { directory: 'src', engine: '' },
      {
        directory: 'components/custom/moz-acme-chip',
        engine: 'toolkit/content/widgets/moz-acme-chip',
      },
      { directory: 'components/overrides/moz-card', engine: 'toolkit/content/widgets/moz-card' },
    ]);
  });

  it('has no source root in patch mode, whose engine is edited in place', async () => {
    const project = await makeEngineProject(dir());
    expect(await mutationRoots(project)).toEqual([]);
  });
});
