// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countNonBinaryDiffLines,
  detectNewFilesInDiff,
  isTestFile,
  lintExportedPatch,
  lintModificationComments,
  lintModifiedFileHeaders,
  lintNewFileHeaders,
  lintPatchedCss,
  lintPatchedJs,
  lintPatchSize,
} from '../patch-lint.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(),
}));

import type { FireForgeConfig } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);

const mockConfig: FireForgeConfig = {
  name: 'TestBrowser',
  vendor: 'Test',
  appId: 'org.test.browser',
  binaryName: 'testbrowser',
  firefox: { version: '140.9.0esr', product: 'firefox-esr' },
  license: 'MPL-2.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadFurnaceConfig.mockRejectedValue(new Error('no config'));
});

describe('lintPatchedCss', () => {
  it('returns empty for non-CSS files', async () => {
    const issues = await lintPatchedCss('/engine', ['foo.js', 'bar.mjs']);

    expect(issues).toEqual([]);
  });

  it('detects raw CSS color values', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('raw-color-value');
    expect(issues[0]?.severity).toBe('error');
  });

  it('detects introduced raw CSS color values from added diff lines', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--brand-color); }\n.new { color: #ff0000; }');

    const diff =
      'diff --git a/style.css b/style.css\n' +
      '--- a/style.css\n' +
      '+++ b/style.css\n' +
      '@@ -1 +1,2 @@\n' +
      ' body { color: var(--brand-color); }\n' +
      '+.new { color: #ff0000; }\n';

    const issues = await lintPatchedCss('/engine', ['style.css'], diff);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('raw-color-value');
    expect(issues[0]?.severity).toBe('error');
  });

  it('does not flag pre-existing raw CSS colors outside added diff lines', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }\n.new { color: var(--brand-color); }');

    const diff =
      'diff --git a/style.css b/style.css\n' +
      '--- a/style.css\n' +
      '+++ b/style.css\n' +
      '@@ -1 +1,2 @@\n' +
      ' body { color: #ff0000; }\n' +
      '+.new { color: var(--brand-color); }\n';

    const issues = await lintPatchedCss('/engine', ['style.css'], diff);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('skips files that do not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const issues = await lintPatchedCss('/engine', ['missing.css']);

    expect(issues).toEqual([]);
  });

  it('strips block comments before scanning', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('/* color: #ff0000; */ body { display: block; }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues).toEqual([]);
  });

  it('checks token prefix violations when config is available', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--foreign-color); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.some((i) => i.check === 'token-prefix-violation')).toBe(true);
    expect(issues.find((i) => i.check === 'token-prefix-violation')?.severity).toBe('error');
  });

  it('allows tokens matching the prefix', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--brand-accent); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('allows tokens on the allowlist', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: ['--foreign-color'],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--foreign-color); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('allows runtime variables listed in furnace.json runtimeVariables', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      runtimeVariables: ['--cam-x'],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { transform: translateX(var(--cam-x)); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('auto-exempts variables declared and consumed in the same CSS file', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { --tile-z: 0; transform: translateZ(var(--tile-z)); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('handles multiple CSS files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #abc; }');

    const issues = await lintPatchedCss('/engine', ['a.css', 'b.css', 'c.js']);

    expect(issues).toHaveLength(2);
  });

  it('skips raw-color-value for files on rawColorAllowlist (exact path)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --brand-primary: #ff0000; }');

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['themes/tokens.css'] },
    };
    const issues = await lintPatchedCss(
      '/engine',
      ['themes/tokens.css'],
      undefined,
      configWithAllowlist
    );

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('skips raw-color-value for files on rawColorAllowlist (basename match)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --brand-primary: #ff0000; }');

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['tokens.css'] },
    };
    const issues = await lintPatchedCss(
      '/engine',
      ['themes/tokens.css'],
      undefined,
      configWithAllowlist
    );

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('rawColorAllowlist works when furnace config loads successfully', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --brand: #ff0000; }');
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1 as const,
      componentPrefix: 'moz-',
      tokenPrefix: 'ff',
      stock: [],
      overrides: {},
      custom: {},
    });

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['tokens.css'] },
    };
    const issues = await lintPatchedCss('/engine', ['tokens.css'], undefined, configWithAllowlist);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('still flags raw-color-value for files not on rawColorAllowlist', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }');

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['tokens.css'] },
    };
    const issues = await lintPatchedCss('/engine', ['style.css'], undefined, configWithAllowlist);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(1);
  });

  it('suppresses raw-color-value with inline fireforge-ignore comment', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      ':root {\n' +
        '  --brand-primary: #ff0000; /* fireforge-ignore: raw-color-value */\n' +
        '  --brand-bg: #333; /* fireforge-ignore: raw-color-value */\n' +
        '}'
    );

    const issues = await lintPatchedCss('/engine', ['tokens.css']);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('flags raw-color-value on lines without inline suppression', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      ':root {\n' +
        '  --brand-primary: #ff0000; /* fireforge-ignore: raw-color-value */\n' +
        '  color: #333;\n' +
        '}'
    );

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(1);
  });
});

