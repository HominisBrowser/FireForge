// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
  ensureDir: vi.fn(),
  copyFile: vi.fn(),
  removeDir: vi.fn(),
  removeFile: vi.fn(),
  FIREFORGE_TMP_PATH_PATTERN: /(^|\/)\.[^/]+\.fireforge-tmp-\d+-[0-9a-f-]{36}$/i,
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
  loadFurnaceConfig: vi.fn(),
  writeFurnaceConfig: vi.fn(),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
  updateFurnaceState: vi.fn(),
}));

vi.mock('../../core/furnace-constants.js', () => ({
  isComponentSourceFile: vi.fn(
    (name: string) => name.endsWith('.mjs') || name.endsWith('.css') || name.endsWith('.ftl')
  ),
  tagNameToClassName: vi.fn((tagName: string) =>
    tagName
      .split('-')
      .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')
  ),
  resolveFtlDir: vi.fn(() => 'toolkit/locales/en-US/toolkit/global'),
  resolveFtlChromeSubPath: vi.fn(() => 'toolkit/global'),
  resolveFtlLocaleJarMnPath: vi.fn(() => 'toolkit/locales/jar.mn'),
}));

vi.mock('../../core/furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (
      _root: string,
      _kind: string,
      body: (ctx: { registerJournal: () => void; registerCleanup: () => void }) => Promise<unknown>
    ) =>
      body({
        registerJournal: () => undefined,
        registerCleanup: () => undefined,
      })
  ),
  recordFurnaceRollbackFailure: vi.fn(),
}));

vi.mock('../../core/furnace-registration.js', () => ({
  addCustomElementRegistration: vi.fn(),
  addJarMnEntries: vi.fn(),
  addLocaleFtlJarMnEntry: vi.fn(() => Promise.resolve(1)),
  removeCustomElementRegistration: vi.fn(),
  removeJarMnEntries: vi.fn(),
  removeLocaleFtlJarMnEntry: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-registration-validate.js', () => ({
  CUSTOM_ELEMENT_TAG_PATTERN: /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/,
  CUSTOM_ELEMENT_TAG_RULES: 'Must contain a hyphen and start with a lowercase letter',
}));

vi.mock('../../core/furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(),
  snapshotDir: vi.fn(),
  snapshotFile: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { readdir } from 'node:fs/promises';

import {
  loadFurnaceConfig,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { recordFurnaceRollbackFailure } from '../../core/furnace-operation.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  addLocaleFtlJarMnEntry,
  removeCustomElementRegistration,
  removeJarMnEntries,
  removeLocaleFtlJarMnEntry,
} from '../../core/furnace-registration.js';
import { restoreRollbackJournalOrThrow, snapshotFile } from '../../core/furnace-rollback.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import {
  copyFile,
  ensureDir,
  pathExists,
  readText,
  removeDir,
  removeFile,
  writeText,
} from '../../utils/fs.js';
import { note } from '../../utils/logger.js';
import { furnaceRenameCommand } from '../furnace/rename.js';

const mockReaddir = vi.mocked(readdir);
const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);
const mockEnsureDir = vi.mocked(ensureDir);
const mockCopyFile = vi.mocked(copyFile);
const mockRemoveFile = vi.mocked(removeFile);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockWriteFurnaceConfig = vi.mocked(writeFurnaceConfig);
const mockUpdateFurnaceState = vi.mocked(updateFurnaceState);
const mockAddCustomElementRegistration = vi.mocked(addCustomElementRegistration);
const mockAddJarMnEntries = vi.mocked(addJarMnEntries);
const mockRemoveCustomElementRegistration = vi.mocked(removeCustomElementRegistration);
const mockRemoveJarMnEntries = vi.mocked(removeJarMnEntries);
const mockRestoreRollbackJournalOrThrow = vi.mocked(restoreRollbackJournalOrThrow);
const mockSnapshotFile = vi.mocked(snapshotFile);
const mockRecordFurnaceRollbackFailure = vi.mocked(recordFurnaceRollbackFailure);

