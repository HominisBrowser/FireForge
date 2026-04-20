// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import { furnaceCreateCommand } from '../furnace/create.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  multiselect: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn(),
  ensureDir: vi.fn(),
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
  loadConfig: vi.fn(() => ({
    name: 'TestBrowser',
    vendor: 'Test',
    appId: 'org.test.browser',
    binaryName: 'testbrowser',
    firefox: { version: '140.9.0', product: 'firefox' },
    license: 'EUPL-1.2',
  })),
}));

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  detectComposesCycles: vi.fn(),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    })
  ),
  createDefaultFurnaceConfig: vi.fn(() => ({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  })),
  writeFurnaceConfig: vi.fn(),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
}));

// The rollback journal touches the filesystem directly via node:fs/promises.
// These tests mock those filesystem helpers, so stub the journal here to keep
// the unit tests focused on the command's own logic. End-to-end rollback
// behavior is covered by furnace-authoring-rollback.integration.test.ts.
vi.mock('../../core/furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  recordCreatedDir: vi.fn(),
  snapshotFile: vi.fn(),
  snapshotDir: vi.fn(),
  restoreRollbackJournalOrThrow: vi.fn(),
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

vi.mock('../../core/furnace-scanner.js', () => ({
  isComponentInEngine: vi.fn(() => false),
}));

vi.mock('../../core/manifest-register.js', () => ({
  registerTestManifest: vi.fn(() => ({
    manifest: 'browser/base/moz.build',
    entry: '    "content/test/moz-test-widget/browser.toml",',
    skipped: false,
  })),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  warn: vi.fn(),
  note: vi.fn(),
  success: vi.fn(),
}));

import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { isComponentInEngine } from '../../core/furnace-scanner.js';
import { registerTestManifest } from '../../core/manifest-register.js';
import { ensureDir, pathExists, readText, writeText } from '../../utils/fs.js';
import { success, warn } from '../../utils/logger.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);
const mockEnsureDir = vi.mocked(ensureDir);
const mockRegisterTestManifest = vi.mocked(registerTestManifest);
const mockWriteFurnaceConfig = vi.mocked(writeFurnaceConfig);
const mockFurnaceConfigExists = vi.mocked(furnaceConfigExists);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockIsComponentInEngine = vi.mocked(isComponentInEngine);
const mockSuccess = vi.mocked(success);
const mockWarn = vi.mocked(warn);

beforeEach(() => {
  vi.clearAllMocks();
  mockFurnaceConfigExists.mockResolvedValue(false);
  mockLoadFurnaceConfig.mockResolvedValue({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  });
  mockReadText.mockResolvedValue('');
  // Simulate: engine exists, component dir doesn't exist yet
  mockPathExists.mockImplementation((path: string) => {
    if (path === '/project/engine') return Promise.resolve(true);
    if (path.includes('components/custom/moz-test-widget')) return Promise.resolve(false);
    return Promise.resolve(false);
  });
});

describe('furnaceCreateCommand --with-tests', () => {
  it('scaffolds test files when --with-tests is set', async () => {
    // Suppress stdin.isTTY to use non-interactive mode
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
        withTests: true,
        testStyle: 'browser-chrome',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // Check that test directory was created using binaryName from fireforge.json
    const ensureDirCalls = mockEnsureDir.mock.calls.map((c) => c[0]);
    const testDirCall = ensureDirCalls.find((p: string) => p.includes('content/test/testbrowser'));
    expect(testDirCall).toBeDefined();

    // Check that test files were written
    const writeTextCalls = mockWriteText.mock.calls.map((c) => c[0]);

    const browserToml = writeTextCalls.find((p: string) => p.includes('browser.toml'));
    expect(browserToml).toBeDefined();

    const headJs = writeTextCalls.find((p: string) => p.includes('head.js'));
    expect(headJs).toBeDefined();

    // moz- prefix stripped: moz-test-widget → test_widget → browser_testbrowser_test_widget.js
    const testFile = writeTextCalls.find((p: string) =>
      p.includes('browser_testbrowser_test_widget.js')
    );
    expect(testFile).toBeDefined();

    // Check browser.toml content
    const tomlCall = mockWriteText.mock.calls.find((c) => c[0].includes('browser.toml'));
    expect(tomlCall).toBeDefined();
    const tomlContent = tomlCall?.[1] ?? '';
    expect(tomlContent).toContain('[DEFAULT]');
    expect(tomlContent).toContain('support-files = ["head.js"]');
    expect(tomlContent).toContain('browser_testbrowser_test_widget.js');

    // Check test file content
    const testCall = mockWriteText.mock.calls.find((c) =>
      c[0].includes('browser_testbrowser_test_widget.js')
    );
    expect(testCall).toBeDefined();
    const testContent = testCall?.[1] ?? '';
    expect(testContent).toContain('test_test_widget_defined');
    expect(testContent).toContain('waitForElement("moz-test-widget")');

    // Check that moz.build registration was called with binaryName
    expect(mockRegisterTestManifest).toHaveBeenCalledWith('/project/engine', 'testbrowser');
  });

  it('avoids double-prefixed test filename when component name contains binaryName', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    // Override pathExists to allow the new component name
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path.includes('components/custom/moz-testbrowser-foo')) return Promise.resolve(false);
      return Promise.resolve(false);
    });

    try {
      await furnaceCreateCommand('/project', 'moz-testbrowser-foo', {
        description: 'A foo widget',
        withTests: true,
        testStyle: 'browser-chrome',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    const writeTextCalls = mockWriteText.mock.calls.map((c) => c[0]);

    // moz-testbrowser-foo → strip "moz-" → "testbrowser-foo"
    // binaryName is "testbrowser", so strip "testbrowser-" → "foo"
    // Result: browser_testbrowser_foo.js (NOT browser_testbrowser_testbrowser_foo.js)
    const testFile = writeTextCalls.find((p: string) => p.includes('browser_testbrowser_foo.js'));
    expect(testFile).toBeDefined();

    // Ensure the double-prefixed version does NOT exist
    const doublePrefix = writeTextCalls.find((p: string) =>
      p.includes('browser_testbrowser_testbrowser_foo.js')
    );
    expect(doublePrefix).toBeUndefined();
  });

  it('throws when --with-tests is set and the engine directory does not exist', async () => {
    // Regression guard: previously the command would unconditionally
    // ensureDir under engine/browser/base/content/test/..., fabricating a
    // partial engine tree. It now refuses.
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-test-widget', {
          description: 'A test widget',
          withTests: true,
          testStyle: 'browser-chrome',
        })
      ).rejects.toThrow(/Engine directory not found/i);
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // Crucially, nothing under engine/ should have been created.
    const ensureDirCalls = mockEnsureDir.mock.calls.map((c) => c[0]);
    expect(ensureDirCalls.find((p: string) => p.includes('content/test'))).toBeUndefined();
    expect(mockRegisterTestManifest).not.toHaveBeenCalled();
  });

  it('allows create without --with-tests when the engine directory is missing', async () => {
    // Regression guard for the offline workflow: scaffolding components
    // without running download must still work, so long as --with-tests is
    // not requested.
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // Config should still be written for the component
    expect(mockWriteFurnaceConfig).toHaveBeenCalled();
    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.custom['moz-test-widget']).toBeDefined();
    // But no engine-side scaffolding
    expect(mockRegisterTestManifest).not.toHaveBeenCalled();
  });

  it('does not scaffold test files when --with-tests is not set', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // No test directory created
    const ensureDirCalls = mockEnsureDir.mock.calls.map((c) => c[0]);
    const testDirCall = ensureDirCalls.find((p: string) => p.includes('content/test'));
    expect(testDirCall).toBeUndefined();

    // moz.build registration not called
    expect(mockRegisterTestManifest).not.toHaveBeenCalled();
  });

  it('reuses existing browser.toml and head.js without duplicating entries', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path.includes('components/custom/moz-test-widget')) return Promise.resolve(false);
      if (path.endsWith('/browser/base/content/test/testbrowser/browser.toml')) {
        return Promise.resolve(true);
      }
      if (path.endsWith('/browser/base/content/test/testbrowser/head.js')) {
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });
    mockReadText.mockResolvedValue('["browser_testbrowser_test_widget.js"]\n');
    mockRegisterTestManifest.mockResolvedValueOnce({
      manifest: 'browser/base/moz.build',
      entry: '    "content/test/moz-test-widget/browser.toml",',
      skipped: true,
    });

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
        withTests: true,
        testStyle: 'browser-chrome',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(mockWriteText.mock.calls.some(([path]) => path.includes('browser.toml'))).toBe(false);
    expect(mockWriteText.mock.calls.some(([path]) => path.includes('head.js'))).toBe(false);
    expect(
      mockWriteText.mock.calls.some(([path]) => path.includes('browser_testbrowser_test_widget.js'))
    ).toBe(true);
    expect(mockSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining('Registered test manifest')
    );
  });

  it('stores composes array in furnace.json when --compose is provided', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    // The compose targets must be known components for validation to pass.
    vi.mocked(createDefaultFurnaceConfig).mockReturnValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button', 'moz-toggle'],
      overrides: {},
      custom: {},
    });

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
        compose: ['moz-button', 'moz-toggle'],
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // Check that writeFurnaceConfig was called with the composes array
    expect(mockWriteFurnaceConfig).toHaveBeenCalled();
    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    const customEntry = configArg?.custom['moz-test-widget'];
    expect(customEntry).toBeDefined();
    expect(customEntry?.composes).toEqual(['moz-button', 'moz-toggle']);
  });

  it('does not include composes field when --compose is not provided', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    const customEntry = configArg?.custom['moz-test-widget'];
    expect(customEntry).toBeDefined();
    expect(customEntry?.composes).toBeUndefined();
  });
});

