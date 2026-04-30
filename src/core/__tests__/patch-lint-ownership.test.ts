// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchQueueContext } from '../patch-lint-cross.js';
import {
  resolvePatchOwnedChromeScripts,
  resolvePatchOwnedSysMjs,
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
      'browser/base/content/hominisDock.js',
      'browser/modules/Foo.sys.mjs',
      'browser/style.css',
    ]);
    const result = resolvePatchOwnedChromeScripts(newFiles);

    expect(result).toEqual(new Set(['browser/base/content/hominisDock.js']));
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
          filename: '0030-ui-hominis-chrome-shell.patch',
          order: 30,
          metadata: null,
          diff:
            'diff --git a/browser/base/content/hominisChromeShell.js b/browser/base/content/hominisChromeShell.js\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/browser/base/content/hominisChromeShell.js\n' +
            '@@ -0,0 +1 @@\n' +
            '+class HominisChromeShell {}\n',
          newFiles: new Map([
            ['browser/base/content/hominisChromeShell.js', 'class HominisChromeShell {}'],
          ]),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    const result = resolvePatchOwnedChromeScripts(newFiles, ctx);
    expect(result.has('browser/base/content/hominisChromeShell.js')).toBe(true);
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