function fakeEntry(name: string, isFile = true): import('node:fs').Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
  } as unknown as import('node:fs').Dirent;
}

function defaultCustomConfig(): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-sidebar': {
        description: 'A sidebar widget',
        targetPath: 'toolkit/content/widgets/moz-sidebar',
        register: true,
        localized: false,
      },
    },
  };
}

function defaultOverrideConfig(): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {
      'moz-sidebar': {
        type: 'css-only',
        description: 'Override sidebar',
        basePath: 'toolkit/content/widgets/moz-sidebar',
        baseVersion: '145.0',
      },
    },
    custom: {},
  };
}

function setupCustomPathExists(): void {
  mockPathExists.mockImplementation((path: string) => {
    if (path === '/project/engine') return Promise.resolve(true);
    if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
    if (path === '/project/components/custom/moz-nav') return Promise.resolve(false);
    if (path.includes('customElements.js')) return Promise.resolve(true);
    if (path.includes('jar.mn')) return Promise.resolve(true);
    return Promise.resolve(false);
  });
}

function setupDefaultReaddir(): void {
  mockReaddir.mockResolvedValue([
    fakeEntry('moz-sidebar.mjs'),
    fakeEntry('moz-sidebar.css'),
  ] as never);
}

function setupDefaultReadText(): void {
  mockReadText.mockImplementation((path: string) => {
    if (path.includes('moz-sidebar.mjs')) {
      return Promise.resolve(`class MozSidebar extends MozLitElement {
  connectedCallback() { super.connectedCallback(); }
}
customElements.define("moz-sidebar", MozSidebar);`);
    }
    if (path.includes('moz-sidebar.css')) {
      return Promise.resolve(`moz-sidebar { color: red; }`);
    }
    return Promise.resolve('');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadFurnaceConfig.mockResolvedValue(defaultCustomConfig());
  setupCustomPathExists();
  setupDefaultReaddir();
  setupDefaultReadText();
});

describe('furnaceRenameCommand validation', () => {
  it('throws InvalidArgumentError for invalid old name', async () => {
    await expect(furnaceRenameCommand('/project', 'NoHyphen', 'moz-nav')).rejects.toThrow(
      InvalidArgumentError
    );
  });

  it('throws InvalidArgumentError for invalid new name', async () => {
    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'NoHyphen')).rejects.toThrow(
      InvalidArgumentError
    );
  });

  it('throws InvalidArgumentError when old and new names are identical', async () => {
    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-sidebar')).rejects.toThrow(
      'Source and target names are identical'
    );
  });

  it('throws FurnaceError when component is not found in furnace.json', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).rejects.toThrow(
      'not found in furnace.json'
    );
  });

  it('throws FurnaceError when a component with the new name already exists', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'A sidebar widget',
          targetPath: 'toolkit/content/widgets/moz-sidebar',
          register: true,
          localized: false,
        },
        'moz-nav': {
          description: 'A nav widget',
          targetPath: 'toolkit/content/widgets/moz-nav',
          register: true,
          localized: false,
        },
      },
    });

    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).rejects.toThrow(
      'already exists in furnace.json'
    );
  });

  it('throws FurnaceError when old directory does not exist', async () => {
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    // Finding #8: the message used to read `components/customs/` (plural
    // `customs` built by appending `s` to the furnace-state key
    // `custom`). The directory label has to match the on-disk layout —
    // custom components live under `components/custom/` — so the
    // guidance names the real path.
    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).rejects.toThrow(
      /Component directory not found: components\/custom\/moz-sidebar/
    );
  });

  it('throws FurnaceError when new directory already exists', async () => {
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-nav') return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).rejects.toThrow(
      /Target directory already exists: components\/custom\/moz-nav/
    );
  });
});

