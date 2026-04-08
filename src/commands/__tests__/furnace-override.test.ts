// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { furnaceOverrideCommand } from '../furnace/override.js';

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
  loadConfig: vi.fn(() => ({
    firefox: { version: '146.0', product: 'firefox' },
  })),
}));

vi.mock('../../core/furnace-config.js', () => ({
  ensureFurnaceConfig: vi.fn(() => ({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  })),
  writeFurnaceConfig: vi.fn(),
  getFurnacePaths: vi.fn(() => ({
    configPath: '/project/furnace.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
  })),
}));

vi.mock('../../core/furnace-scanner.js', () => ({
  scanWidgetsDirectory: vi.fn(() => []),
  getComponentDetails: vi.fn(() => ({
    tagName: 'moz-button',
    sourcePath: 'toolkit/content/widgets/moz-button',
    hasCSS: false,
    hasFTL: false,
    isRegistered: true,
  })),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() =>
    Promise.resolve([
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
    ])
  ),
}));

vi.mock('../../utils/fs.js', () => ({
  ensureDir: vi.fn(),
  pathExists: vi.fn((path: string) => {
    // Engine exists, but override dest dir does not
    if (path.includes('components/overrides/moz-button')) return Promise.resolve(false);
    if (path.includes('engine')) return Promise.resolve(true);
    return Promise.resolve(false);
  }),
  copyFile: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
}));

import { readdir } from 'node:fs/promises';

import * as p from '@clack/prompts';