describe('furnaceCreateCommand --xpcshell', () => {
  it('scaffolds an xpcshell test harness when --xpcshell is set', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await furnaceCreateCommand('/project', 'moz-storage-widget', {
        description: 'A storage widget',
        xpcshell: true,
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    const writeTextCalls = mockWriteText.mock.calls.map((c) => c[0]);

    // xpcshell harness lives under <binary>-xpcshell/<component>/ so it does
    // not mix with browser-chrome tests.
    const xpcshellDir = mockEnsureDir.mock.calls
      .map((c) => c[0])
      .find((p: string) => p.includes('testbrowser-xpcshell/moz-storage-widget'));
    expect(xpcshellDir).toBeDefined();

    const manifest = writeTextCalls.find(
      (p: string) => p.endsWith('xpcshell.toml') && p.includes('moz-storage-widget')
    );
    expect(manifest).toBeDefined();

    const testFile = writeTextCalls.find((p: string) =>
      p.includes('test_moz_storage_widget_module_loads.js')
    );
    expect(testFile).toBeDefined();

    const testCall = mockWriteText.mock.calls.find((c) =>
      c[0].includes('test_moz_storage_widget_module_loads.js')
    );
    const testContent = testCall?.[1] ?? '';
    expect(testContent).toContain('ChromeUtils.importESModule');
    expect(testContent).toContain('chrome://global/content/elements/moz-storage-widget.mjs');

    // xpcshell does not go through registerTestManifest (moz.build wiring is
    // left to the operator — see function docstring).
    expect(mockRegisterTestManifest).not.toHaveBeenCalled();
  });

  it('throws when --xpcshell is set and the engine directory does not exist', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(false);
      return Promise.resolve(false);
    });

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-storage-widget', {
          description: 'A storage widget',
          xpcshell: true,
        })
      ).rejects.toThrow(/Engine directory not found/i);
    } finally {
      process.stdin.isTTY = origTTY;
    }

    const ensureDirCalls = mockEnsureDir.mock.calls.map((c) => c[0]);
    expect(ensureDirCalls.find((p: string) => p.includes('testbrowser-xpcshell'))).toBeUndefined();
  });
});