describe('furnaceRenameCommand custom component rename', () => {
  it('renames a custom component directory and files', async () => {
    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockEnsureDir).toHaveBeenCalledWith('/project/components/custom/moz-nav');

    const writeTextPaths = mockWriteText.mock.calls.map((c) => c[0]);
    expect(writeTextPaths).toContain('/project/components/custom/moz-nav/moz-nav.mjs');
    expect(writeTextPaths).toContain('/project/components/custom/moz-nav/moz-nav.css');

    expect(mockWriteFurnaceConfig).toHaveBeenCalled();
    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.custom['moz-nav']).toBeDefined();
    expect(configArg?.custom['moz-sidebar']).toBeUndefined();
  });

  it('updates targetPath using path-segment-aware replacement', async () => {
    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.custom['moz-nav']?.targetPath).toBe('toolkit/content/widgets/moz-nav');
  });

  it('replaces tag name and class name in source files using word boundaries', async () => {
    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    const mjsCall = mockWriteText.mock.calls.find((c) => c[0].includes('moz-nav.mjs'));
    expect(mjsCall).toBeDefined();
    const mjsContent = mjsCall?.[1] ?? '';
    expect(mjsContent).toContain('moz-nav');
    expect(mjsContent).not.toContain('moz-sidebar');
    expect(mjsContent).toContain('MozNav');
    expect(mjsContent).not.toContain('MozSidebar');

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('moz-nav.css'));
    expect(cssCall).toBeDefined();
    const cssContent = cssCall?.[1] ?? '';
    expect(cssContent).toContain('moz-nav');
    expect(cssContent).not.toContain('moz-sidebar');
  });

  it('does not replace tag name as substring in other identifiers', async () => {
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('moz-panel.mjs')) {
        return Promise.resolve(`class MozPanel extends MozLitElement {}
customElements.define("moz-panel", MozPanel);
// also uses moz-panel-group`);
      }
      if (path.includes('moz-panel.css')) {
        return Promise.resolve(`moz-panel { color: red; }
moz-panel-group { display: flex; }`);
      }
      return Promise.resolve('');
    });

    mockReaddir.mockResolvedValue([
      fakeEntry('moz-panel.mjs'),
      fakeEntry('moz-panel.css'),
    ] as never);

    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-panel': {
          description: 'A panel widget',
          targetPath: 'toolkit/content/widgets/moz-panel',
          register: true,
          localized: false,
        },
      },
    });

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-panel') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-drawer') return Promise.resolve(false);
      if (path.includes('customElements.js')) return Promise.resolve(true);
      if (path.includes('jar.mn')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await furnaceRenameCommand('/project', 'moz-panel', 'moz-drawer');

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('moz-drawer.css'));
    expect(cssCall).toBeDefined();
    const cssContent = cssCall?.[1] ?? '';
    expect(cssContent).toContain('moz-drawer');
    expect(cssContent).toContain('moz-panel-group');
    expect(cssContent).not.toContain('moz-drawer-group');

    const mjsCall = mockWriteText.mock.calls.find((c) => c[0].includes('moz-drawer.mjs'));
    expect(mjsCall).toBeDefined();
    const mjsContent = mjsCall?.[1] ?? '';
    expect(mjsContent).toContain('moz-panel-group');
    expect(mjsContent).not.toContain('moz-drawer-group');
  });

  it('updates composes references in other custom components', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'A sidebar widget',
          targetPath: 'toolkit/content/widgets/moz-sidebar',
          register: true,
          localized: false,
        },
        'moz-layout': {
          description: 'A layout widget',
          targetPath: 'toolkit/content/widgets/moz-layout',
          register: true,
          localized: false,
          composes: ['moz-sidebar', 'moz-button'],
        },
      },
    });

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.custom['moz-layout']?.composes).toEqual(['moz-nav', 'moz-button']);
  });

  it('copies non-source files as-is without content replacement', async () => {
    mockReaddir.mockResolvedValue([
      fakeEntry('moz-sidebar.mjs'),
      fakeEntry('moz-sidebar.css'),
      fakeEntry('override.json'),
    ] as never);

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockCopyFile).toHaveBeenCalledWith(
      '/project/components/custom/moz-sidebar/override.json',
      '/project/components/custom/moz-nav/override.json'
    );
  });
});

