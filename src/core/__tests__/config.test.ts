// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../state-file.js', () => ({
  withStateFileLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation()),
  quarantineStateFile: vi.fn(),
}));

import { ConfigError, ConfigNotFoundError } from '../../errors/config.js';
import type { FireForgeConfig, FireForgeState } from '../../types/config.js';
import { pathExists, readJson, writeJson } from '../../utils/fs.js';
import { verbose, warn } from '../../utils/logger.js';
import {
  CONFIG_FILENAME,
  configExists,
  FIREFORGE_DIR,
  getProjectPaths,
  loadConfig,
  loadState,
  mutateConfig,
  saveState,
  STATE_FILENAME,
  updateState,
  validateConfig,
  writeConfig,
  writeConfigDocument,
} from '../config.js';
import { quarantineStateFile, withStateFileLock } from '../state-file.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadJson = vi.mocked(readJson);
const mockWriteJson = vi.mocked(writeJson);
const mockVerbose = vi.mocked(verbose);
const mockWarn = vi.mocked(warn);
const mockWithStateFileLock = vi.mocked(withStateFileLock);
const mockQuarantineStateFile = vi.mocked(quarantineStateFile);

function makeValidConfig(overrides: Partial<FireForgeConfig> = {}): FireForgeConfig {
  const { firefox, build, wire, license, ...rest } = overrides;

  return {
    name: 'My Browser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: {
      version: '140.0esr',
      product: 'firefox-esr',
      ...(firefox ?? {}),
    },
    build: { jobs: 16, ...(build ?? {}) },
    license: license ?? 'MPL-2.0',
    wire: { subscriptDir: 'browser/base/content', ...(wire ?? {}) },
    ...rest,
  };
}

describe('config helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithStateFileLock.mockImplementation(async (_path, operation) => operation());
    mockQuarantineStateFile.mockResolvedValue(undefined);
  });

  it('builds the expected project paths', () => {
    expect(getProjectPaths('/project')).toEqual({
      root: '/project',
      config: `/project/${CONFIG_FILENAME}`,
      fireforgeDir: `/project/${FIREFORGE_DIR}`,
      state: `/project/${FIREFORGE_DIR}/${STATE_FILENAME}`,
      engine: '/project/engine',
      patches: '/project/patches',
      configs: '/project/configs',
      src: '/project/src',
      componentsDir: '/project/components',
    });
  });

  it('checks whether the config file exists', async () => {
    mockPathExists.mockResolvedValueOnce(true);

    await expect(configExists('/project')).resolves.toBe(true);
    expect(mockPathExists).toHaveBeenCalledWith('/project/fireforge.json');
  });
});

describe('validateConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a strongly typed config for valid input', () => {
    expect(validateConfig(makeValidConfig())).toEqual(makeValidConfig());
  });

  it('logs unknown root keys and ignores them', () => {
    const config = validateConfig({
      ...makeValidConfig(),
      experimental: { enabled: true },
    });

    expect(config).toEqual(makeValidConfig());
    expect(mockVerbose).toHaveBeenCalledWith(
      'Unknown config key "experimental" in fireforge.json — it will be ignored.'
    );
  });

  it('rejects a non-object config document', () => {
    expect(() => validateConfig('not an object')).toThrow('Config must be an object');
  });

  it.each([
    ['name', { ...makeValidConfig(), name: 42 }],
    ['vendor', { ...makeValidConfig(), vendor: 42 }],
    ['appId', { ...makeValidConfig(), appId: 42 }],
    ['binaryName', { ...makeValidConfig(), binaryName: 42 }],
  ])('rejects non-string required field %s', (_field, rawConfig) => {
    expect(() => validateConfig(rawConfig)).toThrow(ConfigError);
  });

  it('rejects binaryName path traversal and separators', () => {
    expect(() => validateConfig(makeValidConfig({ binaryName: '../bad/browser' }))).toThrow(
      'Config field "binaryName" must not contain path separators or ".."'
    );
  });

  it('rejects an invalid appId', () => {
    expect(() => validateConfig(makeValidConfig({ appId: 'bad app id' }))).toThrow(
      'Config field "appId" must be a valid reverse-domain identifier'
    );
  });

  it('rejects a non-object firefox section', () => {
    expect(() => validateConfig({ ...makeValidConfig(), firefox: 'bad' })).toThrow(
      'Config field "firefox" must be an object'
    );
  });

  it('rejects an invalid Firefox version', () => {
    expect(() =>
      validateConfig(makeValidConfig({ firefox: { version: 'zero', product: 'firefox-esr' } }))
    ).toThrow('Config field "firefox.version" must be a valid Firefox version');
  });

  it('rejects an invalid Firefox product', () => {
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        firefox: { version: '140.0esr', product: 'fennec' as never },
      })
    ).toThrow('Config field "firefox.product" must be one of: firefox, firefox-esr, firefox-beta');
  });

  it('rejects invalid optional build, wire, and license fields', () => {
    expect(() => validateConfig({ ...makeValidConfig(), build: 'bad' })).toThrow(
      'Config field "build" must be an object'
    );
    expect(() => validateConfig({ ...makeValidConfig(), build: { jobs: 'bad' } })).toThrow(
      'Config field "build.jobs" must be a positive integer'
    );
    expect(() => validateConfig({ ...makeValidConfig(), build: { jobs: 0 } })).toThrow(
      'Config field "build.jobs" must be a positive integer'
    );
    expect(() => validateConfig({ ...makeValidConfig(), wire: 'bad' })).toThrow(
      'Config field "wire" must be an object'
    );
    expect(() =>
      validateConfig({ ...makeValidConfig(), wire: { subscriptDir: '../bad' } })
    ).toThrow('Config field "wire.subscriptDir" must stay within engine/');
    expect(() =>
      validateConfig({ ...makeValidConfig(), wire: { subscriptDir: '/tmp/elsewhere' } })
    ).toThrow('Config field "wire.subscriptDir" must stay within engine/');
    expect(() => validateConfig({ ...makeValidConfig(), license: 'Apache-2.0' as never })).toThrow(
      'Config field "license" must be one of: EUPL-1.2, MPL-2.0, 0BSD, GPL-2.0-or-later'
    );
  });
});

