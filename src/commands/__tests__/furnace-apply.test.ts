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

vi.mock('../../core/furnace-apply.js', () => ({
  applyAllComponents: vi.fn(),
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

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
  })),
}));

import { applyAllComponents } from '../../core/furnace-apply.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, outro, spinner, success, warn } from '../../utils/logger.js';
import { furnaceApplyCommand } from '../furnace/apply.js';

describe('furnaceApplyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
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
  });

  it('fails when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/Engine directory not found/i);

    expect(intro).toHaveBeenCalledWith('Furnace Apply');
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('fails when furnace is not configured yet', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/No furnace\.json found/i);

    expect(loadFurnaceConfig).not.toHaveBeenCalled();
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('returns early when there are no components to apply', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await furnaceApplyCommand('/project');

    expect(info).toHaveBeenCalledWith('No components to apply.');
    expect(outro).toHaveBeenCalledWith('Done');
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('reports dry-run output for applied, skipped, and warning entries', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['a.css', 'b.css'],
          stepErrors: [{ step: 'register', error: 'already present' }],
        },
      ],
      skipped: [{ name: 'moz-sidebar', reason: 'unchanged' }],
      errors: [],
      actions: [],
    });

    await furnaceApplyCommand('/project', { dryRun: true });

    expect(applyAllComponents).toHaveBeenCalledWith('/project', true);
    expect(info).toHaveBeenCalledWith('[dry-run] Would apply moz-card (override) → 2 files');
    expect(warn).toHaveBeenCalledWith('moz-card: [register] already present');
    expect(info).toHaveBeenCalledWith('moz-sidebar — unchanged');
    expect(outro).toHaveBeenCalledWith('Dry run complete — would apply 1, skip 1');
    expect(success).not.toHaveBeenCalled();
  });

  it('reports real apply errors and throws after logging them', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['a.css'],
          stepErrors: [],
        },
      ],
      skipped: [],
      errors: [{ name: 'moz-sidebar', error: 'copy failed' }],
      actions: [],
    });

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/1 component failed to apply/i);

    expect(spinner).toHaveBeenCalledWith('Applying components to engine...');
    expect(success).toHaveBeenCalledWith('moz-card (override) → 1 files');
    expect(error).toHaveBeenCalledWith('moz-sidebar — copy failed');
    expect(outro).not.toHaveBeenCalled();
  });

  it('treats step errors as apply failures after logging them', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['a.css'],
          stepErrors: [{ step: 'register', error: 'customElements.js missing' }],
        },
      ],
      skipped: [],
      errors: [],
      actions: [],
    });

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/failed to apply cleanly/i);

    expect(success).toHaveBeenCalledWith('moz-card (override) → 1 files');
    expect(warn).toHaveBeenCalledWith('moz-card: [register] customElements.js missing');
    expect(outro).not.toHaveBeenCalled();
  });
});