describe('furnaceRenameCommand override component rename', () => {
  it('renames an override component', async () => {
    mockLoadFurnaceConfig.mockResolvedValue(defaultOverrideConfig());

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/overrides/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/overrides/moz-nav') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    mockReaddir.mockResolvedValue([fakeEntry('moz-sidebar.css')] as never);
    mockReadText.mockResolvedValue('moz-sidebar { color: blue; }');

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockEnsureDir).toHaveBeenCalledWith('/project/components/overrides/moz-nav');
    expect(mockWriteFurnaceConfig).toHaveBeenCalled();

    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.overrides['moz-nav']).toBeDefined();
    expect(configArg?.overrides['moz-sidebar']).toBeUndefined();
  });

  it('does not update engine registrations for overrides', async () => {
    mockLoadFurnaceConfig.mockResolvedValue(defaultOverrideConfig());

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/overrides/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/overrides/moz-nav') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    mockReaddir.mockResolvedValue([fakeEntry('moz-sidebar.css')] as never);
    mockReadText.mockResolvedValue('moz-sidebar { color: blue; }');

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockAddCustomElementRegistration).not.toHaveBeenCalled();
    expect(mockRemoveCustomElementRegistration).not.toHaveBeenCalled();
    expect(mockAddJarMnEntries).not.toHaveBeenCalled();
    expect(mockRemoveJarMnEntries).not.toHaveBeenCalled();
  });
});

describe('furnaceRenameCommand engine registrations', () => {
  it('updates customElements.js and jar.mn for registered custom component', async () => {
    mockReaddir.mockImplementation(((dir: string) => {
      if (dir.includes('moz-nav')) {
        return Promise.resolve([fakeEntry('moz-nav.mjs'), fakeEntry('moz-nav.css')]);
      }
      return Promise.resolve([fakeEntry('moz-sidebar.mjs'), fakeEntry('moz-sidebar.css')]);
    }) as unknown as typeof readdir);

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockRemoveCustomElementRegistration).toHaveBeenCalledWith(
      '/project/engine',
      'moz-sidebar'
    );
    expect(mockAddCustomElementRegistration).toHaveBeenCalledWith(
      '/project/engine',
      'moz-nav',
      'chrome://global/content/elements/moz-nav.mjs'
    );
    expect(mockRemoveJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-sidebar');
    expect(mockAddJarMnEntries).toHaveBeenCalledWith(
      '/project/engine',
      'moz-nav',
      expect.arrayContaining(['moz-nav.mjs', 'moz-nav.css'])
    );
  });

  it('renames FTL files in the engine locale directory', async () => {
    const ftlDir = 'toolkit/locales/en-US/toolkit/global';
    const oldFtlPath = `/project/engine/${ftlDir}/moz-sidebar.ftl`;
    const newFtlPath = `/project/engine/${ftlDir}/moz-nav.ftl`;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-nav') return Promise.resolve(false);
      if (path.includes('customElements.js')) return Promise.resolve(true);
      if (path.includes('jar.mn')) return Promise.resolve(true);
      if (path === oldFtlPath) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    mockReadText.mockImplementation((path: string) => {
      if (path.includes('moz-sidebar.mjs')) {
        return Promise.resolve('class MozSidebar extends MozLitElement {}');
      }
      if (path.includes('moz-sidebar.css')) {
        return Promise.resolve('moz-sidebar { color: red; }');
      }
      if (path === oldFtlPath) {
        return Promise.resolve('sidebar-title = Sidebar\nsidebar-close = Close sidebar');
      }
      return Promise.resolve('');
    });

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockSnapshotFile).toHaveBeenCalledWith(expect.anything(), oldFtlPath);

    const ftlWriteCall = mockWriteText.mock.calls.find((c) => c[0] === newFtlPath);
    expect(ftlWriteCall).toBeDefined();
    expect(ftlWriteCall?.[1]).toBe('sidebar-title = Sidebar\nsidebar-close = Close sidebar');

    expect(mockRemoveFile).toHaveBeenCalledWith(oldFtlPath);
  });

  it('rewires the locale jar.mn chrome registration on localized renames', async () => {
    // Eval 1 Finding #15: after `furnace rename` on a localized custom
    // component, the engine's `toolkit/locales/jar.mn` still carried the
    // old-name FTL registration while the deploy-side rename wrote the
    // new .ftl file. `furnace validate` passed regardless, hiding the
    // drift until a later packaging step tripped over the dead entry.
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Localized sidebar widget',
          targetPath: 'toolkit/content/widgets/moz-sidebar',
          register: true,
          localized: true,
        },
      },
    });
    const localeJarRel = 'toolkit/locales/jar.mn';
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-nav') return Promise.resolve(false);
      if (path.includes('customElements.js')) return Promise.resolve(true);
      if (path.endsWith('toolkit/content/jar.mn')) return Promise.resolve(true);
      if (path.endsWith(localeJarRel)) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(vi.mocked(removeLocaleFtlJarMnEntry)).toHaveBeenCalledWith(
      '/project/engine',
      localeJarRel,
      'moz-sidebar',
      'toolkit/global'
    );
    expect(vi.mocked(addLocaleFtlJarMnEntry)).toHaveBeenCalledWith(
      '/project/engine',
      localeJarRel,
      'moz-nav',
      'toolkit/global'
    );
  });

  it('leaves the locale jar.mn alone on non-localized renames', async () => {
    // Belt check against regressions that would fire the locale jar.mn
    // re-wire even when the component is not localized — which would
    // touch a file the apply pipeline never registered.
    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(vi.mocked(removeLocaleFtlJarMnEntry)).not.toHaveBeenCalled();
    expect(vi.mocked(addLocaleFtlJarMnEntry)).not.toHaveBeenCalled();
  });
});