describe('furnaceCreateCommand validation', () => {
  it('rejects an invalid tag name', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(
        furnaceCreateCommand('/project', 'NoHyphen', { description: 'Bad name' })
      ).rejects.toThrow(InvalidArgumentError);
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('rejects names that do not contain a hyphen', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(
        furnaceCreateCommand('/project', 'widget', { description: 'Bad name' })
      ).rejects.toThrow('Custom element names must contain a hyphen');
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('rejects when component name conflicts with existing entry', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockFurnaceConfigExists.mockResolvedValueOnce(true);
    mockLoadFurnaceConfig.mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-test-widget': {
          description: 'exists',
          targetPath: 'x',
          register: true,
          localized: false,
        },
      },
    });

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-test-widget', { description: 'Dupe' })
      ).rejects.toThrow(FurnaceError);
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('rejects when component name conflicts with an existing override entry', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockFurnaceConfigExists.mockResolvedValueOnce(true);
    mockLoadFurnaceConfig.mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-test-widget': {
          type: 'css-only',
          description: 'Existing override',
          basePath: 'toolkit/content/widgets/moz-test-widget',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-test-widget', { description: 'Dupe' })
      ).rejects.toThrow('An override component named "moz-test-widget" already exists');
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('rejects when component exists in the engine source tree', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockIsComponentInEngine.mockResolvedValueOnce(true);

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-test-widget', { description: 'Existing' })
      ).rejects.toThrow('already exists in the engine source tree');
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('throws when name is missing in non-interactive mode', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(
        furnaceCreateCommand('/project', undefined, { description: 'No name' })
      ).rejects.toThrow(InvalidArgumentError);
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('rejects when component directory already exists on disk', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      if (path === '/project/components/custom/moz-test-widget') return Promise.resolve(true);
      return Promise.resolve(false);
    });

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-test-widget', { description: 'Conflict' })
      ).rejects.toThrow('Directory already exists');
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });

  it('refuses when name does not match componentPrefix (post-0.16.0 hard refusal)', async () => {
    // Pre-0.16.0 this was a warn + continue, which could land a
    // partially-scaffolded component that follow-up commands (list,
    // rename, status) then failed to recognise. The post-0.16.0
    // contract is an up-front `InvalidArgumentError` that leaves the
    // workspace untouched. `--allow-prefix-mismatch` is the escape
    // hatch for intentional mismatches.
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(
        furnaceCreateCommand('/project', 'custom-widget', { description: 'No prefix' })
      ).rejects.toThrow(/does not start with the configured prefix/);
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // The scaffold must not have started. `writeFurnaceConfig` would
    // fire only if the mutation phase reached its mid-flight config
    // write, so asserting zero calls confirms the refusal is truly
    // pre-write.
    expect(mockWriteFurnaceConfig).not.toHaveBeenCalled();
  });

  it('allows a prefix-mismatched name when --allow-prefix-mismatch is set', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await furnaceCreateCommand('/project', 'custom-widget', {
        description: 'No prefix (override)',
        allowPrefixMismatch: true,
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    // The mutation phase ran — config was written with the new entry.
    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.custom['custom-widget']).toBeDefined();
  });

  it('generates localized files when --localized is set', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'Localized widget',
        localized: true,
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    const writeTextCalls = mockWriteText.mock.calls.map((c) => c[0]);
    const ftlFile = writeTextCalls.find((p: string) => p.endsWith('.ftl'));
    expect(ftlFile).toBeDefined();

    const configArg = mockWriteFurnaceConfig.mock.calls[0]?.[1];
    expect(configArg?.custom['moz-test-widget']?.localized).toBe(true);

    // The generated .mjs must use the MozLitElement-compatible l10n pattern:
    // a module-level `window.MozXULElement?.insertFTLIfNeeded(...)` call and
    // `connectRoot(this.shadowRoot)` in connectedCallback. The old (broken)
    // template called `this.insertFTLIfNeeded(...)` on MozLitElement, which
    // threw TypeError at every connect.
    const mjsCall = mockWriteText.mock.calls.find((c) => c[0].endsWith('.mjs'));
    expect(mjsCall).toBeDefined();
    const mjsContent = mjsCall?.[1] ?? '';
    expect(mjsContent).toContain('window.MozXULElement?.insertFTLIfNeeded(');
    expect(mjsContent).toContain('this.ownerDocument.l10n?.connectRoot(this.shadowRoot)');
    expect(mjsContent).toContain('this.ownerDocument.l10n?.disconnectRoot(this.shadowRoot)');
    expect(mjsContent).not.toContain('this.insertFTLIfNeeded(');
  });

  it('warns but continues when test manifest registration fails', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    mockRegisterTestManifest.mockRejectedValueOnce(new Error('moz.build missing'));

    try {
      await furnaceCreateCommand('/project', 'moz-test-widget', {
        description: 'A test widget',
        withTests: true,
        testStyle: 'browser-chrome',
      });
    } finally {
      process.stdin.isTTY = origTTY;
    }

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Could not register test manifest')
    );
  });

  it('rejects compose targets not registered as stock, override, or custom', async () => {
    const origTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(
        furnaceCreateCommand('/project', 'moz-test-widget', {
          description: 'Composing widget',
          compose: ['moz-nonexistent'],
        })
      ).rejects.toThrow(/unknown component "moz-nonexistent"/);
    } finally {
      process.stdin.isTTY = origTTY;
    }
  });
});

