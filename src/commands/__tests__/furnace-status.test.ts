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
      stock: ['moz-button'],
      overrides: {
        'moz-button': {
          type: 'css-only',
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.0esr',
        },
      },
      custom: {},
    })
  ),
  loadFurnaceState: vi.fn(() => Promise.resolve({ appliedChecksums: {} })),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    furnaceState: '/project/.fireforge/furnace-state.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
  })),
}));

vi.mock('../../core/furnace-apply.js', () => ({
  extractComponentChecksums: vi.fn(() => ({})),
  hasComponentChanged: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/furnace-validate-checks.js', () => ({
  checkRegistrationConsistency: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  note: vi.fn(),
}));

import { hasComponentChanged } from '../../core/furnace-apply.js';
import {
  furnaceConfigExists,
  loadFurnaceConfig,
  loadFurnaceState,
} from '../../core/furnace-config.js';
import { checkRegistrationConsistency } from '../../core/furnace-validate-checks.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, note, warn } from '../../utils/logger.js';
import { furnaceStatusCommand } from '../furnace/status.js';

describe('furnaceStatusCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore factory defaults after clearAllMocks
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {
        'moz-button': {
          type: 'css-only',
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.0esr',
        },
      },
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({ appliedChecksums: {} });
    vi.mocked(hasComponentChanged).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('prefers a local override over the stock-component shortcut in detailed mode', async () => {
    await furnaceStatusCommand('/project', 'moz-button');

    expect(vi.mocked(info)).toHaveBeenCalledWith(
      '"moz-button" is an override component (css-only).'
    );
    expect(
      vi
        .mocked(info)
        .mock.calls.some(([message]) =>
          message.includes('stock component. No local registration to check')
        )
    ).toBe(false);
  });

  it('shows info message when furnace is not configured', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);

    await furnaceStatusCommand('/project');

    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('Furnace is not configured')
    );
  });

  it('displays summary with custom and override components', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-toggle'],
      overrides: {
        'moz-button': {
          type: 'css-only',
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.0esr',
        },
      },
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });

    await furnaceStatusCommand('/project');

    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('Override components: 1'),
      expect.any(String)
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('Custom components: 1'),
      expect.any(String)
    );
  });

  it('reports stock component detail view', async () => {
    // Need to set config before the call since it must have moz-toggle in stock
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-toggle'],
      overrides: {},
      custom: {},
    });

    await furnaceStatusCommand('/project', 'moz-toggle');

    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('stock component'));
  });

  it('warns when a component has changed since last apply', async () => {
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    await furnaceStatusCommand('/project');

    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('modified since last apply')
    );
  });

  it('throws FurnaceError when component is not found', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await expect(furnaceStatusCommand('/project', 'nonexistent')).rejects.toBeInstanceOf(
      FurnaceError
    );
    await expect(furnaceStatusCommand('/project', 'nonexistent')).rejects.toThrow(
      'not found in furnace.json'
    );
  });

  it('shows custom component detailed registration status', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(checkRegistrationConsistency).mockResolvedValue({
      sourceExists: true,
      targetExists: true,
      filesInSync: false,
      jarMnMjs: true,
      jarMnCss: false,
      customElementsPresent: true,
      customElementsCorrectBlock: true,
      driftedFiles: ['sidebar.css'],
      missingTargetFiles: [],
    });

    await furnaceStatusCommand('/project', 'moz-sidebar');

    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2713 Source directory exists'),
      expect.stringContaining('moz-sidebar')
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2717 Source and target files in sync'),
      expect.any(String)
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('Drifted files: sidebar.css'),
      expect.any(String)
    );
  });

  it('omits drift/missing lines when arrays are empty', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-widget': {
          description: 'Widget',
          targetPath: 'browser/components/widget',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(checkRegistrationConsistency).mockResolvedValue({
      sourceExists: true,
      targetExists: true,
      filesInSync: true,
      jarMnMjs: true,
      jarMnCss: true,
      customElementsPresent: true,
      customElementsCorrectBlock: true,
      driftedFiles: [],
      missingTargetFiles: [],
    });

    await furnaceStatusCommand('/project', 'moz-widget');

    const noteContent = vi.mocked(note).mock.calls[0]?.[0] as string;
    expect(noteContent).not.toContain('Drifted files');
    expect(noteContent).not.toContain('Missing in engine');
  });

  it('skips change detection when engine path does not exist', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await furnaceStatusCommand('/project');

    expect(vi.mocked(hasComponentChanged)).not.toHaveBeenCalled();
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  it('detects changes in custom components when overrides have none', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'css-only',
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.0esr',
        },
      },
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    // Override has no changes, custom does
    vi.mocked(hasComponentChanged)
      .mockResolvedValueOnce(false) // override check
      .mockResolvedValueOnce(true); // custom check

    await furnaceStatusCommand('/project');

    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('modified since last apply')
    );
  });
});
