// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

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
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    })
  ),
}));

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

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
          baseVersion: '140.9.0esr',
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

vi.mock('../../core/furnace-apply-helpers.js', () => ({
  extractComponentChecksums: vi.fn(() => ({})),
  hasComponentChanged: vi.fn(() => Promise.resolve(false)),
  hasOverrideEngineDrift: vi.fn(() => Promise.resolve(false)),
  hasCustomEngineDrift: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/furnace-validate-checks.js', () => ({
  checkRegistrationConsistency: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import {
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
} from '../../core/furnace-apply-helpers.js';
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
          baseVersion: '140.9.0esr',
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
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('Workspace unchanged since last apply'),
      'moz-button Override Status'
    );
    expect(
      vi
        .mocked(info)
        .mock.calls.some(([message]) =>
          message.includes('stock component. No local registration to check')
        )
    ).toBe(false);
  });

  it('reports detailed override drift and workspace changes', async () => {
    vi.mocked(loadFurnaceState).mockResolvedValue({
      appliedChecksums: { 'override/moz-button/moz-button.css': 'abc' },
    });
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(true);

    await furnaceStatusCommand('/project', 'moz-button');

    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2717 Workspace unchanged since last apply'),
      'moz-button Override Status'
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2717 Engine matches override workspace'),
      'moz-button Override Status'
    );
  });

  it('does not report a green override status when the override directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(false);

    await furnaceStatusCommand('/project', 'moz-button');

    expect(vi.mocked(hasComponentChanged)).not.toHaveBeenCalled();
    expect(vi.mocked(hasOverrideEngineDrift)).not.toHaveBeenCalled();
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2717 Workspace status unavailable (override directory missing)'),
      'moz-button Override Status'
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2717 Engine comparison unavailable (override directory missing)'),
      'moz-button Override Status'
    );
  });

  it('does not report a green engine match when the engine directory is missing', async () => {
    vi.mocked(pathExists)
      .mockResolvedValueOnce(true) // override directory
      .mockResolvedValueOnce(false); // engine directory

    await furnaceStatusCommand('/project', 'moz-button');

    expect(vi.mocked(hasComponentChanged)).toHaveBeenCalled();
    expect(vi.mocked(hasOverrideEngineDrift)).not.toHaveBeenCalled();
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining('\u2717 Engine comparison unavailable (engine directory missing)'),
      'moz-button Override Status'
    );
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
          baseVersion: '140.9.0esr',
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

  it('warns about pendingRepair before the normal summary', async () => {
    vi.mocked(loadFurnaceState).mockResolvedValue({
      appliedChecksums: {},
      pendingRepair: {
        operation: 'apply-rollback',
        timestamp: '2026-04-12T10:00:00.000Z',
        reason: 'rollback failed mid-flight',
      },
    });

    await furnaceStatusCommand('/project');

    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('pending-repair state from apply-rollback')
    );
    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('doctor --repair-furnace')
    );
  });

  it('warns about engine drift when workspace is unchanged but engine has been mutated', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'css-only',
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(hasComponentChanged).mockResolvedValue(false);
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(true);

    await furnaceStatusCommand('/project');

    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Engine drift detected'));
  });

  it('warns about workspace changes and engine drift independently', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'css-only',
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
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
    // Override is unchanged but engine drifted. Custom workspace was edited.
    vi.mocked(hasComponentChanged)
      .mockResolvedValueOnce(false) // override
      .mockResolvedValueOnce(true); // custom
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(true);
    vi.mocked(hasCustomEngineDrift).mockResolvedValue(false);

    await furnaceStatusCommand('/project');

    const warnCalls = vi.mocked(warn).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => m.includes('modified since last apply'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('Engine drift detected'))).toBe(true);
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
          baseVersion: '140.9.0esr',
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
