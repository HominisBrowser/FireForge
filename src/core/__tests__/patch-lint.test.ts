// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectNewFilesInDiff,
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
  firefox: { version: '140.0esr', product: 'firefox-esr' },
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
    expect(issues[0]?.severity).toBe('warning');
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

  it('handles multiple CSS files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #abc; }');

    const issues = await lintPatchedCss('/engine', ['a.css', 'b.css', 'c.js']);

    expect(issues).toHaveLength(2);
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

  it('warns about large new files', async () => {
    mockPathExists.mockResolvedValue(true);
    const bigFile = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(bigFile);

    const issues = await lintPatchedJs(
      '/engine',
      ['big-module.js'],
      new Set(['big-module.js']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(true);
    expect(issues.find((i) => i.check === 'file-too-large')?.severity).toBe('warning');
  });

  it('does not warn about large existing files', async () => {
    mockPathExists.mockResolvedValue(true);
    const bigFile = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(bigFile);

    const issues = await lintPatchedJs('/engine', ['existing.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('warns about missing JSDoc on exports in new .sys.mjs files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doSomething() {\n  return 1;\n}\n');

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set(['MyModule.sys.mjs']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues.find((i) => i.check === 'missing-jsdoc')?.severity).toBe('warning');
  });

  it('does not flag JSDoc check on non-new files', async () => {
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

  it('passes exports with JSDoc', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/** Does something. */\nexport function doSomething() {\n  return 1;\n}\n'
    );

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set(['MyModule.sys.mjs']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(false);
  });

  it('warns about observer topics with binaryName that do not follow convention', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('Services.obs.addObserver(this, "testbrowser-badtopic");\n');

    const issues = await lintPatchedJs('/engine', ['observer.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(true);
    expect(issues.find((i) => i.check === 'observer-topic-naming')?.severity).toBe('warning');
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

describe('lintPatchSize', () => {
  it('warns when patch affects more than 5 files', () => {
    const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'];
    const issues = lintPatchSize(files, 10);

    expect(issues.some((i) => i.check === 'large-patch-files')).toBe(true);
    expect(issues.find((i) => i.check === 'large-patch-files')?.severity).toBe('warning');
  });

  it('warns when patch exceeds 300 lines', () => {
    const issues = lintPatchSize(['a.js'], 500);

    expect(issues.some((i) => i.check === 'large-patch-lines')).toBe(true);
  });

  it('returns empty for small patches', () => {
    const issues = lintPatchSize(['a.js'], 50);

    expect(issues).toEqual([]);
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