import { ensureFurnaceConfig, writeFurnaceConfig } from '../../core/furnace-config.js';
import { getComponentDetails, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { copyFile, ensureDir, pathExists, writeJson } from '../../utils/fs.js';
import { cancel, isCancel } from '../../utils/logger.js';

describe('furnaceOverrideCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock implementations after tests that override them
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('components/overrides/moz-button'))
        return Promise.resolve(false);
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: false,
      hasFTL: false,
      isRegistered: true,
    });
    vi.mocked(ensureFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    } as Awaited<ReturnType<typeof ensureFurnaceConfig>>);
  });

  it('fails before writing when css-only override is requested for a component without CSS', async () => {
    await expect(
      furnaceOverrideCommand('/project', 'moz-button', {
        type: 'css-only',
        description: 'Restyle',
      })
    ).rejects.toThrow(/does not have any CSS files to override/i);

    expect(vi.mocked(ensureDir)).not.toHaveBeenCalled();
    expect(vi.mocked(writeJson)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFurnaceConfig)).not.toHaveBeenCalled();
  });

  it('creates a full override successfully', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });

    await furnaceOverrideCommand('/project', 'moz-button', {
      type: 'full',
      description: 'Full restyle of button',
    });

    expect(vi.mocked(ensureDir)).toHaveBeenCalled();
    expect(vi.mocked(copyFile)).toHaveBeenCalled();
    const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
    expect(writtenConfig).toBeDefined();
    expect(writtenConfig?.overrides['moz-button']).toBeDefined();
    expect(writtenConfig?.overrides['moz-button']?.type).toBe('full');
    expect(writtenConfig?.overrides['moz-button']?.description).toBe('Full restyle of button');
    expect(writtenConfig?.overrides['moz-button']?.basePath).toBe(
      'toolkit/content/widgets/moz-button'
    );
  });

  it('creates a css-only override when CSS files exist', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });

    await furnaceOverrideCommand('/project', 'moz-button', {
      type: 'css-only',
      description: 'CSS restyle',
    });

    const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
    expect(writtenConfig).toBeDefined();
    expect(writtenConfig?.overrides['moz-button']?.type).toBe('css-only');
  });

  it('throws when engine directory does not exist', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(
      furnaceOverrideCommand('/project', 'moz-button', {
        type: 'full',
        description: 'Test',
      })
    ).rejects.toThrow(/Engine directory not found/);
  });

  it('throws when component name is missing in non-interactive mode', async () => {
    await expect(
      furnaceOverrideCommand('/project', undefined, {
        type: 'full',
        description: 'Test',
      })
    ).rejects.toThrow(/Component name is required in non-interactive mode/);
  });

  it('throws when override type is missing in non-interactive mode', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });

    await expect(
      furnaceOverrideCommand('/project', 'moz-button', { description: 'Test' })
    ).rejects.toThrow(/Override type is required in non-interactive mode/);
  });

  it('throws for invalid component names', async () => {
    await expect(
      furnaceOverrideCommand('/project', 'INVALID', {
        type: 'full',
        description: 'Test',
      })
    ).rejects.toThrow(/Invalid component name/);
  });

  it('throws when override already exists in config', async () => {
    vi.mocked(ensureFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: { 'moz-button': { type: 'full', description: '', basePath: '', baseVersion: '' } },
      custom: {},
    } as Awaited<ReturnType<typeof ensureFurnaceConfig>>);

    await expect(
      furnaceOverrideCommand('/project', 'moz-button', {
        type: 'full',
        description: 'Test',
      })
    ).rejects.toThrow(/already exists in furnace\.json/);
  });

  it('throws when component is not found in engine', async () => {
    vi.mocked(getComponentDetails).mockResolvedValueOnce(null);

    await expect(
      furnaceOverrideCommand('/project', 'moz-button', {
        type: 'full',
        description: 'Test',
      })
    ).rejects.toThrow(/not found in the engine source tree/);
  });

  it('throws when destination directory already exists', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(
      furnaceOverrideCommand('/project', 'moz-button', {
        type: 'full',
        description: 'Test',
      })
    ).rejects.toThrow(/Directory already exists/);
  });

  it('skips non-file entries in copyOverrideFiles', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'subdir', isFile: () => false },
      { name: 'moz-button.mjs', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await furnaceOverrideCommand('/project', 'moz-button', {
      type: 'full',
      description: 'Test',
    });

    // copyFile should only be called for the .mjs file, not the directory
    expect(copyFile).toHaveBeenCalledTimes(1);
    expect(copyFile).toHaveBeenCalledWith(
      expect.stringContaining('moz-button.mjs'),
      expect.stringContaining('moz-button.mjs')
    );
  });

  it('skips non-.mjs/.css files in full override mode', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'README.md', isFile: () => true },
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await furnaceOverrideCommand('/project', 'moz-button', {
      type: 'full',
      description: 'Test',
    });

    // Only .mjs and .css should be copied, not README.md
    expect(copyFile).toHaveBeenCalledTimes(2);
  });

  it('copies only .css files in css-only mode, skipping .mjs files', async () => {
    vi.mocked(getComponentDetails).mockResolvedValue({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
      { name: 'helper.js', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await furnaceOverrideCommand('/project', 'moz-button', {
      type: 'css-only',
      description: 'CSS only restyle',
    });

    // Only .css should be copied, not .mjs or .js
    expect(copyFile).toHaveBeenCalledTimes(1);
    expect(copyFile).toHaveBeenCalledWith(
      expect.stringContaining('moz-button.css'),
      expect.stringContaining('moz-button.css')
    );
  });

  describe('interactive mode', () => {
    beforeEach(() => {
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      vi.mocked(getComponentDetails).mockResolvedValue({
        tagName: 'moz-button',
        sourcePath: 'toolkit/content/widgets/moz-button',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      });
    });

    afterEach(() => {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;
    });

    it('selects component, type, and description interactively', async () => {
      vi.mocked(scanWidgetsDirectory).mockResolvedValueOnce([
        {
          tagName: 'moz-button',
          sourcePath: 'toolkit/content/widgets/moz-button',
          hasCSS: true,
          hasFTL: false,
          isRegistered: true,
        },
        {
          tagName: 'moz-toggle',
          sourcePath: 'toolkit/content/widgets/moz-toggle',
          hasCSS: true,
          hasFTL: true,
          isRegistered: false,
        },
      ]);
      vi.mocked(p.select).mockResolvedValueOnce('moz-button').mockResolvedValueOnce('full');
      vi.mocked(p.text).mockResolvedValueOnce('Interactive description');

      await furnaceOverrideCommand('/project');

      expect(p.select).toHaveBeenCalledTimes(2);
      expect(p.text).toHaveBeenCalledTimes(1);
      expect(writeFurnaceConfig).toHaveBeenCalled();
      const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
      expect(writtenConfig?.overrides['moz-button']?.type).toBe('full');
      expect(writtenConfig?.overrides['moz-button']?.description).toBe('Interactive description');
    });

    it('returns early when component selection is cancelled', async () => {
      vi.mocked(scanWidgetsDirectory).mockResolvedValueOnce([
        {
          tagName: 'moz-button',
          sourcePath: 'toolkit/content/widgets/moz-button',
          hasCSS: true,
          hasFTL: false,
          isRegistered: true,
        },
      ]);
      vi.mocked(p.select).mockResolvedValueOnce(Symbol('cancel'));
      vi.mocked(isCancel).mockReturnValueOnce(true);

      await furnaceOverrideCommand('/project');

      expect(cancel).toHaveBeenCalledWith('Override cancelled');
      expect(writeFurnaceConfig).not.toHaveBeenCalled();
    });

    it('returns early when type selection is cancelled', async () => {
      vi.mocked(p.select).mockResolvedValueOnce(Symbol('cancel'));
      vi.mocked(isCancel).mockReturnValueOnce(true);

      await furnaceOverrideCommand('/project', 'moz-button');

      expect(cancel).toHaveBeenCalledWith('Override cancelled');
      expect(writeFurnaceConfig).not.toHaveBeenCalled();
    });

    it('prompts for description when not provided and uses the result', async () => {
      vi.mocked(p.text).mockResolvedValueOnce('Prompted description');

      await furnaceOverrideCommand('/project', 'moz-button', { type: 'full' });

      expect(p.text).toHaveBeenCalledTimes(1);
      const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
      expect(writtenConfig?.overrides['moz-button']?.description).toBe('Prompted description');
    });

    it('uses empty description when description prompt is cancelled', async () => {
      vi.mocked(p.text).mockResolvedValueOnce(Symbol('cancel'));
      vi.mocked(isCancel).mockReturnValueOnce(true);

      await furnaceOverrideCommand('/project', 'moz-button', { type: 'full' });

      const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
      expect(writtenConfig?.overrides['moz-button']?.description).toBe('');
    });

    it('throws when no components are available to override', async () => {
      vi.mocked(scanWidgetsDirectory).mockResolvedValueOnce([]);

      await expect(furnaceOverrideCommand('/project')).rejects.toThrow(
        /No components available to override/
      );
    });
  });
});
