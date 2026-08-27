// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for engine-side orphan detection: files a previous deploy left in
 * the engine whose workspace source was renamed or removed must surface as
 * `orphaned-engine-file` drift.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

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

import { nativePath } from '../../test-utils/index.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { findOrphanedEngineFiles } from '../furnace-validate.js';

const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

function makeConfig(): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-panel': {
        description: 'Custom panel',
        targetPath: 'browser/components/panel',
        register: true,
        localized: false,
      },
    },
  };
}

describe('findOrphanedEngineFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags an engine file whose workspace source was renamed away', async () => {
    const state = {
      appliedChecksums: {
        'custom/moz-panel/moz-panel.mjs': 'mjs-hash',
        'custom/moz-panel/panel-helper-old.mjs': 'old-hash',
      },
    };
    vi.mocked(pathExists).mockImplementation((p) =>
      // Workspace: main module still present, renamed helper gone.
      // Engine: the stale deployed helper still exists.
      Promise.resolve(p !== nativePath('/project/components/custom/moz-panel/panel-helper-old.mjs'))
    );

    const issues = await findOrphanedEngineFiles(
      '/project',
      makeConfig(),
      'moz-panel',
      state,
      FTL_DIR
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('orphaned-engine-file');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('panel-helper-old.mjs');
    expect(issues[0]?.message).toContain('stale jar.mn entry');
    expect(issues[0]?.message).toContain('fireforge furnace deploy moz-panel');
  });

  it('stays quiet when the engine copy was already pruned', async () => {
    const state = {
      appliedChecksums: { 'custom/moz-panel/panel-helper-old.mjs': 'old-hash' },
    };
    // Neither workspace source nor engine copy exists anymore.
    vi.mocked(pathExists).mockResolvedValue(false);

    const issues = await findOrphanedEngineFiles(
      '/project',
      makeConfig(),
      'moz-panel',
      state,
      FTL_DIR
    );

    expect(issues).toHaveLength(0);
  });

  it('stays quiet when workspace and state agree', async () => {
    const state = {
      appliedChecksums: { 'custom/moz-panel/moz-panel.mjs': 'mjs-hash' },
    };
    vi.mocked(pathExists).mockResolvedValue(true);

    const issues = await findOrphanedEngineFiles(
      '/project',
      makeConfig(),
      'moz-panel',
      state,
      FTL_DIR
    );

    expect(issues).toHaveLength(0);
  });

  it('resolves .ftl orphans against the locale directory', async () => {
    const state = {
      appliedChecksums: { 'custom/moz-panel/moz-panel.ftl': 'ftl-hash' },
    };
    const seen: string[] = [];
    vi.mocked(pathExists).mockImplementation((p) => {
      seen.push(p);
      return Promise.resolve(!p.startsWith(nativePath('/project/components/')));
    });

    const issues = await findOrphanedEngineFiles(
      '/project',
      makeConfig(),
      'moz-panel',
      state,
      FTL_DIR
    );

    expect(issues).toHaveLength(1);
    expect(seen).toContain(nativePath(`/project/engine/${FTL_DIR}/moz-panel.ftl`));
  });

  it('returns empty for components without recorded state or config', async () => {
    expect(
      await findOrphanedEngineFiles('/project', makeConfig(), 'moz-panel', {}, FTL_DIR)
    ).toEqual([]);
    expect(
      await findOrphanedEngineFiles(
        '/project',
        makeConfig(),
        'moz-unknown',
        { appliedChecksums: { 'custom/moz-unknown/a.mjs': 'h' } },
        FTL_DIR
      )
    ).toEqual([]);
  });
});