describe('furnaceRenameCommand state management', () => {
  it('re-keys furnace-state.json checksums from old to new name', async () => {
    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    expect(mockUpdateFurnaceState).toHaveBeenCalledWith('/project', expect.any(Function));

    // Invoke the updater function to verify it re-keys correctly
    type StateShape = {
      appliedChecksums?: Record<string, string>;
      engineChecksums?: Record<string, string>;
    };
    const updater = mockUpdateFurnaceState.mock.calls[0]?.[1] as unknown as (
      state: StateShape
    ) => StateShape;
    expect(typeof updater).toBe('function');
    const result = updater({
      appliedChecksums: {
        'custom/moz-sidebar/moz-sidebar.mjs': 'abc123',
        'custom/moz-sidebar/moz-sidebar.css': 'def456',
        'custom/moz-other/moz-other.mjs': 'ghi789',
      },
      engineChecksums: {
        'custom/moz-sidebar/moz-sidebar.mjs': 'xyz',
      },
    });

    expect(result.appliedChecksums).toEqual({
      'custom/moz-nav/moz-sidebar.mjs': 'abc123',
      'custom/moz-nav/moz-sidebar.css': 'def456',
      'custom/moz-other/moz-other.mjs': 'ghi789',
    });
    expect(result.engineChecksums).toEqual({
      'custom/moz-nav/moz-sidebar.mjs': 'xyz',
    });
  });
});

