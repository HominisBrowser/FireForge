// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../core/furnace-staleness.js', () => ({ listStaleFurnaceComponents: vi.fn() }));

import { listStaleFurnaceComponents } from '../../core/furnace-staleness.js';
import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { verbose } from '../../utils/logger.js';
import { partitionReachedComponents, resolveFurnaceApplyMode } from '../test-furnace-reach.js';

describe('resolveFurnaceApplyMode', () => {
  const config = (furnaceApply?: 'all' | 'reached' | 'none'): FireForgeConfig =>
    ({ test: furnaceApply === undefined ? {} : { furnaceApply } }) as FireForgeConfig;

  it('prefers the flag, maps --no-furnace-apply to none, and falls back to config, then all', () => {
    expect(resolveFurnaceApplyMode({ furnaceApply: false }, config('reached'))).toBe('none');
    expect(resolveFurnaceApplyMode({ furnaceApply: 'reached' }, config('none'))).toBe('reached');
    expect(resolveFurnaceApplyMode({ furnaceApply: true }, config('reached'))).toBe('reached');
    expect(resolveFurnaceApplyMode({}, config())).toBe('all');
  });
});

describe('partitionReachedComponents', () => {
  let root: string;
  let engineDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await createTempProject('ff-furnace-reach-');
    engineDir = join(root, 'engine');
    await writeFiles(engineDir, {
      'browser/test/tiles/browser.toml': '["browser_tiles.js"]\n',
      'browser/test/tiles/browser_tiles.js': 'document.createElement("moz-tile");\n',
      'browser/test/tiles/head.js': 'await customElements.whenDefined("moz-dock");\n',
      'browser/test/vault/browser_vault.js': 'nothing here\n',
      'browser/test/vault/sub/browser_deep.js': '"moz-vault-row"\n',
      'browser/test/vault/sub/data.bin': 'moz-ignored',
      'browser/test/moz-sheet/browser_sheet.js': 'x\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(root);
  });

  it('applies only the stale components a requested test, head or path names', async () => {
    vi.mocked(listStaleFurnaceComponents).mockResolvedValue([
      'moz-tile',
      'moz-dock',
      'moz-vault-row',
      'moz-sheet',
      'moz-ignored',
      'moz-other',
    ]);
    await expect(
      partitionReachedComponents(root, engineDir, [
        'browser/test/tiles/browser_tiles.js',
        'browser/test/vault',
        'browser/test/moz-sheet/browser_sheet.js',
        'browser/test/missing/browser_gone.js',
      ])
    ).resolves.toEqual({
      reached: ['moz-tile', 'moz-dock', 'moz-vault-row', 'moz-sheet'],
      skipped: ['moz-ignored', 'moz-other'],
    });
  });

  it('reaches nothing without stale components, and degrades a broken probe', async () => {
    vi.mocked(listStaleFurnaceComponents).mockResolvedValueOnce([]);
    await expect(
      partitionReachedComponents(root, engineDir, ['browser/test/tiles/browser_tiles.js'])
    ).resolves.toEqual({ reached: [], skipped: [] });
    vi.mocked(listStaleFurnaceComponents).mockRejectedValueOnce(new Error('bad furnace.json'));
    await expect(partitionReachedComponents(root, engineDir, ['x'])).resolves.toEqual({
      reached: [],
      skipped: [],
    });
    expect(verbose).toHaveBeenCalledWith(expect.stringContaining('bad furnace.json'));
  });
});
