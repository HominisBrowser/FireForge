// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { makeFurnaceFixture } from '../testing/furnace.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { applyComponents, componentDiff } from './index.js';

const dir = useTempDir();

const FURNACE = {
  version: 1,
  componentPrefix: 'moz-',
  custom: {
    'moz-acme-chip': {
      description: '',
      targetPath: 'toolkit/content/widgets/moz-acme-chip',
      register: false,
      localized: false,
    },
  },
  overrides: {
    'moz-card': {
      type: 'css-only',
      description: '',
      basePath: 'toolkit/content/widgets/moz-card',
      baseVersion: '153.7.0esr',
    },
  },
};

async function fixture(): Promise<Awaited<ReturnType<typeof makeFurnaceFixture>>> {
  return makeFurnaceFixture(dir(), {
    furnace: FURNACE,
    files: {
      'components/custom/moz-acme-chip/moz-acme-chip.css': ':host { gap: 0; }\n',
      'components/overrides/moz-card/moz-card.css': ':host { display: grid; }\n',
    },
  });
}

describe('componentDiff', () => {
  it('compares a custom component with the engine and an override with upstream', async () => {
    const f = await fixture();
    const text = await componentDiff(f.project, f.workspace);
    expect(text).toContain('+++ project/toolkit/content/widgets/moz-acme-chip/moz-acme-chip.css');
    expect(text).toContain('+:host { gap: 0; }');
    expect(text).toContain('--- upstream/toolkit/content/widgets/moz-card/moz-card.css');
    expect(text).toContain('+:host { display: grid; }');
  });

  it('is empty for a custom component the engine already holds as the project has it', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    expect(await componentDiff(f.project, f.workspace, 'moz-acme-chip')).toBe('');
    expect(await componentDiff(f.project, f.workspace, 'moz-card')).toContain('upstream/');
  });

  it('shows an engine copy edited by hand against the project', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    await writeTree(f.engineDir, {
      'toolkit/content/widgets/moz-acme-chip/moz-acme-chip.css': ':host { gap: 1px; }\n',
    });
    const text = await componentDiff(f.project, f.workspace, 'moz-acme-chip');
    expect(text).toContain('-:host { gap: 1px; }');
    expect(text).toContain('+:host { gap: 0; }');
  });

  it('refuses an unknown component', async () => {
    const f = await fixture();
    await expect(componentDiff(f.project, f.workspace, 'moz-nope')).rejects.toMatchObject({
      code: 'furnace-unknown-component',
    });
  });
});