describe('config persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and validates the config file', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce(makeValidConfig());

    await expect(loadConfig('/project')).resolves.toEqual(makeValidConfig());
    expect(mockReadJson).toHaveBeenCalledWith('/project/fireforge.json');
  });

  it('throws a ConfigNotFoundError when fireforge.json is missing', async () => {
    mockPathExists.mockResolvedValueOnce(false);

    await expect(loadConfig('/project')).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('wraps non-ConfigError exceptions from readJson in a ConfigError', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockRejectedValueOnce(new TypeError('Unexpected token'));

    const err = await loadConfig('/project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('Invalid fireforge.json');
  });

  it('re-throws ConfigError subclasses without wrapping', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce('not-an-object');

    await expect(loadConfig('/project')).rejects.toBeInstanceOf(ConfigError);
  });

  it('stringifies non-Error throwables in loadConfig catch', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockRejectedValueOnce('raw string error');

    const err = await loadConfig('/project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('raw string error');
  });

  it('writes validated and raw config documents', async () => {
    await writeConfig('/project', makeValidConfig());
    await writeConfigDocument('/project', { custom: { enabled: true } });

    expect(mockWriteJson).toHaveBeenNthCalledWith(1, '/project/fireforge.json', makeValidConfig());
    expect(mockWriteJson).toHaveBeenNthCalledWith(2, '/project/fireforge.json', {
      custom: { enabled: true },
    });
  });

  it('mutates a valid config path and revalidates it by default', () => {
    expect(mutateConfig(makeValidConfig(), 'build.jobs', 32)).toEqual(
      makeValidConfig({ build: { jobs: 32 } })
    );
  });

  it('rejects invalid mutations unless skipValidation is enabled', () => {
    expect(() => mutateConfig(makeValidConfig(), 'build.jobs', 'many')).toThrow(ConfigError);

    expect(mutateConfig(makeValidConfig(), 'build.jobs', 'many', true)).toEqual({
      ...makeValidConfig(),
      build: { jobs: 'many' },
    });
  });

  it('loads an empty state when the state file is missing', async () => {
    mockPathExists.mockResolvedValueOnce(false);

    await expect(loadState('/project')).resolves.toEqual({});
  });

  it('loads and returns saved state data', async () => {
    const state: FireForgeState = { baseCommit: 'abc123', buildMode: 'release' };
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce(state);

    await expect(loadState('/project')).resolves.toEqual(state);
  });

  it('warns and resets when the state file is corrupted', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockRejectedValueOnce(new Error('bad json'));

    await expect(loadState('/project')).resolves.toEqual({});
    expect(mockQuarantineStateFile).toHaveBeenCalledWith('/project/.fireforge/state.json');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('could not be parsed: bad json'));
  });

  it('salvages valid fields from an invalid state file and rewrites the sanitized result', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce({
      baseCommit: 'abc123',
      buildMode: 123,
      pendingResolution: {
        patchFilename: 'broken.patch',
        originalError: 'failed',
      },
    });
    mockQuarantineStateFile.mockResolvedValueOnce('state.json.corrupt-2026-04-07T00-00-00-000Z');

    await expect(loadState('/project')).resolves.toEqual({
      baseCommit: 'abc123',
      pendingResolution: {
        patchFilename: 'broken.patch',
        originalError: 'failed',
      },
    });

    expect(mockWriteJson).toHaveBeenCalledWith('/project/.fireforge/state.json', {
      baseCommit: 'abc123',
      pendingResolution: {
        patchFilename: 'broken.patch',
        originalError: 'failed',
      },
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Recovered valid fields: baseCommit, pendingResolution.')
    );
  });

  it('saves state and merges incremental updates', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce({ baseCommit: 'abc123' });

    await saveState('/project', { baseCommit: 'def456' });
    await updateState('/project', { buildMode: 'debug' });

    expect(mockWriteJson).toHaveBeenNthCalledWith(1, '/project/.fireforge/state.json', {
      baseCommit: 'def456',
    });
    expect(mockWriteJson).toHaveBeenNthCalledWith(2, '/project/.fireforge/state.json', {
      baseCommit: 'abc123',
      buildMode: 'debug',
    });
  });

  it('supports transactional updater callbacks for nested state updates', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce({
      pendingResolution: {
        patchFilename: 'failed.patch',
        originalError: 'first failure',
      },
    });

    await updateState('/project', (current) => ({
      ...current,
      pendingResolution: {
        patchFilename: 'failed.patch',
        originalError: 'retry failed',
      },
    }));

    expect(mockWriteJson).toHaveBeenCalledWith('/project/.fireforge/state.json', {
      pendingResolution: {
        patchFilename: 'failed.patch',
        originalError: 'retry failed',
      },
    });
  });
});
