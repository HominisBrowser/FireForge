// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  warn: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

vi.mock('../../core/register-shared-css.js', () => ({
  registerSharedCSS: vi.fn(),
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

import { getProjectPaths } from '../../core/config.js';
import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { registerSharedCSS } from '../../core/register-shared-css.js';
import { pathExists } from '../../utils/fs.js';
import { cancel, info, isCancel, note, success, warn } from '../../utils/logger.js';
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
    vi.mocked(text).mockResolvedValue(Symbol('cancel'));

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

  it('registers the scaffolded tokens CSS in jar.inc.mn (Finding 2)', async () => {
    // Pre-fix: `furnace init` scaffolded the tokens CSS file and added
    // it to `patchLint.rawColorAllowlist`, but did not register it in
    // `browser/themes/shared/jar.inc.mn`. The next `fireforge status`
    // therefore correctly flagged the file as unmanaged + unregistered,
    // and `furnace deploy --dry-run` reported "No components to
    // deploy" — a documented init command turned a clean project into
    // an unclean one. The fix calls `registerSharedCSS` so the file is
    // owned end-to-end.
    vi.mocked(pathExists).mockImplementation((path: string) => {
      // engine/ exists; tokens CSS does not yet exist (so we exercise
      // the scaffold + register path).
      if (path === '/project/engine') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(registerSharedCSS).mockResolvedValue({
      manifest: 'browser/themes/shared/jar.inc.mn',
      entry: '  skin/classic/browser/mybrowser-tokens.css    (../shared/mybrowser-tokens.css)',
      skipped: false,
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(vi.mocked(registerSharedCSS)).toHaveBeenCalledWith(
      '/project/engine',
      'mybrowser-tokens.css',
      undefined,
      false
    );
    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('Registered mybrowser-tokens.css in browser/themes/shared/jar.inc.mn')
    );
  });

  it('treats already-registered tokens CSS as a silent no-op', async () => {
    // `furnace init --force` against a project where the tokens CSS is
    // already registered must be idempotent: the registration helper
    // returns `skipped: true`, so no info banner is emitted.
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(registerSharedCSS).mockResolvedValue({
      manifest: 'browser/themes/shared/jar.inc.mn',
      entry: '  skin/classic/browser/mybrowser-tokens.css    (../shared/mybrowser-tokens.css)',
      skipped: true,
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    const infoCalls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(infoCalls).not.toContain(
      expect.stringContaining('Registered mybrowser-tokens.css in browser/themes/shared/jar.inc.mn')
    );
  });

  it('warns but does not fail when tokens CSS registration throws', async () => {
    // jar.inc.mn might not exist yet (the engine has not been fully
    // populated, or the operator is testing). Failure to register must
    // be a soft warning, never a hard failure that aborts init.
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(registerSharedCSS).mockRejectedValue(
      new Error('Manifest not found: browser/themes/shared/jar.inc.mn')
    );

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await furnaceInitCommand('/project');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    }

    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('Could not register tokens CSS in browser/themes/shared/jar.inc.mn')
    );
    // Init still completed — `success("Created furnace.json")` fired.
    expect(vi.mocked(success)).toHaveBeenCalledWith('Created furnace.json');
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

describe('furnaceInitCommand — ftlBasePath filesystem shape probe', () => {
  let engineRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    engineRoot = await mkdtemp(join(tmpdir(), 'ff-init-probe-'));
    // The probe only runs when the engine directory exists; point the mocked
    // project paths at a real tempdir so the unmocked `stat` has something to
    // look at. The all-mocked suite above never reached this block.
    vi.mocked(getProjectPaths).mockReturnValue({
      root: '/project',
      engine: engineRoot,
      config: '/project/fireforge.json',
      fireforgeDir: '/project/.fireforge',
      state: '/project/.fireforge/state.json',
      patches: '/project/patches',
      configs: '/project/configs',
      src: '/project/src',
      componentsDir: '/project/components',
    });
    vi.mocked(pathExists).mockImplementation((p: string) => Promise.resolve(p === engineRoot));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(engineRoot, { recursive: true, force: true });
  });

  it('accepts a path that resolves to a real directory', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(engineRoot, 'toolkit/locales/en-US'), { recursive: true });

    await furnaceInitCommand('/project', { ftlBasePath: 'toolkit/locales/en-US' });

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ ftlBasePath: 'toolkit/locales/en-US' })
    );
  });

  it('refuses a path that resolves to a file rather than a directory', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(engineRoot, 'toolkit'), { recursive: true });
    await writeFile(join(engineRoot, 'toolkit/notadir'), 'x', 'utf-8');

    await expect(
      furnaceInitCommand('/project', { ftlBasePath: 'toolkit/notadir' })
    ).rejects.toThrow(/resolves to a non-directory/);
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('warns but proceeds when the locale tree is not extracted yet (ENOENT)', async () => {
    await furnaceInitCommand('/project', { ftlBasePath: 'toolkit/locales/en-US' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not yet exist at'));
    expect(writeFurnaceConfig).toHaveBeenCalled();
  });

  it('rejects an empty ftlBasePath before touching the filesystem', async () => {
    await expect(furnaceInitCommand('/project', { ftlBasePath: '' })).rejects.toThrow(
      /must not be empty/
    );
  });
});

describe('furnaceInitCommand — interactive ftlBasePath prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    // `vi.clearAllMocks()` clears calls but not implementations, so reset the
    // two prompt mocks explicitly — earlier blocks leave `mockResolvedValueOnce`
    // queues and `isCancel` overrides behind.
    vi.mocked(text).mockReset();
    vi.mocked(isCancel).mockReset();
    vi.mocked(isCancel).mockReturnValue(false);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  it('keeps the default when the operator submits an empty path', async () => {
    vi.mocked(text).mockResolvedValueOnce('moz-').mockResolvedValueOnce('   ');

    await furnaceInitCommand('/project', {});

    const written = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
    expect(written?.componentPrefix).toBe('moz-');
    // Empty input leaves the created default in place rather than writing ''.
    expect(written?.ftlBasePath).not.toBe('');
  });

  it('applies a non-empty answer after validating it', async () => {
    vi.mocked(text).mockResolvedValueOnce('moz-').mockResolvedValueOnce('  browser/locales/x  ');

    await furnaceInitCommand('/project', {});

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ ftlBasePath: 'browser/locales/x' })
    );
  });

  it('cancels without writing when the ftl prompt is aborted', async () => {
    vi.mocked(text).mockResolvedValueOnce('moz-').mockResolvedValueOnce('ignored');
    vi.mocked(isCancel).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await furnaceInitCommand('/project', {});

    expect(cancel).toHaveBeenCalledWith('Init cancelled');
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('rejects an empty component prefix through the prompt validator', async () => {
    // This asserted `expect(true).toBe(true)` on a validator it read from a
    // mock call that the test never made — the command was not invoked at all.
    vi.mocked(text).mockResolvedValueOnce('moz-').mockResolvedValueOnce('');

    await furnaceInitCommand('/project', {});

    // clack types `validate` as a union with a StandardSchema object, so narrow
    // to the callback form before invoking it.
    const validate = vi.mocked(text).mock.calls[0]?.[0]?.validate;
    if (typeof validate !== 'function') throw new Error('expected a validate callback');
    expect(validate('')).toBe('Prefix is required');
    expect(validate('moz-')).toBeUndefined();
  });
});
