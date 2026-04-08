// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../../core/furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    })
  ),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  formatErrorText: vi.fn((value: string) => value),
  formatSuccessText: vi.fn((value: string) => value),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

import { readdir } from 'node:fs/promises';

import { loadFurnaceConfig } from '../../core/furnace-config.js';
import { pathExists, readText } from '../../utils/fs.js';
import { info, intro, outro } from '../../utils/logger.js';
import { furnaceDiffCommand } from '../furnace/diff.js';

describe('furnaceDiffCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('fails when the requested component is not an override', async () => {
    await expect(furnaceDiffCommand('/project', 'moz-button')).rejects.toThrow(
      /not an override component/i
    );

    expect(intro).toHaveBeenCalledWith('Furnace Diff');
    expect(readdir).not.toHaveBeenCalled();
  });

  it('fails when the override directory does not exist', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) =>
      Promise.resolve(!filePath.includes('/components/overrides/moz-card'))
    );

    await expect(furnaceDiffCommand('/project', 'moz-card')).rejects.toThrow(
      /Override directory not found/i
    );

    expect(readdir).not.toHaveBeenCalled();
  });

  it('reports new files and changed files against the Firefox original', async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
      { name: 'moz-new.mjs', isFile: () => true },
      { name: 'README.md', isFile: () => true },
      { name: 'nested', isFile: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(pathExists).mockImplementation((filePath) => {
      if (filePath.endsWith('/project/components/overrides/moz-card')) {
        return Promise.resolve(true);
      }
      if (filePath.endsWith('/project/engine/toolkit/content/widgets/moz-card/moz-new.mjs'))
        return Promise.resolve(false);
      return Promise.resolve(true);
    });
    vi.mocked(readText).mockImplementation((filePath) => {
      if (filePath.endsWith('/project/engine/toolkit/content/widgets/moz-card/moz-card.css')) {
        return Promise.resolve(['.root {', '  color: blue;', '  padding: 4px;', '}'].join('\n'));
      }
      if (filePath.endsWith('/project/components/overrides/moz-card/moz-card.css')) {
        return Promise.resolve(['.root {', '  color: red;', '  padding: 4px;', '}'].join('\n'));
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });

    await furnaceDiffCommand('/project', 'moz-card');

    expect(info).toHaveBeenCalledWith('moz-new.mjs: original not found in engine (new file)');
    expect(info).toHaveBeenCalledWith('--- toolkit/content/widgets/moz-card/moz-card.css');
    expect(info).toHaveBeenCalledWith('+++ components/overrides/moz-card/moz-card.css');
    expect(info).toHaveBeenCalledWith('  .root {');
    expect(info).toHaveBeenCalledWith('-   color: blue;');
    expect(info).toHaveBeenCalledWith('+   color: red;');
    expect(info).toHaveBeenCalledWith('    padding: 4px;');
    expect(outro).toHaveBeenCalledWith('Diff complete');
  });

  it('reports when no override files differ from the original', async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('.root {\n  color: blue;\n}\n');

    await furnaceDiffCommand('/project', 'moz-card');

    expect(info).toHaveBeenCalledWith('No modifications found');
    expect(outro).toHaveBeenCalledWith('Diff complete');
  });
});
