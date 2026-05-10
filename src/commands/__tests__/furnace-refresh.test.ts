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
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '140.9.0', product: 'firefox' },
    })
  ),
  loadState: vi.fn(() =>
    Promise.resolve({
      baseCommit: 'abc123def456',
    })
  ),
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
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
        },
      },
      custom: {},
    })
  ),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-apply-helpers.js', () => ({
  getOverrideEngineTargetPath: vi.fn(
    (_engineDir: string, config: { basePath: string }, fileName: string) => {
      if (fileName.endsWith('.ftl')) return `/project/engine/browser/locales/${fileName}`;
      return `/project/engine/${config.basePath}/${fileName}`;
    }
  ),
}));

vi.mock('../../core/furnace-refresh.js', () => ({
  refreshOverrideFile: vi.fn(),
}));

vi.mock('../../core/furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (
      _root: string,
      _kind: string,
      body: (ctx: { registerJournal: () => void; registerCleanup: () => void }) => Promise<unknown>
    ) =>
      body({
        registerJournal: () => undefined,
        registerCleanup: () => undefined,
      })
  ),
  recordFurnaceRollbackFailure: vi.fn(),
}));

vi.mock('../../core/furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(),
  snapshotDir: vi.fn(),
  snapshotFile: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  getHead: vi.fn(() => Promise.resolve('engine-head-sha999')),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  note: vi.fn(),
  warn: vi.fn(),
  formatSuccessText: vi.fn((s: string) => s),
  formatErrorText: vi.fn((s: string) => s),
}));

// Mock readdir
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() =>
    Promise.resolve([
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
    ])
  ),
}));

import { loadState } from '../../core/config.js';
import { loadFurnaceConfig, writeFurnaceConfig } from '../../core/furnace-config.js';
import { refreshOverrideFile } from '../../core/furnace-refresh.js';
import { pathExists } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { furnaceRefreshCommand } from '../furnace/refresh.js';

describe('furnace refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default pathExists mock (clearAllMocks does not reset
    // mockImplementation, so tests that override it leak into later tests).
    vi.mocked(pathExists).mockImplementation(() => Promise.resolve(true));
  });

  it('throws when engine directory is missing', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('/project/engine'))
        return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await expect(furnaceRefreshCommand('/project', 'moz-button')).rejects.toThrow(
      'Engine directory not found'
    );
  });

  it('throws if component is not an override', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-widget': { description: '', targetPath: 'x', register: true, localized: false },
      },
    });

    await expect(furnaceRefreshCommand('/project', 'moz-widget')).rejects.toThrow(
      'not an override component'
    );
  });

  it('exits early when baseVersion matches current version', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.9.0', // Matches current version
        },
      },
      custom: {},
    });

    await furnaceRefreshCommand('/project', 'moz-button');
    expect(refreshOverrideFile).not.toHaveBeenCalled();
  });

  it('throws when baseCommit is missing', async () => {
    vi.mocked(loadState).mockResolvedValueOnce({});

    await expect(furnaceRefreshCommand('/project', 'moz-button')).rejects.toThrow(
      'baseCommit not found'
    );
  });

  it('calls refreshOverrideFile for each source file', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(refreshOverrideFile).toHaveBeenCalledTimes(2);
  });

  it('updates baseVersion on clean merge', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'file.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(writeFurnaceConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFurnaceConfig).mock.calls[0] as unknown as [
      string,
      { overrides: Record<string, { baseVersion: string }> },
    ];
    expect(call[0]).toBe('/project');
    expect(call[1].overrides['moz-button']).toHaveProperty('baseVersion', '140.9.0');
  });

  it('does not update baseVersion when conflicts exist', async () => {
    vi.mocked(refreshOverrideFile)
      .mockResolvedValueOnce({ fileName: 'moz-button.mjs', status: 'conflict', conflictMarkers: 2 })
      .mockResolvedValueOnce({ fileName: 'moz-button.css', status: 'merged' });

    await furnaceRefreshCommand('/project', 'moz-button');

    // writeFurnaceConfig should not be called when conflicts exist
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Conflict markers'));
  });

  it('does not modify files in dry-run mode', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button', { dryRun: true });

    // refreshOverrideFile should receive the dryRun flag so it skips writes
    expect(refreshOverrideFile).toHaveBeenCalled();
    const calls = vi.mocked(refreshOverrideFile).mock.calls;
    for (const call of calls) {
      expect(call[5]).toBe(true); // dryRun argument (6th positional, index 5)
    }

    // Config should not be written during dry-run
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('uses per-override baseCommit when available', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
          baseCommit: 'override-specific-sha',
        },
      },
      custom: {},
    });
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    // Should use the per-override baseCommit, not the global state one
    const calls = vi.mocked(refreshOverrideFile).mock.calls;
    for (const call of calls) {
      expect(call[3]).toBe('override-specific-sha');
    }
  });

  it('persists baseCommit after successful refresh', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'file.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(writeFurnaceConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFurnaceConfig).mock.calls[0] as unknown as [
      string,
      { overrides: Record<string, { baseVersion: string; baseCommit?: string }> },
    ];
    expect(call[1].overrides['moz-button']).toHaveProperty('baseCommit', 'engine-head-sha999');
  });

  it('advances baseCommit to engine HEAD even when state.baseCommit is absent', async () => {
    vi.mocked(loadState).mockResolvedValueOnce({
      baseCommit: 'old-commit-for-lookup',
    });
    vi.mocked(loadFurnaceConfig)
      .mockResolvedValueOnce({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-button': {
            type: 'full',
            description: 'Button override',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '145.0',
            baseCommit: 'old-commit-for-lookup',
          },
        },
        custom: {},
      })
      .mockResolvedValueOnce({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-button': {
            type: 'full',
            description: 'Button override',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '145.0',
            baseCommit: 'old-commit-for-lookup',
          },
        },
        custom: {},
      });
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'file.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(writeFurnaceConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFurnaceConfig).mock.calls[0] as unknown as [
      string,
      { overrides: Record<string, { baseVersion: string; baseCommit?: string }> },
    ];
    // baseCommit must advance to engine HEAD, not stay at the old value
    expect(call[1].overrides['moz-button']).toHaveProperty('baseCommit', 'engine-head-sha999');
    expect(call[1].overrides['moz-button']).toHaveProperty('baseVersion', '140.9.0');
  });

  it('throws when override directory is missing', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('overrides/moz-button'))
        return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await expect(furnaceRefreshCommand('/project', 'moz-button')).rejects.toThrow(
      'Override directory not found'
    );
  });

  it('refreshes later overrides in --all mode, then throws a hard-failure summary', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
        },
        'moz-card': {
          type: 'full',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(refreshOverrideFile)
      .mockRejectedValueOnce(new Error('merge helper exploded'))
      .mockResolvedValue({ fileName: 'moz-card.mjs', status: 'merged' });

    await expect(furnaceRefreshCommand('/project', undefined, { all: true })).rejects.toThrow(
      /Failed to refresh 1 override\(s\): moz-button: merge helper exploded/
    );

    expect(refreshOverrideFile).toHaveBeenCalledWith(
      '/project/engine',
      expect.stringContaining('/components/overrides/moz-button/'),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false,
      undefined
    );
    expect(refreshOverrideFile).toHaveBeenCalledWith(
      '/project/engine',
      expect.stringContaining('/components/overrides/moz-card/'),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false,
      undefined
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moz-button: merge helper exploded'));
  });
});
