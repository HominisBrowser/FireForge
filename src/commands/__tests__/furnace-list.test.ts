// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: true,
        },
      },
    })
  ),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}));

import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { info, intro, note, outro } from '../../utils/logger.js';
import { furnaceListCommand } from '../furnace/list.js';

describe('furnaceListCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: true,
        },
      },
    });
  });

  it('returns a getting-started message when furnace is not configured', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);

    await furnaceListCommand('/project');

    expect(intro).toHaveBeenCalledWith('Furnace List');
    expect(info).toHaveBeenCalledWith(
      'No components configured. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
    expect(outro).toHaveBeenCalledWith('Done');
    expect(loadFurnaceConfig).not.toHaveBeenCalled();
  });

  it('returns the same getting-started message when the config is empty', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await furnaceListCommand('/project');

    expect(info).toHaveBeenCalledWith(
      'No components configured. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
    expect(outro).toHaveBeenCalledWith('Done');
    expect(note).not.toHaveBeenCalled();
  });

  it('lists stock, override, and custom components with a summary', async () => {
    await furnaceListCommand('/project');

    expect(info).toHaveBeenCalledWith('Stock:');
    expect(info).toHaveBeenCalledWith('  moz-button');
    expect(info).toHaveBeenCalledWith('Overrides:');
    expect(info).toHaveBeenCalledWith('  moz-card (css-only) — Override card');
    expect(info).toHaveBeenCalledWith('Custom:');
    expect(info).toHaveBeenCalledWith('  moz-sidebar — Custom sidebar [localized, registered]');
    expect(note).toHaveBeenCalledWith('Stock: 1  Overrides: 1  Custom: 1  Total: 3', 'Summary');
    expect(outro).toHaveBeenCalledWith('List complete');
  });
});
