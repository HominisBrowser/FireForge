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
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    })
  ),
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
          baseVersion: '146.0esr',
        },
      },
      custom: {
        'moz-widget': {
          description: 'Custom widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: true,
          localized: false,
        },
      },
    })
  ),
}));

vi.mock('../../core/furnace-apply.js', () => ({
  applyAllComponents: vi.fn(() =>
    Promise.resolve({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['moz-card.css'] }],
      skipped: [{ name: 'moz-widget', reason: 'No changes since last apply' }],
      errors: [],
    })
  ),
}));

vi.mock('../../core/furnace-apply-output.js', () => ({
  logApplyResult: vi.fn(),
}));

vi.mock('../../core/furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn((_root: string, _kind: string, body: (ctx: unknown) => unknown) =>
    body({ registerJournal: vi.fn(), registerCleanup: vi.fn() })
  ),
}));

vi.mock('../../core/furnace-version-drift.js', () => ({
  findOverrideBaseVersionDrift: vi.fn(() => [
    {
      name: 'moz-card',
      baseVersion: '146.0esr',
      currentVersion: '141.0esr',
    },
  ]),
  formatOverrideBaseVersionDriftWarning: vi.fn(() => 'moz-card: 146.0esr → 141.0esr'),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn(), error: vi.fn() })),
  warn: vi.fn(),
}));

vi.mock('../furnace/refresh.js', () => ({
  furnaceRefreshCommand: vi.fn(() => Promise.resolve()),
}));

import { furnaceConfigExists } from '../../core/furnace-config.js';
import { findOverrideBaseVersionDrift } from '../../core/furnace-version-drift.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro } from '../../utils/logger.js';
import { furnaceRefreshCommand } from '../furnace/refresh.js';
import { furnaceSyncCommand } from '../furnace/sync.js';

describe('furnaceSyncCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(false);

    await expect(furnaceSyncCommand('/project')).rejects.toThrow(/Engine directory not found/);
  });

  it('throws when furnace.json is missing', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValueOnce(false);

    await expect(furnaceSyncCommand('/project')).rejects.toThrow(/No furnace\.json found/);
  });

  it('refreshes drifted overrides and re-applies', async () => {
    await furnaceSyncCommand('/project');

    expect(intro).toHaveBeenCalledWith('Furnace Sync');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('1 override(s) with baseVersion drift')
    );
    expect(furnaceRefreshCommand).toHaveBeenCalledWith('/project', undefined, { all: true });
    expect(outro).toHaveBeenCalledWith(expect.stringContaining('1 applied'));
  });

  it('skips refresh when no overrides are drifted', async () => {
    vi.mocked(findOverrideBaseVersionDrift).mockReturnValueOnce([]);

    await furnaceSyncCommand('/project');

    expect(info).toHaveBeenCalledWith(expect.stringContaining('All overrides are up-to-date'));
    expect(furnaceRefreshCommand).not.toHaveBeenCalled();
  });

  it('respects --dry-run', async () => {
    await furnaceSyncCommand('/project', { dryRun: true });

    expect(furnaceRefreshCommand).toHaveBeenCalledWith('/project', undefined, {
      all: true,
      dryRun: true,
    });
    expect(outro).toHaveBeenCalledWith('Dry run complete');
  });

  it('passes --strategy through to refresh', async () => {
    await furnaceSyncCommand('/project', { strategy: 'theirs' });

    expect(furnaceRefreshCommand).toHaveBeenCalledWith('/project', undefined, {
      all: true,
      strategy: 'theirs',
    });
  });
});
