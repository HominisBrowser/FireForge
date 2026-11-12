// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listDir } from '../kernel/fs.js';
import type { ChangeSet } from '../project/index.js';
import type { TextStep } from '../testing/changes.js';
import { engineFiles, textChangeSet } from '../testing/changes.js';
import { testConfig } from '../testing/config.js';
import { lintSteps } from '../testing/lint.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { moduleMatcher, pathsCandidates } from './checkjs.js';
import { checkOwnedTypes, explainOwnedTypes, type Finding } from './index.js';

const dir = useTempDir();

type Config = Record<string, unknown>;

const checkJs = (extra: Config = {}): Config => ({
  patchLint: { checkJs: true, ...extra },
});
const strict = (extra: Config = {}): Config => checkJs({ checkJsStrict: true, ...extra });

async function typeFindings(
  steps: TextStep[],
  config: Record<string, unknown>,
  engine: Record<string, string> = {}
): Promise<[string, number, string, string][]> {
  const findings = await lintSteps(['checkjs-type-error'], steps, {
    config,
    engine,
    projectRoot: dir(),
  });
  return findings.map((f) => [
    f.path ?? '',
    f.line ?? 0,
    f.severity,
    f.message.replace(/ \(undefined identifier.*$/, ''),
  ]);
}

describe('moduleMatcher and pathsCandidates', () => {
  it('resolves a URL by unique basename, .mjs finding .sys.mjs, and nothing ambiguous or relative', () => {
    const match = moduleMatcher(['a/Foo.sys.mjs', 'b/Bar.mjs', 'c/Dup.mjs', 'd/Dup.mjs']);
    expect(match('resource:///modules/Foo.sys.mjs')).toBe('a/Foo.sys.mjs');
    expect(match('chrome://global/content/Foo.mjs?x=1')).toBe('a/Foo.sys.mjs');
    expect(match('chrome://x/content/Bar.mjs')).toBe('b/Bar.mjs');
    expect(match('chrome://x/content/Dup.mjs')).toBeUndefined();
    expect(match('./Bar.mjs')).toBeUndefined();
  });

  it('substitutes the one wildcard of a target, and matches exact patterns', () => {
    const paths = {
      'resource:///modules/x/*': ['browser/x/*', './other/*'],
      'chrome://a/content/b.mjs': ['a/b.mjs'],
    };
    expect(pathsCandidates(paths, 'resource:///modules/x/Y.sys.mjs')).toEqual([
      'browser/x/Y.sys.mjs',
      'other/Y.sys.mjs',
    ]);
    expect(pathsCandidates(paths, 'chrome://a/content/b.mjs')).toEqual(['a/b.mjs']);
    expect(pathsCandidates(paths, 'chrome://a/content/c.mjs')).toEqual([]);
  });
});

describe('checkJs over created modules', () => {
  it('reports type errors with their line, and nothing when checkJs is off', async () => {
    const steps = [
      { path: 'browser/A.sys.mjs', after: '/** @type {number} */\nexport const n = "text";\n' },
    ];
    expect(await typeFindings(steps, checkJs())).toEqual([
      [
        'browser/A.sys.mjs',
        2,
        'error',
        "TS2322: Type 'string' is not assignable to type 'number'.",
      ],
    ]);
    expect(await typeFindings(steps, {})).toEqual([]);
  });

  it('reports undefined identifiers at the configured severity', async () => {
    const steps = [{ path: 'browser/A.sys.mjs', after: 'export const v = missingName;\n' }];
    expect((await typeFindings(steps, checkJs())).map((f) => f[2])).toEqual(['warning']);
    expect(
      (await typeFindings(steps, checkJs({ undefinedIdentifiers: 'error' }))).map((f) => f[2])
    ).toEqual(['error']);
    expect(await typeFindings(steps, checkJs({ undefinedIdentifiers: 'off' }))).toEqual([]);
  });

  it('knows the Firefox globals, types Cu closed, and leaves unresolved URL imports any', async () => {
    const source = [
      'import { Thing } from "resource:///modules/Upstream.sys.mjs";',
      'const lazy = {};',
      'ChromeUtils.defineESModuleGetters(lazy, { X: "resource://gre/modules/X.sys.mjs" });',
      'export const a = Services.prefs.getBoolPref("x") && new Thing() && new Localization(["a.ftl"], true);',
      'export const b = Cu.now();',
    ].join('\n');
    const findings = await typeFindings([{ path: 'browser/A.sys.mjs', after: source }], strict());
    expect(findings.map((f) => f[3])).toEqual([
      "TS2339: Property 'now' does not exist on type 'CuShim'.",
    ]);
  });

  it('flags implicit any only under strict, noting an unresolved URL import', async () => {
    const source =
      'import { list } from "resource:///modules/Up.sys.mjs";\nexport function f(x) { return list.map((y) => y); }\n';
    const steps = [{ path: 'browser/A.sys.mjs', after: source }];
    expect(await typeFindings(steps, checkJs())).toEqual([]);
    const findings = await typeFindings(steps, strict());
    expect(findings.map((f) => f[3].slice(0, 6))).toEqual(['TS7006', 'TS7006']);
    expect(findings[0]?.[3]).toContain(
      'resource:///modules/Up.sys.mjs resolves to no owned module here'
    );
  });

  it('resolves imports between created modules, so types and missing exports flow', async () => {
    const steps = [
      {
        path: 'browser/modules/Lib.sys.mjs',
        after:
          '/**\n * @template T\n * @param {T} v\n * @returns {T}\n */\nexport function id(v) { return v; }\n',
      },
      {
        path: 'browser/A.sys.mjs',
        after: [
          'import { id, gone } from "resource:///modules/Lib.sys.mjs";',
          '/** @type {string} */',
          'export const s = id(1);',
        ].join('\n'),
      },
    ];
    const findings = await typeFindings(steps, strict());
    expect(findings.map((f) => [f[1], f[3].slice(0, 6)])).toEqual([
      [1, 'TS2305'],
      [3, 'TS2322'],
    ]);
  });

  it('honours the project shim, inlining its references, and refuses a missing one', async () => {
    await writeTree(dir(), {
      'types/extra.d.ts':
        '/// <reference path="./more.d.ts" />\ninterface ChromeUtilsShim { newApi(): number; }\n',
      'types/more.d.ts': 'declare var gMine: { ready: boolean };\n',
    });
    const steps = [
      {
        path: 'browser/A.sys.mjs',
        after: 'export const a = ChromeUtils.newApi() + (gMine.ready ? 1 : 0);\n',
      },
    ];
    expect(await typeFindings(steps, strict({ checkJsExtraShim: 'types/extra.d.ts' }))).toEqual([]);
    await expect(
      typeFindings(steps, strict({ checkJsExtraShim: 'types/gone.d.ts' }))
    ).rejects.toThrow('The TypeScript shim types/gone.d.ts does not exist.');
  });

  it('types Lit only under litTypes', async () => {
    const source = [
      'import { MozLitElement } from "chrome://global/content/lit-utils.mjs";',
      '/** A widget. */',
      'export class W extends MozLitElement {',
      '  /** Updates. */',
      '  go() { this.requestUpdatee(); }',
      '}',
    ].join('\n');
    const steps = [{ path: 'toolkit/W.sys.mjs', after: source }];
    expect(await typeFindings(steps, strict())).toEqual([]);
    expect(
      (await typeFindings(steps, strict({ litTypes: true }))).map((f) => f[3].slice(0, 6))
    ).toEqual(['TS2551']);
  });

  it('reads the targets of a reviewed paths mapping from the engine', async () => {
    const options = { paths: { 'resource://gre/modules/*': ['toolkit/modules/*'] } };
    const steps = [
      {
        path: 'browser/A.sys.mjs',
        after:
          'import { up } from "resource://gre/modules/Up.sys.mjs";\n/** @type {string} */\nexport const s = up;\n',
      },
    ];
    const engine = {
      'toolkit/modules/Up.sys.mjs': '/** @type {number} */\nexport const up = 1;\n',
    };
    const findings = await typeFindings(steps, strict({ checkJsCompilerOptions: options }), engine);
    expect(findings.map((f) => f[3].slice(0, 6))).toEqual(['TS2322']);
  });
});

describe('checkJs over created test scripts', () => {
  it('checks each test with its directory heads and the harness globals', async () => {
    const steps = [
      {
        path: 'browser/tests/head.js',
        after: '/** @returns {number} */\nfunction helper() { return 1; }\n',
      },
      {
        path: 'browser/tests/browser_a.js',
        after:
          'add_task(async () => {\n  /** @type {string} */\n  const s = helper();\n  ok(s);\n});\n',
      },
      {
        path: 'browser/tests/browser_b.js',
        after: 'add_task(async () => { is(helper(), 1); });\n',
      },
    ];
    const findings = await typeFindings(steps, checkJs({ checkJsTestFiles: true }));
    expect(findings.map((f) => [f[0], f[3].slice(0, 6)])).toEqual([
      ['browser/tests/browser_a.js', 'TS2322'],
    ]);
  });
});

describe('the result cache', () => {
  it('answers an unchanged program and rebuilds a changed one', async () => {
    const cacheDir = join(dir(), 'cache');
    const config = testConfig(checkJs());
    const steps = (value: string): ChangeSet =>
      textChangeSet([
        { path: 'browser/A.sys.mjs', after: `/** @type {number} */\nexport const n = ${value};\n` },
      ]);
    const run = (value: string): Promise<Finding[]> =>
      checkOwnedTypes(steps(value), engineFiles(), config, { projectRoot: dir(), cacheDir });
    expect(await run('"a"')).toHaveLength(1);
    expect((await listDir(cacheDir)).length).toBe(1);
    expect(await run('"a"')).toHaveLength(1);
    expect(await run('1')).toEqual([]);
    expect((await listDir(cacheDir)).length).toBe(1);
  });
});

describe('explainOwnedTypes', () => {
  it('names the program a file is checked in and how its imports resolve', async () => {
    const changes = textChangeSet([
      { path: 'browser/modules/Lib.sys.mjs', after: 'export const x = 1;\n' },
      {
        path: 'browser/A.sys.mjs',
        after: 'import "resource:///modules/Lib.sys.mjs";\nimport "chrome://x/content/up.mjs";\n',
      },
      { path: 'browser/up.js', before: 'a', after: 'b' },
    ]);
    const config = testConfig(checkJs());
    const view = await explainOwnedTypes(
      changes,
      engineFiles(),
      config,
      { projectRoot: dir() },
      'browser/A.sys.mjs'
    );
    expect(view).toEqual({
      program: 'module',
      heads: [],
      imports: [
        { specifier: 'chrome://x/content/up.mjs', resolution: 'any' },
        {
          specifier: 'resource:///modules/Lib.sys.mjs',
          resolution: 'owned',
          target: 'browser/modules/Lib.sys.mjs',
        },
      ],
    });
    const upstream = await explainOwnedTypes(
      changes,
      engineFiles(),
      config,
      { projectRoot: dir() },
      'browser/up.js'
    );
    expect(upstream.reason).toBe(
      'the project modifies this upstream file; only files it creates are checked'
    );
  });
});
