// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchQueueContext } from '../patch-lint-cross.js';
import {
  isTestScriptFile,
  resolvePatchOwnedChromeScripts,
  resolvePatchOwnedSysMjs,
  resolvePatchOwnedTestScripts,
} from '../patch-lint-ownership.js';

describe('resolvePatchOwnedSysMjs', () => {
  it('returns current-diff new .sys.mjs files when no context is provided', () => {
    const newFiles = new Set(['browser/modules/Foo.sys.mjs', 'browser/bar.js']);
    const result = resolvePatchOwnedSysMjs(newFiles);

    expect(result).toEqual(new Set(['browser/modules/Foo.sys.mjs']));
  });

  it('excludes non-.sys.mjs files', () => {
    const newFiles = new Set(['browser/bar.js', 'browser/style.css']);
    const result = resolvePatchOwnedSysMjs(newFiles);

    expect(result.size).toBe(0);
  });

  it('includes patch-queue-created .sys.mjs files when context is provided', () => {
    const newFiles = new Set<string>();
    const ctx: PatchQueueContext = {
      entries: [
        {
          filename: '001-add-sidebar.patch',
          order: 1,
          metadata: null,
          diff:
            'diff --git a/browser/modules/Sidebar.sys.mjs b/browser/modules/Sidebar.sys.mjs\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/browser/modules/Sidebar.sys.mjs\n' +
            '@@ -0,0 +1 @@\n' +
            '+export function init() {}\n',
          newFiles: new Map([['browser/modules/Sidebar.sys.mjs', 'export function init() {}']]),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    const result = resolvePatchOwnedSysMjs(newFiles, ctx);
    expect(result.has('browser/modules/Sidebar.sys.mjs')).toBe(true);
  });

  it('combines current-diff and queue-owned files', () => {
    const newFiles = new Set(['browser/modules/NewModule.sys.mjs']);
    const ctx: PatchQueueContext = {
      entries: [
        {
          filename: '001-existing.patch',
          order: 1,
          metadata: null,
          diff:
            'diff --git a/browser/modules/Existing.sys.mjs b/browser/modules/Existing.sys.mjs\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/browser/modules/Existing.sys.mjs\n' +
            '@@ -0,0 +1 @@\n' +
            '+export const X = 1;\n',
          newFiles: new Map([['browser/modules/Existing.sys.mjs', 'export const X = 1;']]),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    const result = resolvePatchOwnedSysMjs(newFiles, ctx);
    expect(result.has('browser/modules/NewModule.sys.mjs')).toBe(true);
    expect(result.has('browser/modules/Existing.sys.mjs')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('does not include non-.sys.mjs files from the queue', () => {
    const newFiles = new Set<string>();
    const ctx: PatchQueueContext = {
      entries: [
        {
          filename: '001-script.patch',
          order: 1,
          metadata: null,
          diff:
            'diff --git a/browser/script.js b/browser/script.js\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/browser/script.js\n' +
            '@@ -0,0 +1 @@\n' +
            '+const x = 1;\n',
          newFiles: new Map([['browser/script.js', 'const x = 1;']]),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    const result = resolvePatchOwnedSysMjs(newFiles, ctx);
    expect(result.size).toBe(0);
  });
});

describe('resolvePatchOwnedChromeScripts', () => {
  it('returns current-diff new .js (non-.sys.mjs) files when no context is provided', () => {
    const newFiles = new Set([
      'browser/base/content/mybrowserDock.js',
      'browser/modules/Foo.sys.mjs',
      'browser/style.css',
    ]);
    const result = resolvePatchOwnedChromeScripts(newFiles);

    expect(result).toEqual(new Set(['browser/base/content/mybrowserDock.js']));
  });

  it('excludes .sys.mjs files', () => {
    const newFiles = new Set(['browser/modules/Foo.sys.mjs']);
    const result = resolvePatchOwnedChromeScripts(newFiles);

    expect(result.size).toBe(0);
  });

  it('includes patch-queue-created chrome scripts when context is provided', () => {
    const newFiles = new Set<string>();
    const ctx: PatchQueueContext = {
      entries: [
        {
          filename: '0030-ui-mybrowser-chrome-shell.patch',
          order: 30,
          metadata: null,
          diff:
            'diff --git a/browser/base/content/mybrowserChromeShell.js b/browser/base/content/mybrowserChromeShell.js\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/browser/base/content/mybrowserChromeShell.js\n' +
            '@@ -0,0 +1 @@\n' +
            '+class MyBrowserChromeShell {}\n',
          newFiles: new Map([
            ['browser/base/content/mybrowserChromeShell.js', 'class MyBrowserChromeShell {}'],
          ]),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    const result = resolvePatchOwnedChromeScripts(newFiles, ctx);
    expect(result.has('browser/base/content/mybrowserChromeShell.js')).toBe(true);
  });

  it('does not include .sys.mjs files from the queue', () => {
    const newFiles = new Set<string>();
    const ctx: PatchQueueContext = {
      entries: [
        {
          filename: '001-module.patch',
          order: 1,
          metadata: null,
          diff:
            'diff --git a/browser/modules/Mod.sys.mjs b/browser/modules/Mod.sys.mjs\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/browser/modules/Mod.sys.mjs\n' +
            '@@ -0,0 +1 @@\n' +
            '+export const X = 1;\n',
          newFiles: new Map([['browser/modules/Mod.sys.mjs', 'export const X = 1;']]),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    const result = resolvePatchOwnedChromeScripts(newFiles, ctx);
    expect(result.size).toBe(0);
  });
});

describe('isTestScriptFile / resolvePatchOwnedTestScripts', () => {
  it('matches test-shaped .js files and rejects modules and non-tests', () => {
    expect(isTestScriptFile('browser/components/x/test/browser/browser_a.js')).toBe(true);
    // /tests/ (plural) is not the /test/ path marker, but the test_ basename matches.
    expect(isTestScriptFile('browser/components/x/tests/xpcshell/test_b.js')).toBe(true);
    expect(isTestScriptFile('toolkit/xpcshell_c.js')).toBe(true);
    expect(isTestScriptFile('browser/components/x/test/browser/head.js')).toBe(true);
    expect(isTestScriptFile('browser/modules/Mod.sys.mjs')).toBe(false);
    expect(isTestScriptFile('browser/base/content/browser-init.js')).toBe(false);
    expect(isTestScriptFile('browser/components/x/test/browser/browser.toml')).toBe(false);
  });

  it('agrees with patch-lint isTestFile for .js inputs (duplicated to avoid an import cycle)', async () => {
    const { isTestFile } = await import('../patch-lint.js');
    const fixtures = [
      'browser/components/x/test/browser/browser_a.js',
      'browser/components/x/test/browser/head.js',
      'toolkit/tests/test_b.js',
      'browser/base/content/browser-init.js',
      'a/b/browser_c.js',
      'a/b/xpcshell_d.js',
      'a/b/regular.js',
    ];
    for (const file of fixtures) {
      expect(isTestScriptFile(file), file).toBe(isTestFile(file));
    }
  });

  it('resolves patch-owned test scripts from current diff and queue', () => {
    const owned = resolvePatchOwnedTestScripts(
      new Set(['browser/x/test/browser/browser_new.js', 'browser/x/Mod.sys.mjs'])
    );
    expect(owned).toEqual(new Set(['browser/x/test/browser/browser_new.js']));
  });
});