describe('furnaceRenameCommand rollback', () => {
  it('rolls back on mutation failure', async () => {
    mockWriteText.mockRejectedValue(new Error('Disk full'));

    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).rejects.toThrow(
      'Disk full'
    );

    expect(mockRestoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any by design
      expect.objectContaining({ files: expect.any(Map) }),
      expect.stringContaining('Failed to rename component')
    );
  });

  it('records pending repair when rollback itself fails', async () => {
    mockWriteText.mockRejectedValue(new Error('Disk full'));
    mockRestoreRollbackJournalOrThrow.mockRejectedValue(new Error('Rollback failed'));

    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).rejects.toThrow(
      'Rollback failed'
    );

    expect(mockRecordFurnaceRollbackFailure).toHaveBeenCalledWith(
      '/project',
      'rename-rollback',
      'rename "moz-sidebar" → "moz-nav": Rollback failed'
    );
  });
});

describe('furnaceRenameCommand path-label messaging (Finding #8)', () => {
  beforeEach(() => {
    // The preceding rollback describe leaves `writeText` rejecting with
    // "Disk full" and (sometimes) `restoreRollbackJournalOrThrow`
    // rejecting too. vi.clearAllMocks() inside the top-level beforeEach
    // clears call history but does NOT reset mockRejectedValue
    // implementations, so we restore them explicitly here before each
    // of these tests runs. Without this, every path-label case trips
    // the rollback path and never reaches the note assertions.
    mockWriteText.mockResolvedValue(undefined);
    mockRestoreRollbackJournalOrThrow.mockResolvedValue(undefined);
  });

  it('renders the success note with the correct `components/custom/` directory label', async () => {
    // The note used to say `components/customs/moz-nav/` because the code
    // appended `s` to the furnace-state key `custom`. The real directory
    // is `components/custom/` (singular), so the guidance must use that.
    // This test pins the fix against a future refactor that might
    // re-introduce the pluralising logic.
    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    const noteCall = vi
      .mocked(note)
      .mock.calls.find(
        (call): call is [string, string] =>
          typeof call[0] === 'string' && call[0].includes('moz-sidebar → moz-nav')
      );
    expect(noteCall?.[0]).toContain('components/custom/moz-nav/');
    expect(noteCall?.[0]).not.toContain('components/customs/');
  });

  it('renders the success note with `components/overrides/` for override renames', async () => {
    // Overrides were always plural on disk (`components/overrides/`), so
    // the pre-fix code produced the correct `overrides` label by
    // coincidence. Pin that branch too so a unified singular/plural
    // helper can never swap them.
    mockLoadFurnaceConfig.mockResolvedValue(defaultOverrideConfig());
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/overrides/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/overrides/moz-nav') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    const noteCall = vi
      .mocked(note)
      .mock.calls.find(
        (call): call is [string, string] =>
          typeof call[0] === 'string' && call[0].includes('moz-sidebar → moz-nav')
      );
    expect(noteCall?.[0]).toContain('components/overrides/moz-nav/');
  });
});