describe('interactive mode', () => {
  const origStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const origStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  function setTTY(stdin: boolean, stdout: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
  }

  afterAll(() => {
    if (origStdinTTY) Object.defineProperty(process.stdin, 'isTTY', origStdinTTY);
    if (origStdoutTTY) Object.defineProperty(process.stdout, 'isTTY', origStdoutTTY);
  });

  beforeEach(() => {
    setTTY(true, true);
  });

  it('prompts for name, description, and features interactively', async () => {
    const { text, multiselect } = await import('@clack/prompts');
    vi.mocked(text)
      .mockResolvedValueOnce('moz-test-widget') // name
      .mockResolvedValueOnce('A test widget'); // description
    vi.mocked(multiselect).mockResolvedValueOnce(['register']); // features
    mockIsComponentInEngine.mockResolvedValue(false);
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await furnaceCreateCommand('/project');

    expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Component tag name:' }));
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Description (optional):' })
    );
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Component features:' })
    );
    expect(mockWriteFurnaceConfig).toHaveBeenCalled();
  });

  it('returns early when user cancels at the name prompt', async () => {
    const { text } = await import('@clack/prompts');
    const { isCancel, cancel } = await import('../../utils/logger.js');
    const cancelSymbol = Symbol('cancel');
    vi.mocked(text).mockResolvedValueOnce(cancelSymbol as never);
    vi.mocked(isCancel).mockImplementation((value) => value === cancelSymbol);

    await furnaceCreateCommand('/project');

    expect(cancel).toHaveBeenCalledWith('Create cancelled');
    expect(mockWriteFurnaceConfig).not.toHaveBeenCalled();
  });

  it('returns early when user cancels at the feature prompt', async () => {
    const { text, multiselect } = await import('@clack/prompts');
    const { isCancel, cancel } = await import('../../utils/logger.js');
    vi.mocked(text).mockResolvedValueOnce('moz-test-widget').mockResolvedValueOnce('desc');
    const cancelSymbol = Symbol('cancel');
    vi.mocked(multiselect).mockResolvedValueOnce(cancelSymbol as never);
    vi.mocked(isCancel).mockImplementation((value) => value === cancelSymbol);
    mockIsComponentInEngine.mockResolvedValue(false);
    mockPathExists.mockImplementation((path: string) => {
      if (path === '/project/engine') return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await furnaceCreateCommand('/project');

    expect(cancel).toHaveBeenCalledWith('Create cancelled');
    expect(mockWriteFurnaceConfig).not.toHaveBeenCalled();
  });
});
