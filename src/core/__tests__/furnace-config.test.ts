// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../state-file.js', () => ({
  withStateFileLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation()),
  quarantineStateFile: vi.fn(),
}));

import { FurnaceError } from '../../errors/furnace.js';
import { pathExists, readJson, writeJson } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import {
  createDefaultFurnaceConfig,
  ensureFurnaceConfig,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
  saveFurnaceState,
  updateFurnaceState,
  validateFurnaceConfig,
  writeFurnaceConfig,
} from '../furnace-config.js';
import { quarantineStateFile, withStateFileLock } from '../state-file.js';

const mockWithStateFileLock = vi.mocked(withStateFileLock);
const mockQuarantineStateFile = vi.mocked(quarantineStateFile);

describe('furnace-config helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithStateFileLock.mockImplementation(async (_path, operation) => operation());
    mockQuarantineStateFile.mockResolvedValue(undefined);
  });

  it('builds the expected furnace-related paths', () => {
    expect(getFurnacePaths('/project')).toEqual({
      furnaceConfig: '/project/furnace.json',
      componentsDir: '/project/components',
      overridesDir: '/project/components/overrides',
      customDir: '/project/components/custom',
      furnaceState: '/project/.fireforge/furnace-state.json',
    });
  });

  it('validates a complete config with optional token and compose fields', () => {
    expect(
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        tokenPrefix: '--mybrowser-',
        tokenAllowlist: ['--in-content-page-color'],
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
          'moz-panel': {
            description: 'Custom panel',
            targetPath: 'browser/components/panel',
            register: true,
            localized: false,
            composes: ['moz-button'],
          },
        },
      })
    ).toEqual({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--mybrowser-',
      tokenAllowlist: ['--in-content-page-color'],
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
        'moz-panel': {
          description: 'Custom panel',
          targetPath: 'browser/components/panel',
          register: true,
          localized: false,
          composes: ['moz-button'],
        },
      },
    });
  });

  it('rejects invalid traversal and malformed arrays during validation', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'Override card',
            basePath: '../escape',
            baseVersion: '145.0',
          },
        },
        custom: {},
      })
    ).toThrow(FurnaceError);

    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        tokenAllowlist: ['--ok', 123],
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow('array must contain only strings');
  });

  it('checks whether furnace.json exists', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(furnaceConfigExists('/project')).resolves.toBe(true);
    expect(pathExists).toHaveBeenCalledWith('/project/furnace.json');
  });

  it('loads and validates furnace.json', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readJson).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await expect(loadFurnaceConfig('/project')).resolves.toEqual({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
    expect(readJson).toHaveBeenCalledWith('/project/furnace.json');
  });

  it('throws a helpful error when furnace.json is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(loadFurnaceConfig('/project')).rejects.toThrow(FurnaceError);
    await expect(loadFurnaceConfig('/project')).rejects.toThrow('Run "fireforge furnace create"');
  });

  it('creates and writes a default config when none exists', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(ensureFurnaceConfig('/project')).resolves.toEqual(createDefaultFurnaceConfig());
    expect(writeJson).toHaveBeenCalledWith('/project/furnace.json', createDefaultFurnaceConfig());
  });

  it('returns the existing config without rewriting when furnace.json already exists', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readJson).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    });

    await expect(ensureFurnaceConfig('/project')).resolves.toEqual({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    });
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('returns empty state when furnace-state.json is missing or unreadable', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockRejectedValueOnce(new Error('bad json'));

    await expect(loadFurnaceState('/project')).resolves.toEqual({});
    await expect(loadFurnaceState('/project')).resolves.toEqual({});
    expect(mockQuarantineStateFile).toHaveBeenCalledWith(
      '/project/.fireforge/furnace-state.json',
      'invalid'
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be parsed: bad json'));
  });

  it('writes furnace config and state to the expected files', async () => {
    const config = createDefaultFurnaceConfig();
    const state = { lastApply: '2026-04-07T00:00:00.000Z' };

    await writeFurnaceConfig('/project', config);
    await saveFurnaceState('/project', state);

    expect(writeJson).toHaveBeenNthCalledWith(1, '/project/furnace.json', config);
    expect(writeJson).toHaveBeenNthCalledWith(2, '/project/.fireforge/furnace-state.json', state);
  });

  it('supports transactional furnace state updaters for nested checksum maps', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      appliedChecksums: {
        'components/old.css': 'hash-a',
      },
    });

    await updateFurnaceState('/project', (current) => ({
      ...current,
      appliedChecksums: {
        ...(current.appliedChecksums ?? {}),
        'components/new.css': 'hash-b',
      },
    }));

    expect(writeJson).toHaveBeenCalledWith('/project/.fireforge/furnace-state.json', {
      appliedChecksums: {
        'components/old.css': 'hash-a',
        'components/new.css': 'hash-b',
      },
    });
  });

  it('rejects config with invalid version', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 2,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow('"version" must be 1');
  });

  it('rejects config with non-string componentPrefix', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 42,
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow('"componentPrefix" must be a string');
  });

  it('rejects config when overrides is not an object', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: 'invalid',
        custom: {},
      })
    ).toThrow('"overrides" must be an object');
  });

  it('rejects config when custom is not an object', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: 'invalid',
      })
    ).toThrow('"custom" must be an object');
  });

  it('rejects invalid override entry names', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'Not-Valid': { type: 'css-only', description: 'a', basePath: 'x', baseVersion: '1' },
        },
        custom: {},
      })
    ).toThrow('must match');
  });

  it('rejects override with non-object entry value', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: { 'moz-card': 'not-an-object' },
        custom: {},
      })
    ).toThrow('must be an object');
  });

  it('rejects override with invalid type', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': { type: 'invalid', description: 'a', basePath: 'x', baseVersion: '1' },
        },
        custom: {},
      })
    ).toThrow('must be one of');
  });

  it('rejects custom with invalid fields', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-panel': { description: 123, targetPath: 'x', register: true, localized: false },
        },
      })
    ).toThrow('description');

    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-panel': {
            description: 'a',
            targetPath: '../escape',
            register: true,
            localized: false,
          },
        },
      })
    ).toThrow('path traversal');
  });

  it('rejects non-string tokenPrefix', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        tokenPrefix: 42,
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow('tokenPrefix');
  });

  it('wraps non-FurnaceError from readJson in a FurnaceError', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockRejectedValueOnce(new TypeError('bad JSON'));

    const err = await loadFurnaceConfig('/project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FurnaceError);
    expect((err as FurnaceError).message).toContain('Invalid furnace.json');
  });

  it('recovers valid state fields with quarantine when state has issues', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      lastApply: '2026-04-07T00:00:00.000Z',
      appliedChecksums: 'invalid',
    });
    mockQuarantineStateFile.mockResolvedValueOnce('furnace-state.json.invalid-2026-04-07');

    const state = await loadFurnaceState('/project');
    expect(state.lastApply).toBe('2026-04-07T00:00:00.000Z');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Recovered valid field'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined'));
  });

  it('recovers with defaults when no valid fields exist in state', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      lastApply: 42,
      appliedChecksums: 'bad',
    });
    mockQuarantineStateFile.mockResolvedValueOnce(undefined);

    const state = await loadFurnaceState('/project');
    expect(state).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No valid furnace state fields'));
  });

  it('handles appliedChecksums with mixed valid and invalid entries', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      appliedChecksums: {
        'valid.css': 'hash-ok',
        'invalid.css': 42,
      },
    });
    mockQuarantineStateFile.mockResolvedValueOnce('quarantined');

    const state = await loadFurnaceState('/project');
    expect(state.appliedChecksums?.['valid.css']).toBe('hash-ok');
  });
});
