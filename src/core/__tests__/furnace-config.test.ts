// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../state-file.js', () => ({
  withStateFileLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation()),
  quarantineStateFile: vi.fn(),
}));

import { FurnaceError } from '../../errors/furnace.js';
import { pathExists, readJson, writeJson } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import {
  clearAppliedFurnaceState,
  createDefaultFurnaceConfig,
  ensureFurnaceConfig,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
  saveFurnaceState,
  stampFurnaceOverrideBaseVersions,
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
      sharedDir: '/project/components/shared',
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

  it('round-trips sharedFtl through validation when localized is true', () => {
    const result = validateFurnaceConfig({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'mybrowser-dock-button': {
          description: 'Dock button',
          targetPath: 'toolkit/content/widgets/mybrowser-dock-button',
          register: true,
          localized: true,
          sharedFtl: 'browser/mybrowser-dock.ftl',
        },
      },
    });
    expect(result.custom['mybrowser-dock-button']?.sharedFtl).toBe('browser/mybrowser-dock.ftl');
  });

  it('rejects sharedFtl when localized is false', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'my-widget': {
            description: 'Widget',
            targetPath: 'toolkit/content/widgets/my-widget',
            register: true,
            localized: false,
            sharedFtl: 'browser/feature.ftl',
          },
        },
      })
    ).toThrow(/sharedFtl.*requires.*localized/);
  });

  it('rejects sharedFtl containing characters that would break the generated .mjs', () => {
    // Backtick, ${, and backslash would close the template literal or
    // introduce escaped sequences the generator does not expect.
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'my-widget': {
            description: 'Widget',
            targetPath: 'toolkit/content/widgets/my-widget',
            register: true,
            localized: true,
            sharedFtl: 'browser/`hack`.ftl',
          },
        },
      })
    ).toThrow(/backticks/);
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

  it('round-trips runtimeVariables through validation', () => {
    const result = validateFurnaceConfig({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--mybrowser-',
      runtimeVariables: ['--cam-x', '--tile-z'],
      stock: [],
      overrides: {},
      custom: {},
    });
    expect(result.runtimeVariables).toEqual(['--cam-x', '--tile-z']);
  });

  it('rejects runtimeVariables entries that do not start with "--"', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        runtimeVariables: ['cam-x'],
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow(/must start with "--"/);
  });

  it('accepts tokenHostDocuments and validates that entries stay within the engine tree', () => {
    expect(
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        tokenPrefix: '--mybrowser-',
        tokenHostDocuments: [
          'browser/base/content/browser.xhtml',
          'browser/base/content/mybrowser.xhtml',
        ],
        stock: [],
        overrides: {},
        custom: {},
      }).tokenHostDocuments
    ).toEqual(['browser/base/content/browser.xhtml', 'browser/base/content/mybrowser.xhtml']);

    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        tokenHostDocuments: ['../escape.xhtml'],
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow(/must stay within the engine tree/);

    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        tokenHostDocuments: [''],
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow(/non-empty strings/);
  });

  it('rejects stock entries that would escape the stories directory', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: ['../evil'],
        overrides: {},
        custom: {},
      })
    ).toThrow(/stock entry ".*" must match/);

    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: ['Moz-Button'],
        overrides: {},
        custom: {},
      })
    ).toThrow(FurnaceError);

    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: ['moz-button'],
        overrides: {},
        custom: {},
      })
    ).not.toThrow();
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

  it('preserves existing furnace.json ordering while appending new component entries', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      custom: {
        'moz-existing': {
          targetPath: 'toolkit/content/widgets/moz-existing',
          description: 'Existing',
          localized: false,
          register: true,
        },
      },
      stock: ['moz-button'],
      overrides: {},
      tokenPrefix: '--browser-',
    });

    await writeFurnaceConfig('/project', {
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--browser-',
      stock: ['moz-button'],
      overrides: {},
      custom: {
        'moz-existing': {
          description: 'Existing',
          targetPath: 'toolkit/content/widgets/moz-existing',
          register: true,
          localized: false,
        },
        'moz-new': {
          description: 'New',
          targetPath: 'toolkit/content/widgets/moz-new',
          register: true,
          localized: false,
        },
      },
    });

    const written = vi.mocked(writeJson).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      'version',
      'componentPrefix',
      'custom',
      'stock',
      'overrides',
      'tokenPrefix',
    ]);
    expect(Object.keys(written['custom'] as Record<string, unknown>)).toEqual([
      'moz-existing',
      'moz-new',
    ]);
    const existingComponent = (written['custom'] as Record<string, Record<string, unknown>>)[
      'moz-existing'
    ];
    expect(existingComponent).toBeDefined();
    expect(Object.keys(existingComponent ?? {})).toEqual([
      'targetPath',
      'description',
      'localized',
      'register',
    ]);
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
    ).toThrow('newer than what this version of FireForge supports');
  });

  it('rejects config with non-integer version', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 'one',
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      })
    ).toThrow('"version" must be a positive integer');
  });

  it('accepts a valid ftlBasePath', () => {
    const config = validateFurnaceConfig({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
      ftlBasePath: 'browser/locales/en-US/browser',
    });
    expect(config.ftlBasePath).toBe('browser/locales/en-US/browser');
  });

  it('rejects ftlBasePath with path traversal', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
        ftlBasePath: '../../etc',
      })
    ).toThrow('must not contain ".."');
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

  it('accepts kind: "library" on a register: false custom component', () => {
    const config = validateFurnaceConfig({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-shared-base': {
          description: 'Shared base class + helpers',
          targetPath: 'toolkit/content/widgets/moz-shared-base',
          register: false,
          localized: false,
          kind: 'library',
        },
      },
    });
    expect(config.custom['moz-shared-base']?.kind).toBe('library');
  });

  it('normalizes an explicit kind: "element" away (the default carries no field)', () => {
    const config = validateFurnaceConfig({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-panel': {
          description: 'a',
          targetPath: 'toolkit/content/widgets/moz-panel',
          register: true,
          localized: false,
          kind: 'element',
        },
      },
    });
    expect(config.custom['moz-panel']?.kind).toBeUndefined();
  });

  it('rejects an unknown kind value', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-panel': {
            description: 'a',
            targetPath: 'toolkit/content/widgets/moz-panel',
            register: true,
            localized: false,
            kind: 'widget',
          },
        },
      })
    ).toThrow('must be "element" or "library"');
  });

  it('rejects kind: "library" combined with register: true', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-shared-base': {
            description: 'Shared base class + helpers',
            targetPath: 'toolkit/content/widgets/moz-shared-base',
            register: true,
            localized: false,
            kind: 'library',
          },
        },
      })
    ).toThrow('set register: false');
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

  it('rejects circular composes dependencies between custom components', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-a': {
            description: 'A',
            targetPath: 'browser/a',
            register: false,
            localized: false,
            composes: ['moz-b'],
          },
          'moz-b': {
            description: 'B',
            targetPath: 'browser/b',
            register: false,
            localized: false,
            composes: ['moz-a'],
          },
        },
      })
    ).toThrow(/circular composes dependency.*moz-a → moz-b → moz-a/);
  });

  it('rejects self-referencing composes dependency', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-loop': {
            description: 'Loop',
            targetPath: 'browser/loop',
            register: false,
            localized: false,
            composes: ['moz-loop'],
          },
        },
      })
    ).toThrow(/circular composes dependency.*moz-loop → moz-loop/);
  });

  it('allows composes references to stock or override components without cycles', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: ['moz-button'],
        overrides: {},
        custom: {
          'moz-panel': {
            description: 'Panel',
            targetPath: 'browser/panel',
            register: false,
            localized: false,
            composes: ['moz-button'],
          },
        },
      })
    ).not.toThrow();
  });

  it('detects cycles in longer composes chains (A→B→C→A)', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-a': {
            description: 'A',
            targetPath: 'browser/a',
            register: false,
            localized: false,
            composes: ['moz-b'],
          },
          'moz-b': {
            description: 'B',
            targetPath: 'browser/b',
            register: false,
            localized: false,
            composes: ['moz-c'],
          },
          'moz-c': {
            description: 'C',
            targetPath: 'browser/c',
            register: false,
            localized: false,
            composes: ['moz-a'],
          },
        },
      })
    ).toThrow(/circular composes dependency/);
  });

  it('rejects composes references to unknown components', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-panel': {
            description: 'Panel',
            targetPath: 'browser/panel',
            register: false,
            localized: false,
            composes: ['moz-nonexistent'],
          },
        },
      })
    ).toThrow(/composes unknown component "moz-nonexistent"/);
  });

  it('accepts composes references to override components', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-button': {
            type: 'css-only',
            description: 'Button override',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '130.0',
          },
        },
        custom: {
          'moz-panel': {
            description: 'Panel',
            targetPath: 'browser/panel',
            register: false,
            localized: false,
            composes: ['moz-button'],
          },
        },
      })
    ).not.toThrow();
  });

  it('rejects composes when one ref is known and another is not', () => {
    expect(() =>
      validateFurnaceConfig({
        version: 1,
        componentPrefix: 'moz-',
        stock: ['moz-button'],
        overrides: {},
        custom: {
          'moz-panel': {
            description: 'Panel',
            targetPath: 'browser/panel',
            register: false,
            localized: false,
            composes: ['moz-button', 'moz-ghost'],
          },
        },
      })
    ).toThrow(/composes unknown component "moz-ghost"/);
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

  it('parses a well-formed pendingRepair marker into the state', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      pendingRepair: {
        operation: 'preview-teardown',
        timestamp: '2026-04-11T12:00:00.000Z',
        reason: 'cleanStories failed with EACCES',
      },
    });

    const state = await loadFurnaceState('/project');
    expect(state.pendingRepair).toEqual({
      operation: 'preview-teardown',
      timestamp: '2026-04-11T12:00:00.000Z',
      reason: 'cleanStories failed with EACCES',
    });
  });

  it('quarantines state with an unknown pendingRepair.operation value', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      pendingRepair: {
        operation: 'made-up-operation',
        timestamp: '2026-04-11T12:00:00.000Z',
        reason: 'nope',
      },
    });
    mockQuarantineStateFile.mockResolvedValueOnce('furnace-state.json.invalid-x');

    const state = await loadFurnaceState('/project');
    // The marker is dropped but no other valid fields were present, so
    // state is empty. Parsing issues are reported via the warn path.
    expect(state.pendingRepair).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pendingRepair.operation'));
  });

  it('quarantines state when pendingRepair is missing required fields', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      pendingRepair: {
        operation: 'preview-teardown',
        // timestamp and reason missing
      },
    });
    mockQuarantineStateFile.mockResolvedValueOnce('furnace-state.json.invalid-y');

    const state = await loadFurnaceState('/project');
    expect(state.pendingRepair).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pendingRepair.timestamp'));
  });
});

describe('stampFurnaceOverrideBaseVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithStateFileLock.mockImplementation(async (_path, operation) => operation());
  });

  it('returns 0 when no furnace.json is present', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);
    await expect(stampFurnaceOverrideBaseVersions('/project', '140.9.1esr')).resolves.toBe(0);
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('returns 0 and does not rewrite the file when every override already matches the version', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'full',
          description: '',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '140.9.1esr',
        },
      },
      custom: {},
    });

    const changed = await stampFurnaceOverrideBaseVersions('/project', '140.9.1esr');
    expect(changed).toBe(0);
    expect(writeJson).not.toHaveBeenCalled();
  });

  it('stamps every override whose baseVersion differs from the target version', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readJson).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'full',
          description: '',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '140.9.0esr',
        },
        'moz-button': {
          type: 'css-only',
          description: '',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.9.1esr',
        },
      },
      custom: {},
    });

    const changed = await stampFurnaceOverrideBaseVersions('/project', '140.9.1esr');
    expect(changed).toBe(1); // only moz-card moved

    expect(writeJson).toHaveBeenCalledTimes(1);
    const [, writtenConfig] = vi.mocked(writeJson).mock.calls[0] as [
      string,
      { overrides: Record<string, { baseVersion: string }> },
    ];
    expect(writtenConfig.overrides['moz-card']?.baseVersion).toBe('140.9.1esr');
    expect(writtenConfig.overrides['moz-button']?.baseVersion).toBe('140.9.1esr');
  });
});

