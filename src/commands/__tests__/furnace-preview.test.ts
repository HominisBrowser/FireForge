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
  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
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

vi.mock('../../core/furnace-stories.js', () => ({
  syncStories: vi.fn(() =>
    Promise.resolve({ created: ['moz-card.stories.mjs'], updated: [], removed: [] })
  ),
  cleanStories: vi.fn(() => Promise.resolve(1)),
}));

vi.mock('../../core/mach.js', () => ({
  runMach: vi.fn(),
  runMachCapture: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

import { cleanStories, syncStories } from '../../core/furnace-stories.js';
import { runMach, runMachCapture } from '../../core/mach.js';
import { pathExists } from '../../utils/fs.js';
import { furnacePreviewCommand } from '../furnace/preview.js';

describe('furnacePreviewCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/project/engine' || path === '/project/engine/browser/components/storybook'
      )
    );
    vi.mocked(runMachCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('fails early when the Firefox checkout lacks Storybook support', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(
      /does not contain browser\/components\/storybook/i
    );

    expect(syncStories).not.toHaveBeenCalled();
  });

  it('treats Ctrl+C as a normal preview shutdown', async () => {
    vi.mocked(runMachCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 130 });

    await expect(furnacePreviewCommand('/project')).resolves.toBeUndefined();
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
  });

  it('rewrites missing backend/storybook paths into a focused error', async () => {
    vi.mocked(runMachCapture).mockResolvedValue({
      stdout: '',
      stderr: 'Error: ENOENT: no such file or directory, open backend/storybook/package.json',
      exitCode: 1,
    });

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(
      /missing Storybook workspace files or backend dependencies/i
    );
  });

  it('cleans synced stories when dependency installation fails', async () => {
    vi.mocked(runMach).mockResolvedValue(1);

    await expect(furnacePreviewCommand('/project', { install: true })).rejects.toThrow(
      /dependency reinstallation failed/i
    );

    expect(syncStories).toHaveBeenCalled();
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
  });
});
