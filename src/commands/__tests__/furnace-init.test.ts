// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/furnace-config.js', () => ({
  createDefaultFurnaceConfig: vi.fn(() => ({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  })),
  furnaceConfigExists: vi.fn(),
  writeFurnaceConfig: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
}));

import { text } from '@clack/prompts';

import { furnaceConfigExists, writeFurnaceConfig } from '../../core/furnace-config.js';
import { cancel, info, isCancel, note, success } from '../../utils/logger.js';
import { furnaceInitCommand } from '../furnace/init.js';

describe('furnaceInitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    vi.mocked(text).mockResolvedValue('moz-');
  });

  it('creates furnace.json with defaults in non-interactive mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        componentPrefix: 'moz-',
      })
    );
    expect(success).toHaveBeenCalledWith('Created furnace.json');
  });

  it('throws when furnace.json already exists without --force', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);

    await expect(furnaceInitCommand('/project')).rejects.toThrow(
      'furnace.json already exists. Use --force to overwrite it.'
    );

    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('overwrites furnace.json when --force is passed', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await furnaceInitCommand('/project', { force: true });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(writeFurnaceConfig).toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('Created furnace.json');
  });

  it('uses --prefix option without prompting', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await furnaceInitCommand('/project', { prefix: 'ff-' });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(text).not.toHaveBeenCalled();
    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        componentPrefix: 'ff-',
      })
    );
  });

  it('rejects path traversal in --ftlBasePath', async () => {
    await expect(furnaceInitCommand('/project', { ftlBasePath: '../escape/path' })).rejects.toThrow(
      /must not escape the engine checkout via parent-directory segments/
    );
  });

  it('rejects absolute paths in --ftlBasePath', async () => {
    await expect(furnaceInitCommand('/project', { ftlBasePath: '/absolute/path' })).rejects.toThrow(
      /must be a relative path/
    );
  });

  it('rejects Windows-drive absolute paths in --ftlBasePath', async () => {
    await expect(
      furnaceInitCommand('/project', { ftlBasePath: 'C:\\absolute\\path' })
    ).rejects.toThrow(/must be a relative path/);
  });

  it('rejects null bytes in --ftlBasePath', async () => {
    await expect(furnaceInitCommand('/project', { ftlBasePath: 'bad\0path' })).rejects.toThrow(
      /must not contain null bytes/
    );
  });

  it('sets ftlBasePath from option', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await furnaceInitCommand('/project', { ftlBasePath: 'custom/locale/path' });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        ftlBasePath: 'custom/locale/path',
      })
    );
  });

  it('shows next steps after init', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(info).toHaveBeenCalledWith(expect.stringContaining('furnace scan'));
    expect(note).toHaveBeenCalled();
  });

  it('cancels when prefix prompt is cancelled', async () => {
    vi.mocked(isCancel).mockReturnValue(true);
    vi.mocked(text).mockResolvedValue(Symbol('cancel') as unknown as string);

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }

    expect(cancel).toHaveBeenCalledWith('Init cancelled');
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });
});