describe('clearAppliedFurnaceState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears everything except pendingRepair (shared contract for download/reset/rebase/abort)', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readJson).mockResolvedValue({
      lastApply: '2026-04-12T00:00:00.000Z',
      appliedChecksums: { 'custom/foo/foo.mjs': 'abc' },
      engineChecksums: { 'custom/foo/foo.mjs': 'abc' },
      pendingRepair: {
        operation: 'create-rollback',
        timestamp: '2026-04-12T01:02:03.000Z',
        reason: 'authoring change incomplete',
      },
    });

    await clearAppliedFurnaceState('/project');

    expect(writeJson).toHaveBeenCalledWith(expect.stringContaining('furnace-state.json'), {
      pendingRepair: {
        operation: 'create-rollback',
        timestamp: '2026-04-12T01:02:03.000Z',
        reason: 'authoring change incomplete',
      },
    });
  });

  it('clears to an empty object when no pendingRepair exists', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readJson).mockResolvedValue({
      appliedChecksums: { 'override/x/x.css': 'abc' },
    });

    await clearAppliedFurnaceState('/project');

    expect(writeJson).toHaveBeenCalledWith(expect.stringContaining('furnace-state.json'), {});
  });

  it('no-ops when the state file does not exist', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await clearAppliedFurnaceState('/project');

    expect(writeJson).not.toHaveBeenCalled();
  });
});