describe('detectNewFilesInDiff', () => {
  it('detects new files from diff', () => {
    const diff =
      'diff --git a/foo.js b/foo.js\nnew file mode 100644\n--- /dev/null\n+++ b/foo.js\n' +
      'diff --git a/bar.js b/bar.js\n--- a/bar.js\n+++ b/bar.js\n';
    const newFiles = detectNewFilesInDiff(diff);

    expect(newFiles.has('foo.js')).toBe(true);
    expect(newFiles.has('bar.js')).toBe(false);
  });

  it('returns empty set for diffs with no new files', () => {
    const diff =
      'diff --git a/bar.js b/bar.js\n--- a/bar.js\n+++ b/bar.js\n@@ -1 +1 @@\n-old\n+new\n';
    const newFiles = detectNewFilesInDiff(diff);

    expect(newFiles.size).toBe(0);
  });
});

describe('lintNewFileHeaders', () => {
  it('flags new files missing license headers', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('const x = 1;\n');

    const issues = await lintNewFileHeaders('/engine', ['new-module.js'], mockConfig);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-license-header');
    expect(issues[0]?.severity).toBe('error');
  });

  it('passes files with correct license header', async () => {
    mockPathExists.mockResolvedValue(true);
    const header =
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
      '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
      'const x = 1;\n';
    mockReadText.mockResolvedValue(header);

    const issues = await lintNewFileHeaders('/engine', ['new-module.js'], mockConfig);

    expect(issues).toHaveLength(0);
  });

  it('skips files with unknown extensions', async () => {
    const issues = await lintNewFileHeaders('/engine', ['data.json'], mockConfig);

    expect(issues).toHaveLength(0);
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it('checks CSS files with CSS comment style', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('.foo { display: block; }');

    const issues = await lintNewFileHeaders('/engine', ['style.css'], mockConfig);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-license-header');
  });
});

describe('isTestFile', () => {
  it('matches paths containing /test/', () => {
    expect(isTestFile('browser/base/content/test/general/helper.js')).toBe(true);
  });

  it('matches browser_*.js filenames', () => {
    expect(isTestFile('browser_sidebar.js')).toBe(true);
  });

  it('matches test_*.js filenames', () => {
    expect(isTestFile('test_utils.js')).toBe(true);
  });

  it('matches xpcshell_*.js filenames', () => {
    expect(isTestFile('xpcshell_worker.js')).toBe(true);
  });

  it('does not match regular module files', () => {
    expect(isTestFile('modules/MyModule.sys.mjs')).toBe(false);
  });

  it('does not match non-test content paths', () => {
    expect(isTestFile('browser/content/app.js')).toBe(false);
  });
});

