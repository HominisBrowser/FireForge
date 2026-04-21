// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/furnace-config.js', () => ({
  createDefaultFurnaceConfig: vi.fn(
    (options: { binaryName?: string } = {}): Record<string, unknown> => {
      const config: Record<string, unknown> = {
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      };
      if (options.binaryName) {
        config['tokenPrefix'] = `--${options.binaryName}-`;
      }
      return config;
    }
  ),
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
  // `furnaceInitCommand` now probes `fireforge.json` to derive the
  // tokenPrefix default. We resolve a typical config so the derived
  // `tokenPrefix` can be asserted directly; individual tests can
  // override the mock to simulate a missing `fireforge.json`.
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'My Browser',
      vendor: 'Acme',
      appId: 'org.acme.browser',
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    })
  ),
  mutateConfig: vi.fn(
    (config: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> => {
      const clone = { ...config };
      const parts = key.split('.');
      let target = clone;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] ?? '';
        const next = target[part] as Record<string, unknown> | undefined;
        if (next && typeof next === 'object') {
          target[part] = { ...next };
          target = target[part] as Record<string, unknown>;
        } else {
          target[part] = {};
          target = target[part] as Record<string, unknown>;
        }
      }
      target[parts[parts.length - 1] ?? ''] = value;
      return clone;
    }
  ),
  writeConfig: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
  ensureDir: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../core/token-manager.js', () => ({
  getTokensCssPath: vi.fn((binaryName: string) => `browser/themes/shared/${binaryName}-tokens.css`),
}));

vi.mock('../../core/token-scaffold.js', () => ({
  generateDefaultTokensCss: vi.fn(() => ':root { }'),
}));

vi.mock('../../core/license-headers.js', () => ({
  DEFAULT_LICENSE: 'MPL-2.0',
}));

import { text } from '@clack/prompts';

import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
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

  it('rejects file-shaped --ftl-base-path values ending in .ftl', async () => {
    // 2026-04-21 eval (Finding #6): passing a file-like path to
    // --ftl-base-path was accepted, and the subsequent localized
    // `furnace create` wrote an `.mjs` importing `<name>.ftl` but never
    // registered the component in furnace.json, stranding the scaffold.
    // The shape check now refuses the file-like path up-front so no
    // partial state is written.
    await expect(
      furnaceInitCommand('/project', { ftlBasePath: 'browser/forgefresh.ftl' })
    ).rejects.toThrow(/looks like a file/);
  });

  it('rejects file-shaped --ftl-base-path values ending in .properties', async () => {
    await expect(
      furnaceInitCommand('/project', { ftlBasePath: 'browser/strings.properties' })
    ).rejects.toThrow(/looks like a file/);
  });

  it('accepts directory-shaped --ftl-base-path values', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project', {
        ftlBasePath: 'toolkit/locales/en-US/toolkit/global',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }
    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        ftlBasePath: 'toolkit/locales/en-US/toolkit/global',
      })
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

  it('derives tokenPrefix from fireforge.json binaryName by default', async () => {
    // 2026-04-21 eval (Finding #8): `furnace init` left `tokenPrefix`
    // unset, which made `token coverage` report 0 tokens / all unknown
    // even with real tokens in the CSS. Deriving the default from
    // `binaryName` gives coverage a prefix to key off immediately.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    // `createDefaultFurnaceConfig` must be invoked with the binaryName
    // pulled from fireforge.json so the derivation happens inside the
    // single-source-of-truth helper.
    expect(vi.mocked(createDefaultFurnaceConfig)).toHaveBeenCalledWith({
      binaryName: 'mybrowser',
    });

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ tokenPrefix: '--mybrowser-' })
    );
  });

  it('falls back to the prefix-less default when fireforge.json cannot be loaded', async () => {
    // A project that initialises furnace before running `fireforge
    // setup` has no binaryName to derive from. The init must still
    // succeed; `token coverage` will emit its existing "no tokenPrefix"
    // warning when the operator gets around to running it.
    const { loadConfig } = await import('../../core/config.js');
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('no config'));

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(vi.mocked(createDefaultFurnaceConfig)).toHaveBeenCalledWith({});
    const lastWriteCall = vi.mocked(writeFurnaceConfig).mock.calls.slice(-1)[0];
    expect(lastWriteCall?.[1]).not.toHaveProperty('tokenPrefix');
  });
});
