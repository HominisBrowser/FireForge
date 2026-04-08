// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
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
}));

vi.mock('../../core/furnace-config.js', () => ({
  ensureFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    })
  ),
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
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
      custom: {},
    })
  ),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-scanner.js', () => ({
  scanWidgetsDirectory: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  cancel: vi.fn(),
  info: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn() })),
  success: vi.fn(),
}));

import * as prompts from '@clack/prompts';

import {
  ensureFurnaceConfig,
  furnaceConfigExists,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, spinner, success } from '../../utils/logger.js';
import { furnaceScanCommand } from '../furnace/scan.js';

const stdinTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTTY(stdinIsTTY: boolean, stdoutIsTTY: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTTY, configurable: true });
}

describe('furnaceScanCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    setTTY(false, false);
  });

  afterAll(() => {
    if (stdinTTYDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinTTYDescriptor);
    }
    if (stdoutTTYDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutTTYDescriptor);
    }
  });

  it('fails when the Firefox source tree is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(furnaceScanCommand('/project')).rejects.toBeInstanceOf(FurnaceError);
    await expect(furnaceScanCommand('/project')).rejects.toThrow(
      'Engine directory not found. Run "fireforge download" first.'
    );

    expect(intro).toHaveBeenCalledWith('Furnace Scan');
    expect(scanWidgetsDirectory).not.toHaveBeenCalled();
  });

  it('lists tracked and untracked components in non-interactive mode', async () => {
    const stop = vi.fn();
    vi.mocked(spinner).mockReturnValue({ message: vi.fn(), stop, error: vi.fn() });
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
      custom: {},
    });
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-button',
        sourcePath: 'toolkit/content/widgets/moz-button',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: false,
        hasFTL: true,
        isRegistered: false,
      },
      {
        tagName: 'moz-card',
        sourcePath: 'toolkit/content/widgets/moz-card',
        hasCSS: true,
        hasFTL: true,
        isRegistered: true,
      },
    ]);

    await furnaceScanCommand('/project');

    expect(stop).toHaveBeenCalledWith('Found 3 components');
    expect(info).toHaveBeenCalledWith('moz-button — CSS, registered [stock]');
    expect(info).toHaveBeenCalledWith('moz-panel — FTL');
    expect(info).toHaveBeenCalledWith('moz-card — CSS, FTL, registered [override]');
    expect(note).toHaveBeenCalledWith('Total: 3  Tracked: 2  Untracked: 1', 'Summary');
    expect(outro).toHaveBeenCalledWith('Scan complete');
  });

  it('adds selected untracked components in interactive mode', async () => {
    setTTY(true, true);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
      {
        tagName: 'moz-dialog',
        sourcePath: 'toolkit/content/widgets/moz-dialog',
        hasCSS: false,
        hasFTL: true,
        isRegistered: false,
      },
    ]);
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    vi.mocked(prompts.multiselect).mockResolvedValue(['moz-panel']);
    vi.mocked(ensureFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-existing'],
      overrides: {},
      custom: {},
    });

    await furnaceScanCommand('/project');

    expect(prompts.confirm).toHaveBeenCalledWith({ message: 'Add components to furnace.json?' });
    expect(prompts.multiselect).toHaveBeenCalledWith({
      message: 'Select components to add as stock',
      options: [
        { value: 'moz-panel', label: 'moz-panel — CSS, registered' },
        { value: 'moz-dialog', label: 'moz-dialog — FTL' },
      ],
    });
    expect(writeFurnaceConfig).toHaveBeenCalledWith('/project', {
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-existing', 'moz-panel'],
      overrides: {},
      custom: {},
    });
    expect(success).toHaveBeenCalledWith('Added 1 component to furnace.json');
    expect(outro).not.toHaveBeenCalledWith('Scan complete');
  });
});
