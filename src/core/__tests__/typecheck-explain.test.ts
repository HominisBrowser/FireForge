// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatTypecheckExplanation } from '../../commands/typecheck-explain.js';
import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { getProjectPaths } from '../config.js';
import { explainTypecheckFile, type TypecheckExplanation } from '../typecheck-explain.js';

function creating(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([file, content]) => {
      const lines = content.trimEnd().split('\n');
      return [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        '',
      ].join('\n');
    })
    .join('');
}

const A_MODULE = [
  'import { b } from "resource:///modules/B.sys.mjs";',
  'import { up } from "resource:///modules/Upstream.sys.mjs";',
  '/** @type {import("chrome://global/content/elements/moz-w.mjs").default} */',
  'export const a = b + up;',
  '',
].join('\n');
const A_TEST = [
  'const { a } = ChromeUtils.importESModule("resource:///modules/A.sys.mjs");',
  '/** @type {typeof import("resource:///modules/A.sys.mjs").a} */',
  'let first;',
  '/** @type {import("resource:///modules/B.sys.mjs").T} */',
  'let later;',
  '',
].join('\n');

describe('explainTypecheckFile', () => {
  let projectRoot: string;
  let config: FireForgeConfig;

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-typecheck-explain-');
    config = {
      ...DEFAULT_CONFIG,
      patchLint: { checkJs: true, checkJsTestFiles: true, checkJsTestShim: 'test-shim.d.ts' },
      typecheck: {
        projects: ['engine/browser/jsconfig.json'],
        extraShim: 'shared.d.ts',
        projectOverrides: { './engine/browser/jsconfig.json': 'browser.d.ts' },
        litTypes: true,
      },
    };
    const engine = {
      'browser/modules/A.sys.mjs': A_MODULE,
      'browser/modules/B.sys.mjs': 'export const b = 1;\n',
      'browser/test/head.js': 'function helper() {}\n',
      'browser/test/browser_a.js': A_TEST,
      'toolkit/content/widgets/moz-w/moz-w.mjs': 'export default class MozW {}\n',
    };
    await writeFiles(projectRoot, {
      ...Object.fromEntries(Object.entries(engine).map(([file, c]) => [`engine/${file}`, c])),
      'engine/browser/base/content/browser.js': 'a\nb\n',
      'engine/browser/jsconfig.json': JSON.stringify({
        compilerOptions: { allowJs: true, checkJs: true, noEmit: true },
        include: ['modules/**/*.mjs'],
      }),
      'patches/001-ui-a.patch': creating({
        'browser/modules/A.sys.mjs': A_MODULE,
        'browser/test/head.js': engine['browser/test/head.js'],
        'browser/test/browser_a.js': A_TEST,
      }),
      'patches/002-ui-b.patch':
        creating({
          'browser/modules/B.sys.mjs': engine['browser/modules/B.sys.mjs'],
          'toolkit/content/widgets/moz-w/moz-w.mjs':
            engine['toolkit/content/widgets/moz-w/moz-w.mjs'],
        }) +
        [
          'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js',
          '--- a/browser/base/content/browser.js',
          '+++ b/browser/base/content/browser.js',
          '@@ -1 +1,2 @@',
          ' a',
          '+b',
          '',
        ].join('\n'),
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  function explain(file: string): Promise<TypecheckExplanation> {
    return explainTypecheckFile(getProjectPaths(projectRoot), config, config.typecheck, file);
  }

  it('explains a patch-created module: project root with its settings, module program', async () => {
    const result = await explain('browser/modules/A.sys.mjs');
    expect(result.file).toBe('engine/browser/modules/A.sys.mjs');
    expect(result.projects).toEqual([
      {
        project: 'engine/browser/jsconfig.json',
        membership: 'root',
        litTypes: true,
        extraShim: 'browser.d.ts',
        overrideKey: './engine/browser/jsconfig.json',
        undefinedIdentifiers: 'warning',
      },
    ]);
    expect(result.perPatch).toMatchObject({
      creators: ['001-ui-a.patch'],
      program: 'module',
      resolvable: ['browser/modules/B.sys.mjs'],
      imports: [
        {
          specifier: 'chrome://global/content/elements/moz-w.mjs',
          resolution: 'any',
        },
        {
          specifier: 'resource:///modules/B.sys.mjs',
          resolution: 'owned',
          target: 'browser/modules/B.sys.mjs',
        },
        { specifier: 'resource:///modules/Upstream.sys.mjs', resolution: 'any' },
      ],
    });
    expect(result.perPatch.shim).toBeUndefined();
  });

  it('explains a test script: its heads, the modules up to its patch, imports typed any', async () => {
    const result = await explain('engine/browser/test/browser_a.js');
    expect(result.projects[0]?.membership).toBe('not-root');
    expect(result.perPatch).toMatchObject({
      program: 'test',
      heads: ['browser/test/head.js'],
      resolvable: ['browser/modules/A.sys.mjs'],
      shim: 'test-shim.d.ts',
      imports: [
        {
          specifier: 'resource:///modules/A.sys.mjs',
          resolution: 'owned',
          target: 'browser/modules/A.sys.mjs',
        },
        { specifier: 'resource:///modules/B.sys.mjs', resolution: 'any' },
      ],
    });

    const printed = formatTypecheckExplanation(result)
      .map(([title, lines]) => [title, ...lines].join('\n'))
      .join('\n');
    expect(printed).toContain('Checked as a test script, in its own program.');
    expect(printed).toContain('Heads loaded beside it: browser/test/head.js.');
    expect(printed).toContain('resource:///modules/B.sys.mjs -> any');
    expect(printed).toContain('import("…").Type');
  });

  it('says a patch-modified upstream file and a widget module are not checked per patch', async () => {
    const modified = await explain('engine/browser/base/content/browser.js');
    expect(modified.perPatch).toMatchObject({ program: 'none', modifiers: ['002-ui-b.patch'] });
    expect(modified.perPatch.reason).toContain('patch-modified upstream file');

    const widget = await explain('engine/toolkit/content/widgets/moz-w/moz-w.mjs');
    expect(widget.perPatch).toMatchObject({ program: 'none', creators: ['002-ui-b.patch'] });
    expect(widget.perPatch.reason).toContain('resolution target');
  });

  it('says when per-patch checkJs is off or the file is outside engine/', async () => {
    const outside = await explain('shared.d.ts');
    expect(outside.exists).toBe(false);
    expect(outside.perPatch.reason).toContain('outside engine/');

    config = { ...config, patchLint: {} };
    const off = await explain('browser/modules/A.sys.mjs');
    expect(off.perPatch).toMatchObject({ enabled: false, program: 'none' });
    expect(off.perPatch.reason).toBe('patchLint.checkJs is off');
  });
});
