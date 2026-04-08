// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../config.js', () => ({
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

vi.mock('../furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
  loadFurnaceConfig: vi.fn(),
  loadFurnaceState: vi.fn(),
  saveFurnaceState: vi.fn(),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace-apply-helpers.js', () => ({
  applyCustomComponent: vi.fn(),
  applyOverrideComponent: vi.fn(),
  computeComponentChecksums: vi.fn(),
  extractComponentChecksums: vi.fn(),
  hasComponentChanged: vi.fn(),
  prefixChecksums: vi.fn(),
}));

import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { applyAllComponents } from '../furnace-apply.js';
import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  extractComponentChecksums,
  hasComponentChanged,
  prefixChecksums,
} from '../furnace-apply-helpers.js';
import { loadFurnaceConfig, loadFurnaceState, updateFurnaceState } from '../furnace-config.js';
import { restoreRollbackJournalOrThrow } from '../furnace-rollback.js';

describe('applyAllComponents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'));

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
      custom: {
        'moz-panel': {
          description: 'Custom panel',
          targetPath: 'browser/components/panel',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({
      appliedChecksums: {
        'override:moz-card:old.css': 'old-hash',
      },
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(extractComponentChecksums).mockReturnValue({ 'old.css': 'old-hash' });
    vi.mocked(prefixChecksums).mockImplementation((checksums, type, name) => {
      return Object.fromEntries(
        Object.entries(checksums).map(([file, hash]) => [`${type}:${name}:${file}`, hash])
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) =>
      Promise.resolve(filePath !== '/project/engine')
    );

    await expect(applyAllComponents('/project')).rejects.toThrow(FurnaceError);
    await expect(applyAllComponents('/project')).rejects.toThrow('Run "fireforge download" first');
    expect(applyOverrideComponent).not.toHaveBeenCalled();
    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('aggregates dry-run actions without change detection or state persistence', async () => {
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.css'],
      actions: [
        {
          component: 'moz-card',
          action: 'copy',
          source: 'components/overrides/moz-card/moz-card.css',
          target: 'engine/toolkit/content/widgets/moz-card/moz-card.css',
          description: 'Copy override CSS',
        },
      ],
    });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [
        {
          component: 'moz-panel',
          action: 'register-ce',
          description: 'Register custom element',
        },
      ],
    });

    const result = await applyAllComponents('/project', true);

    expect(result).toEqual({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['toolkit/content/widgets/moz-card/moz-card.css'],
        },
        {
          name: 'moz-panel',
          type: 'custom',
          filesAffected: ['browser/components/panel/moz-panel.mjs'],
        },
      ],
      skipped: [],
      errors: [],
      actions: [
        {
          component: 'moz-card',
          action: 'copy',
          source: 'components/overrides/moz-card/moz-card.css',
          target: 'engine/toolkit/content/widgets/moz-card/moz-card.css',
          description: 'Copy override CSS',
        },
        {
          component: 'moz-panel',
          action: 'register-ce',
          description: 'Register custom element',
        },
      ],
    });
    expect(hasComponentChanged).not.toHaveBeenCalled();
    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(restoreRollbackJournalOrThrow).not.toHaveBeenCalled();
  });

  it('skips unchanged overrides, stores new custom checksums, and persists updated state', async () => {
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'panel.mjs': 'new-hash' });

    const result = await applyAllComponents('/project');

    expect(result).toEqual({
      applied: [
        {
          name: 'moz-panel',
          type: 'custom',
          filesAffected: ['browser/components/panel/moz-panel.mjs'],
        },
      ],
      skipped: [{ name: 'moz-card', reason: 'No changes since last apply' }],
      errors: [],
    });
    expect(extractComponentChecksums).toHaveBeenCalledWith(
      { 'override:moz-card:old.css': 'old-hash' },
      'override',
      'moz-card'
    );
    expect(prefixChecksums).toHaveBeenCalledWith({ 'old.css': 'old-hash' }, 'override', 'moz-card');
    expect(prefixChecksums).toHaveBeenCalledWith(
      { 'panel.mjs': 'new-hash' },
      'custom',
      'moz-panel'
    );
    expect(updateFurnaceState).toHaveBeenCalledWith('/project', {
      appliedChecksums: {
        'override:moz-card:old.css': 'old-hash',
        'custom:moz-panel:panel.mjs': 'new-hash',
      },
      lastApply: '2026-04-07T12:00:00.000Z',
    });
    expect(restoreRollbackJournalOrThrow).not.toHaveBeenCalled();
  });

  it('applies custom components with step errors but does not persist their checksums', async () => {
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.css'],
      actions: [],
    });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [{ step: 'register', error: 'already present' }],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValueOnce({ 'moz-card.css': 'override-hash' });

    const result = await applyAllComponents('/project');

    expect(result.applied).toEqual([
      {
        name: 'moz-card',
        type: 'override',
        filesAffected: ['toolkit/content/widgets/moz-card/moz-card.css'],
      },
      {
        name: 'moz-panel',
        type: 'custom',
        filesAffected: ['browser/components/panel/moz-panel.mjs'],
        stepErrors: [{ step: 'register', error: 'already present' }],
      },
    ]);
    expect(computeComponentChecksums).toHaveBeenCalledTimes(1);
    // Step errors trigger rollback — state is NOT persisted
    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(restoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      expect.any(Object),
      'Furnace apply failed'
    );
  });

  it('collects missing-directory and apply errors without aborting the batch', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) => {
      if (filePath === '/project/components/overrides/moz-card') {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(applyCustomComponent).mockRejectedValue(new Error('copy failed'));

    const result = await applyAllComponents('/project');

    expect(result).toEqual({
      applied: [],
      skipped: [],
      errors: [
        {
          name: 'moz-card',
          error: 'Component directory not found: components/overrides/moz-card',
        },
        {
          name: 'moz-panel',
          error: 'copy failed',
        },
      ],
    });
    // Errors trigger rollback — state is NOT persisted
    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(restoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      expect.any(Object),
      'Furnace apply failed'
    );
  });
});