describe('lintPatchedJs', () => {
  it('detects relative imports', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('import { foo } from "./bar.js";\nexport function test() {}\n');

    const issues = await lintPatchedJs('/engine', ['module.mjs'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
    expect(issues.find((i) => i.check === 'relative-import')?.severity).toBe('error');
  });

  it('detects ChromeUtils.import with relative path', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('ChromeUtils.import("../Foo.sys.mjs");\n');

    const issues = await lintPatchedJs('/engine', ['module.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('does not flag new files below the notice threshold', async () => {
    mockPathExists.mockResolvedValue(true);
    const smallFile = Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(smallFile);

    const issues = await lintPatchedJs('/engine', ['small.js'], new Set(['small.js']), mockConfig);

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('emits notice for new files in the notice tier (500–749 lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 550 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs('/engine', ['mid.js'], new Set(['mid.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('notice');
  });

  it('emits warning for new files in the warning tier (750–899 lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 800 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs('/engine', ['big.js'], new Set(['big.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('warning');
  });

  it('emits error for new files at or above the error tier (900+ lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 950 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs('/engine', ['huge.js'], new Set(['huge.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('error');
  });

  it('uses test-file thresholds for files in /test/ paths', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1300 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['browser/base/content/test/general/browser_foo.js'],
      new Set(['browser/base/content/test/general/browser_foo.js']),
      mockConfig
    );

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('notice');
    expect(sizeIssue?.message).toContain('Test file');
  });

  it('emits warning for test files in the warning tier (1400–1599 lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1500 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['browser/base/content/test/general/browser_bar.js'],
      new Set(['browser/base/content/test/general/browser_bar.js']),
      mockConfig
    );

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('warning');
    expect(sizeIssue?.message).toContain('splitting');
  });

  it('emits error for test files at or above 1600 lines', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1700 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['test_utils.js'],
      new Set(['test_utils.js']),
      mockConfig
    );

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('error');
  });

  it('does not flag test files below 1200 lines', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1100 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['browser/base/content/test/general/browser_baz.js'],
      new Set(['browser/base/content/test/general/browser_baz.js']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('does not flag large existing files', async () => {
    mockPathExists.mockResolvedValue(true);
    const bigFile = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(bigFile);

    const issues = await lintPatchedJs('/engine', ['existing.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('flags missing JSDoc on exports in new .sys.mjs files as error', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doSomething() {\n  return 1;\n}\n');

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set(['MyModule.sys.mjs']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues.find((i) => i.check === 'missing-jsdoc')?.severity).toBe('error');
  });

  it('does not flag JSDoc check on non-owned files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doSomething() {\n  return 1;\n}\n');

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set<string>(),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(false);
  });

  it('passes exports with complete JSDoc', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/**\n * Does something.\n * @returns {number} The result\n */\nexport function doSomething() {\n  return 1;\n}\n'
    );

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set(['MyModule.sys.mjs']),
      mockConfig
    );

    const jsdocChecks = ['missing-jsdoc', 'jsdoc-param-mismatch', 'jsdoc-missing-returns'];
    expect(issues.some((i) => jsdocChecks.includes(i.check))).toBe(false);
  });

  it('flags JSDoc issues for patch-owned files via patchOwnedFiles param', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doWork() {\n  return 1;\n}\n');

    // File is not in newFiles but IS in patchOwnedFiles (owned by queue)
    const patchOwned = new Set(['MyModule.sys.mjs']);
    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set<string>(),
      mockConfig,
      patchOwned
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues.find((i) => i.check === 'missing-jsdoc')?.severity).toBe('error');
  });

  it('warns about observer topics with binaryName that do not follow convention', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('Services.obs.addObserver(this, "testbrowser-badtopic");\n');

    const issues = await lintPatchedJs('/engine', ['observer.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(true);
    expect(issues.find((i) => i.check === 'observer-topic-naming')?.severity).toBe('warning');
  });

  it('does not match observer topics across newlines (no false positive)', async () => {
    mockPathExists.mockResolvedValue(true);
    // notifyObservers call with no string literal on the same line,
    // followed by an unrelated string on a later line — must NOT be captured.
    mockReadText.mockResolvedValue(
      'Services.obs.notifyObservers(STORAGE_EVENTS.TILES_APPLET_NULLED, {\n' +
        '  data: someValue,\n' +
        '});\n' +
        'lazy.assertAutomationOnly("testbrowser-automation-check");\n'
    );

    const issues = await lintPatchedJs('/engine', ['store.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(false);
  });

  it('passes observer topics following convention', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      'Services.obs.addObserver(this, "testbrowser-sidebar-opened");\n'
    );

    const issues = await lintPatchedJs('/engine', ['observer.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(false);
  });

  it('ignores non-JS files', async () => {
    const issues = await lintPatchedJs(
      '/engine',
      ['style.css', 'data.json'],
      new Set<string>(),
      mockConfig
    );

    expect(issues).toEqual([]);
  });
});

describe('lintModificationComments', () => {
  it('warns when modified upstream JS lacks BINARYNAME comment', () => {
    const diff =
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js\n' +
      '--- a/browser/base/content/browser.js\n' +
      '+++ b/browser/base/content/browser.js\n' +
      '@@ -10,3 +10,4 @@\n' +
      ' existing line\n' +
      '+const newCode = true;\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-modification-comment');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('passes when modification includes BINARYNAME comment', () => {
    const diff =
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js\n' +
      '--- a/browser/base/content/browser.js\n' +
      '+++ b/browser/base/content/browser.js\n' +
      '@@ -10,3 +10,5 @@\n' +
      ' existing line\n' +
      '+// TESTBROWSER: Add new feature\n' +
      '+const newCode = true;\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(0);
  });

  it('skips new files', () => {
    const diff =
      'diff --git a/browser/new-file.js b/browser/new-file.js\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/browser/new-file.js\n' +
      '@@ -0,0 +1,2 @@\n' +
      '+const x = 1;\n' +
      '+const y = 2;\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(0);
  });

  it('skips non-JS files', () => {
    const diff =
      'diff --git a/browser/style.css b/browser/style.css\n' +
      '--- a/browser/style.css\n' +
      '+++ b/browser/style.css\n' +
      '@@ -1,1 +1,2 @@\n' +
      ' .foo { }\n' +
      '+.bar { color: red; }\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(0);
  });
});

describe('countNonBinaryDiffLines', () => {
  it('counts all lines as text for a pure text diff', () => {
    const diff =
      'diff --git a/file.js b/file.js\n' +
      '--- a/file.js\n' +
      '+++ b/file.js\n' +
      '@@ -1,3 +1,3 @@\n' +
      '-old line\n' +
      '+new line\n' +
      ' context\n';
    const result = countNonBinaryDiffLines(diff);
    expect(result.textLines).toBe(result.total);
  });

  it('excludes binary hunk lines from textLines', () => {
    const diff =
      'diff --git a/icon.png b/icon.png\n' +
      'new file mode 100644\n' +
      'index 0000000..abcdef1\n' +
      'GIT binary patch\n' +
      'literal 1234\n' +
      'zcmV;z1=abcdefghijk\n' +
      '\n' +
      'diff --git a/file.js b/file.js\n' +
      '--- a/file.js\n' +
      '+++ b/file.js\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const result = countNonBinaryDiffLines(diff);
    // Binary hunk: "GIT binary patch", "literal 1234", base85 data, empty line = 4 binary lines
    // (inBinaryHunk stays true until next "diff --git")
    expect(result.textLines).toBe(result.total - 4);
  });

  it('handles multiple binary files', () => {
    const diff =
      'diff --git a/a.png b/a.png\n' +
      'GIT binary patch\n' +
      'literal 100\n' +
      'zdata1\n' +
      '\n' +
      'diff --git a/b.ico b/b.ico\n' +
      'GIT binary patch\n' +
      'literal 200\n' +
      'zdata2\n' +
      '\n';
    const result = countNonBinaryDiffLines(diff);
    // Only the two "diff --git" header lines are non-binary; everything after
    // each "GIT binary patch" stays binary until the next header.
    expect(result.textLines).toBe(2);
  });

  it('handles mixed binary and text files', () => {
    const diff =
      'diff --git a/icon.png b/icon.png\n' +
      'GIT binary patch\n' +
      'literal 500\n' +
      '\n' +
      'diff --git a/app.js b/app.js\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const result = countNonBinaryDiffLines(diff);
    // 3 binary lines: "GIT binary patch", "literal 500", empty line
    expect(result.textLines).toBe(result.total - 3);
  });
});

describe('lintPatchSize', () => {
  it('warns when patch affects more than 5 files', () => {
    const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'];
    const issues = lintPatchSize(files, 10);

    expect(issues.some((i) => i.check === 'large-patch-files')).toBe(true);
    expect(issues.find((i) => i.check === 'large-patch-files')?.severity).toBe('warning');
  });

  it('returns notice when patch reaches 800 lines', () => {
    const issues = lintPatchSize(['a.js'], 800);

    expect(issues.find((i) => i.check === 'large-patch-lines')?.severity).toBe('notice');
  });

  it('returns warning when patch reaches 1500 lines', () => {
    const issues = lintPatchSize(['a.js'], 1500);

    expect(issues.find((i) => i.check === 'large-patch-lines')?.severity).toBe('warning');
  });

  it('returns error when patch reaches 3000 lines', () => {
    const issues = lintPatchSize(['a.js'], 3000);

    expect(issues.find((i) => i.check === 'large-patch-lines')?.severity).toBe('error');
  });

  it('returns no line-count issue below 800 lines', () => {
    const issues = lintPatchSize(['a.js'], 799);

    expect(issues.some((i) => i.check === 'large-patch-lines')).toBe(false);
  });

  it('returns empty for small patches', () => {
    const issues = lintPatchSize(['a.js'], 50);

    expect(issues).toEqual([]);
  });

  it('uses higher thresholds for test-only patches', () => {
    const testFiles = ['test/test_foo.js', 'test/test_bar.js'];

    expect(lintPatchSize(testFiles, 800).some((i) => i.check === 'large-patch-lines')).toBe(false);
    expect(
      lintPatchSize(testFiles, 1500).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('notice');
    expect(
      lintPatchSize(testFiles, 3000).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('warning');
    expect(
      lintPatchSize(testFiles, 6000).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('error');
  });

  it('uses general thresholds for mixed test and non-test patches', () => {
    const mixedFiles = ['a.js', 'test/test_foo.js'];

    expect(
      lintPatchSize(mixedFiles, 800).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('notice');
  });
});

describe('lintModifiedFileHeaders', () => {
  it('warns when modified file lacks any recognized header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('const x = 1;\n');

    const issues = await lintModifiedFileHeaders('/engine', ['browser.js'], new Set());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('modified-file-missing-header');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('passes when modified file has MPL header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
        '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
        'const x = 1;\n'
    );

    const issues = await lintModifiedFileHeaders('/engine', ['browser.js'], new Set());

    expect(issues).toHaveLength(0);
  });

  it('passes when modified file has EUPL header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('/* SPDX-License-Identifier: EUPL-1.2 */\nconst x = 1;\n');

    const issues = await lintModifiedFileHeaders('/engine', ['module.js'], new Set());

    expect(issues).toHaveLength(0);
  });

  it('skips new files', async () => {
    const issues = await lintModifiedFileHeaders('/engine', ['new.js'], new Set(['new.js']));

    expect(issues).toHaveLength(0);
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it('skips files with unsupported extensions', async () => {
    const issues = await lintModifiedFileHeaders('/engine', ['data.json'], new Set());

    expect(issues).toHaveLength(0);
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it('skips files that do not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const issues = await lintModifiedFileHeaders('/engine', ['missing.js'], new Set());

    expect(issues).toHaveLength(0);
  });

  it('passes when upstream .sys.mjs file has block-comment MPL header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
        ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        ' * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n' +
        'export class Foo {}\n'
    );

    const issues = await lintModifiedFileHeaders(
      '/engine',
      ['browser/components/BrowserGlue.sys.mjs'],
      new Set()
    );

    expect(issues).toHaveLength(0);
  });

  it('passes when upstream file contains SPDX identifier in non-standard format', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '// Copyright 2024 Mozilla Foundation\n' +
        '// SPDX-License-Identifier: MPL-2.0\n' +
        'const x = 1;\n'
    );

    const issues = await lintModifiedFileHeaders('/engine', ['utils.js'], new Set());

    expect(issues).toHaveLength(0);
  });
});

describe('lintExportedPatch', () => {
  it('combines issues from all lint checks', async () => {
    mockPathExists.mockResolvedValue(true);
    // A new JS file missing license header with a raw CSS color in a CSS file
    mockReadText.mockImplementation((path: string) => {
      if (path.endsWith('.css')) return Promise.resolve('body { color: #ff0000; }');
      return Promise.resolve('const x = 1;\n');
    });

    const diff =
      'diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+const x = 1;\n' +
      'diff --git a/style.css b/style.css\n--- a/style.css\n+++ b/style.css\n@@ -1 +1 @@\n-old\n+body { color: #ff0000; }\n';

    const issues = await lintExportedPatch('/engine', ['new.js', 'style.css'], diff, mockConfig);

    // Should have at least: missing-license-header + raw-color-value
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
    expect(issues.some((i) => i.check === 'raw-color-value')).toBe(true);
  });
});
