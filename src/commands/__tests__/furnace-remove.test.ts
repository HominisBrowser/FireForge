// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../core/furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-audit-widget': {
          description: 'Audit widget',
          targetPath: 'toolkit/content/widgets/moz-audit-widget',
          register: true,
          localized: false,
        },
      },
    })
  ),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
  getFurnacePaths: vi.fn(() => ({
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
  })),
}));

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
      binaryName: 'mybrowser',
    })
  ),
}));

vi.mock('../../core/manifest-register.js', () => ({
  deregisterTestManifest: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/furnace-registration.js', () => ({
  removeCustomElementRegistration: vi.fn(() => Promise.resolve()),
  removeJarMnEntries: vi.fn(() => Promise.resolve()),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve([])),
  unlink: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
  removeDir: vi.fn(() => Promise.resolve()),
  readText: vi.fn(() => Promise.resolve('')),
  writeText: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { readdir, unlink } from 'node:fs/promises';

import * as clack from '@clack/prompts';

import { loadFurnaceConfig, writeFurnaceConfig } from '../../core/furnace-config.js';
import {
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import { deregisterTestManifest } from '../../core/manifest-register.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists, readText, removeDir, writeText } from '../../utils/fs.js';
import { cancel as logCancel, info, isCancel, warn } from '../../utils/logger.js';
import { furnaceRemoveCommand } from '../furnace/remove.js';

describe('furnaceRemoveCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  it('deregisters custom components before deleting deployed files', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget'
      )
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { force: true });

    expect(removeCustomElementRegistration).toHaveBeenCalledWith(
      '/project/engine',
      'moz-audit-widget'
    );
    expect(removeJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-audit-widget');

    const ceCallOrder = vi.mocked(removeCustomElementRegistration).mock.invocationCallOrder[0];
    const jarCallOrder = vi.mocked(removeJarMnEntries).mock.invocationCallOrder[0];
    const deleteTargetOrder = vi
      .mocked(removeDir)
      .mock.calls.find(
        ([target]) => target === '/project/engine/toolkit/content/widgets/moz-audit-widget'
      );

    expect(ceCallOrder).toBeLessThan(deleteTargetOrder ? 999999 : Number.MAX_SAFE_INTEGER);
    expect(jarCallOrder).toBeLessThan(deleteTargetOrder ? 999999 : Number.MAX_SAFE_INTEGER);
  });

  it('throws when component is not found in furnace.json', async () => {
    await expect(furnaceRemoveCommand('/project', 'moz-unknown', { force: true })).rejects.toThrow(
      FurnaceError
    );
    await expect(furnaceRemoveCommand('/project', 'moz-unknown', { force: true })).rejects.toThrow(
      'not found in furnace.json'
    );
  });

  it('throws in non-interactive mode without --force', async () => {
    await expect(furnaceRemoveCommand('/project', 'moz-audit-widget')).rejects.toThrow(
      FurnaceError
    );
    await expect(furnaceRemoveCommand('/project', 'moz-audit-widget')).rejects.toThrow(
      'without --force'
    );
  });

  it('removes a stock component from furnace.json', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button', 'moz-card'],
      overrides: {},
      custom: {},
    });

    await furnaceRemoveCommand('/project', 'moz-button', { force: true });

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        stock: ['moz-card'],
      })
    );
  });

  it('removes an override component and its directory', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/overrides/moz-card' ||
          target === '/project/engine/toolkit/content/widgets/moz-card'
      )
    );

    await furnaceRemoveCommand('/project', 'moz-card', { force: true });

    expect(removeDir).toHaveBeenCalledWith('/project/components/overrides/moz-card');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deployed files may remain'));
    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ overrides: {} })
    );
  });

  it('cancels when interactive confirmation is declined', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.mocked(isCancel).mockReturnValueOnce(true);

    await furnaceRemoveCommand('/project', 'moz-audit-widget');

    expect(logCancel).toHaveBeenCalledWith('Remove cancelled');
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('cleans up test files for custom components', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget' ||
          target === '/project/engine/browser/base/content/test/mybrowser' ||
          target ===
            '/project/engine/browser/base/content/test/mybrowser/browser_mybrowser_audit_widget.js' ||
          target === '/project/engine/browser/base/content/test/mybrowser/browser.toml'
      )
    );
    vi.mocked(readText).mockResolvedValue('\n["browser_mybrowser_audit_widget.js"]\n');
    vi.mocked(readdir).mockResolvedValue([]);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { force: true });

    expect(unlink).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/test/mybrowser/browser_mybrowser_audit_widget.js'
    );
    expect(writeText).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/test/mybrowser/browser.toml',
      expect.any(String)
    );
    expect(removeDir).toHaveBeenCalledWith('/project/engine/browser/base/content/test/mybrowser');
  });

  it('deregisters test manifest when test directory becomes empty', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(target === '/project/engine/browser/base/content/test/mybrowser')
    );
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(deregisterTestManifest).mockResolvedValue(true);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { force: true });

    expect(deregisterTestManifest).toHaveBeenCalledWith('/project/engine', 'mybrowser');
    expect(info).toHaveBeenCalledWith('Deregistered test manifest from browser/base/moz.build');
  });

  it('warns but continues when test file cleanup fails', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(target === '/project/engine/browser/base/content/test/mybrowser')
    );
    vi.mocked(readdir).mockRejectedValue(new Error('EPERM'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { force: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not clean up test files'));
  });

  it('confirms interactively when TTY is available and --force is not set', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.mocked(clack.confirm).mockResolvedValueOnce(true);

    await furnaceRemoveCommand('/project', 'moz-audit-widget');

    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('moz-audit-widget') } as Record<
        string,
        unknown
      >)
    );
    expect(writeFurnaceConfig).toHaveBeenCalled();
  });
});