describe('furnaceRenameCommand engine-tree cleanup (Finding #9)', () => {
  // 2026-04-21 eval reproduced two distinct bugs on a rename:
  //   - the deployed widget directory at `engine/<oldTargetPath>/`
  //     survived, so subsequent packaging could pick up both the old
  //     and new widget copies.
  //   - the mochikit scaffold at
  //     `engine/toolkit/content/tests/widgets/test_<old>.html` and its
  //     chrome.toml entry were untouched, so the generated test still
  //     imported and asserted against the old component name.
  // These tests pin the 0.16.0 behaviour: rename must clean both.

  beforeEach(() => {
    mockWriteText.mockResolvedValue(undefined);
    mockRestoreRollbackJournalOrThrow.mockResolvedValue(undefined);
    vi.mocked(removeDir).mockResolvedValue(undefined);
    mockRemoveFile.mockResolvedValue(undefined);
  });

  it('removes the deployed widget directory at the old targetPath', async () => {
    const oldDeployedDir = '/project/engine/toolkit/content/widgets/moz-sidebar';
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-nav') return Promise.resolve(false);
      if (path === oldDeployedDir) return Promise.resolve(true);
      if (path.includes('customElements.js')) return Promise.resolve(true);
      if (path.includes('jar.mn')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    // The old deployed directory must be removed so a subsequent
    // `furnace apply` is the single writer of the new name's
    // deployment.
    expect(vi.mocked(removeDir)).toHaveBeenCalledWith(oldDeployedDir);
  });

  it('renames the mochikit test file and updates chrome.toml', async () => {
    const mochikitDir = '/project/engine/toolkit/content/tests/widgets';
    const oldTestPath = `${mochikitDir}/test_moz-sidebar.html`;
    const newTestPath = `${mochikitDir}/test_moz-nav.html`;
    const chromeTomlPath = `${mochikitDir}/chrome.toml`;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-nav') return Promise.resolve(false);
      if (path === mochikitDir) return Promise.resolve(true);
      if (path === oldTestPath) return Promise.resolve(true);
      if (path === chromeTomlPath) return Promise.resolve(true);
      if (path.includes('customElements.js')) return Promise.resolve(true);
      if (path.includes('jar.mn')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    mockReadText.mockImplementation((path: string) => {
      if (path === oldTestPath) {
        return Promise.resolve(`<!DOCTYPE html>
<html>
  <head><title>Test the moz-sidebar custom element</title></head>
  <body>
    <script type="module">
      import "chrome://global/content/elements/moz-sidebar.mjs";
      add_task(async function test_moz_sidebar_defined() {
        const ctor = await customElements.whenDefined("moz-sidebar");
        ok(ctor, "moz-sidebar custom element should be defined");
      });
    </script>
  </body>
</html>`);
      }
      if (path === chromeTomlPath) {
        return Promise.resolve(`[DEFAULT]\n["test_moz-sidebar.html"]\n`);
      }
      if (path.includes('moz-sidebar.mjs')) {
        return Promise.resolve(`class MozSidebar extends MozLitElement {}`);
      }
      if (path.includes('moz-sidebar.css')) {
        return Promise.resolve(`moz-sidebar { color: red; }`);
      }
      return Promise.resolve('');
    });

    await furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav');

    // Old test file is snapshotted, new one is written, old one is removed.
    expect(mockSnapshotFile).toHaveBeenCalledWith(expect.anything(), oldTestPath);
    const writeCall = mockWriteText.mock.calls.find((c) => c[0] === newTestPath);
    expect(writeCall).toBeDefined();
    const writtenContent = writeCall?.[1] ?? '';
    expect(writtenContent).toContain('chrome://global/content/elements/moz-nav.mjs');
    expect(writtenContent).toContain('customElements.whenDefined("moz-nav")');
    expect(writtenContent).toContain('Test the moz-nav custom element');
    expect(writtenContent).toContain('test_moz_nav_defined');
    expect(writtenContent).not.toContain('moz-sidebar');
    expect(writtenContent).not.toContain('test_moz_sidebar_defined');
    expect(mockRemoveFile).toHaveBeenCalledWith(oldTestPath);

    // Chrome.toml entry is updated in place.
    const tomlWriteCall = mockWriteText.mock.calls.find((c) => c[0] === chromeTomlPath);
    expect(tomlWriteCall).toBeDefined();
    const tomlContent = tomlWriteCall?.[1] ?? '';
    expect(tomlContent).toContain('["test_moz-nav.html"]');
    expect(tomlContent).not.toContain('["test_moz-sidebar.html"]');
  });

  it('no-ops when the mochikit scaffold was never created', async () => {
    // Projects that used `furnace create --test-style=browser-chrome` or
    // `--test-style=none` don't have the mochikit files at all; rename
    // must not fail trying to clean something that was never there.
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-sidebar') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-nav') return Promise.resolve(false);
      if (path === '/project/engine/toolkit/content/tests/widgets') return Promise.resolve(false);
      if (path.includes('customElements.js')) return Promise.resolve(true);
      if (path.includes('jar.mn')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await expect(furnaceRenameCommand('/project', 'moz-sidebar', 'moz-nav')).resolves.not.toThrow();
  });
});
