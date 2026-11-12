// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { TextStep } from '../../testing/changes.js';
import { lintSteps } from '../../testing/lint.js';
import { hasAssertion, misnamedObserverTopics } from './javascript.js';
import { documentedParams, moduleJsDocProblems, scriptJsDocProblems } from './jsdoc.js';

describe('hasAssertion', () => {
  it.each([
    ['add_task(() => { Assert.equal(1, 1); });', true],
    ['add_task(() => { ok(true, "fine"); });', true],
    ['add_task(() => { window.is(a, b); });', true],
    ['add_task(() => { SimpleTest.isDeeply(a, b); });', true],
    ['add_task(() => { /* Assert.equal(1, 1); */ });', false],
    ['add_task(() => { info("the tab is (not) loaded"); });', false],
    ['function is(a, b) {}\nadd_task(() => { is(1, 1); });', false],
    ['add_task(() => { SimpleTest.finish(); SpecialPowers.ok(1); });', false],
    ['#if X\nok(true);\n#endif', true],
  ])('%j -> %s', (source, expected) => {
    expect(hasAssertion(source)).toBe(expected);
  });
});

describe('misnamedObserverTopics', () => {
  it.each([
    ['Services.obs.notifyObservers(null, "mine-update");', ['mine-update']],
    ['Services.obs.notifyObservers(null, "mine-tab-opened");', []],
    ['Services.obs.addObserver(this, "profile-after-change");', []],
    ['Services.obs.addObserver(this, "quit-application-granted");', []],
    ['Services.obs.addObserver(this, `mine-${x}`);', []],
    ['Services.obs.addObserver(\n  this,\n  "mineready"\n);', ['mineready']],
    ['// Services.obs.addObserver(this, "mineready");', []],
    ['Services.obs.addObserver(/[(]/.test(s) ? a : b, "mineready");', ['mineready']],
    ['#ifdef X\nServices.obs.notifyObservers(null, "mineready");\n#endif', ['mineready']],
  ])('%j -> %j', (source, topics) => {
    expect(misnamedObserverTopics(source, 'mine').map((entry) => entry.topic)).toEqual(topics);
  });
});

describe('JSDoc', () => {
  it('reads documented parameter names through nested types and defaults', () => {
    expect(
      documentedParams(
        '* @param {{ id: string, args?: Record<string, boolean> }} opts\n * @param [b=1] - x\n * @param opts.id'
      )
    ).toEqual(['opts', 'b']);
  });

  it.each([
    [
      '/** Adds. @param {number} a @param {number} b @returns {number} */\nexport function add(a, b) { return a + b; }',
      [],
    ],
    [
      'export function add(a, b) { return a + b; }',
      ['Function "add" at line 1 has no JSDoc comment.'],
    ],
    [
      '/** Adds. @param a */\nexport function add(a, b) { return a + b; }',
      [
        'Function "add" at line 2: @param "b" is missing or misnamed in its JSDoc.',
        'Function "add" at line 2 returns a value but its JSDoc has no @returns.',
      ],
    ],
    ['/** Run. */\nexport function run({ a }, ...rest) { function inner() { return 1; } }', []],
    ['export const LIMIT = 4;', ['Constant "LIMIT" at line 1 has no JSDoc comment.']],
    ['/** Thing. */\nclass Thing {}\nexport { Thing };', []],
    ['class Thing {}\nexport { Thing };', ['Class "Thing" at line 1 has no JSDoc comment.']],
    [
      'export function broken( {',
      ['The module did not parse, so its JSDoc was not checked: Unexpected token (1:25)'],
    ],
  ])('module %j', (source, messages) => {
    expect(
      moduleJsDocProblems(source)
        .filter((p) => !p.classMethod)
        .map((p) => p.message)
    ).toEqual(messages);
  });

  it('tags the methods of exported classes, skipping private and trivial ones', () => {
    const source = [
      '/** A widget. */',
      'export class Widget {',
      '  constructor() {}',
      '  #secret() {}',
      '  _internal() {}',
      '  /** @private */',
      '  hidden(a) {}',
      '  get size() { return 1; }',
      '  /** Sets. @param v */',
      '  set size(v) {}',
      '  /** Grows. */',
      '  grow(by) { return by; }',
      '}',
    ].join('\n');
    expect(moduleJsDocProblems(source).map((p) => [p.classMethod, p.message])).toEqual([
      [true, 'Getter "Widget.size" at line 8 has no JSDoc comment.'],
      [true, 'Method "Widget.grow" at line 12: @param "by" is missing or misnamed in its JSDoc.'],
      [true, 'Method "Widget.grow" at line 12 returns a value but its JSDoc has no @returns.'],
    ]);
  });

  it('checks the top-level declarations of a script and declines module syntax', () => {
    expect(scriptJsDocProblems('function go() {}\nvar x = 1;')?.map((p) => p.message)).toEqual([
      'Function "go" at line 1 has no JSDoc comment.',
    ]);
    expect(scriptJsDocProblems('import x from "y";')).toBeUndefined();
  });
});

describe('the JavaScript rules over owned changes', () => {
  const upstream = 'const a = 1;\nimport { b } from "./upstream.mjs";\n';

  it('judges a modified file on the lines it adds and a created file whole', async () => {
    const findings = await lintSteps(
      ['relative-import'],
      [
        { path: 'browser/a.mjs', before: upstream, after: `${upstream}const c = 2;\n` },
        { path: 'browser/b.mjs', before: upstream, after: `${upstream}import "./mine.mjs";\n` },
        { path: 'browser/new.mjs', after: 'import "./x.mjs";\n' },
      ]
    );
    expect(findings.map((f) => [f.path, f.line])).toEqual([
      ['browser/b.mjs', 3],
      ['browser/new.mjs', 1],
    ]);
  });

  it('asks an upstream edit for the marker comment', async () => {
    const steps = (added: string): TextStep[] => [
      { path: 'browser/a.js', before: 'a();\n', after: `a();\n${added}\n` },
    ];
    expect(await lintSteps(['missing-modification-comment'], steps('b();'))).toHaveLength(1);
    expect(await lintSteps(['missing-modification-comment'], steps('b(); // MINE: why'))).toEqual(
      []
    );
  });

  it('holds created modules to jsdoc and leaves modified ones alone', async () => {
    const findings = await lintSteps(
      ['jsdoc', 'jsdoc-class-method'],
      [
        { path: 'browser/A.sys.mjs', after: 'export function a(x) {}\n' },
        { path: 'browser/B.sys.mjs', before: '', after: 'export function b() {}\n' },
      ]
    );
    expect(findings.map((f) => [f.rule, f.path, f.severity])).toEqual([
      ['jsdoc', 'browser/A.sys.mjs', 'error'],
    ]);
  });

  it('runs the opt-in rules only when patchLint.rules turns them on', async () => {
    const steps = [
      { path: 'browser/base/content/mine.js', after: 'function go() {}\n' },
      { path: 'browser/components/tests/browser/browser_mine.js', after: 'add_task(() => {});\n' },
      { path: 'browser/M.sys.mjs', after: '/** M. */\nexport class M {\n  run(a) {}\n}\n' },
    ];
    const rules = ['chrome-script-jsdoc', 'test-needs-assertion', 'jsdoc-class-method'];
    expect(await lintSteps(rules, steps)).toEqual([]);
    const on = {
      patchLint: {
        rules: {
          'chrome-script-jsdoc': 'warning',
          'test-needs-assertion': 'error',
          'jsdoc-class-method': 'warning',
        },
      },
    };
    const findings = await lintSteps(rules, steps, { config: on });
    expect(findings.map((f) => [f.rule, f.path, f.severity])).toEqual([
      ['jsdoc-class-method', 'browser/M.sys.mjs', 'warning'],
      ['chrome-script-jsdoc', 'browser/base/content/mine.js', 'warning'],
      ['test-needs-assertion', 'browser/components/tests/browser/browser_mine.js', 'error'],
    ]);
  });

  it('holds a modified browser test to the assertion floor too', async () => {
    const findings = await lintSteps(
      ['test-needs-assertion'],
      [{ path: 'dom/tests/browser_x.js', before: 'ok(true);\n', after: 'info("x");\n' }],
      { config: { patchLint: { rules: { 'test-needs-assertion': 'error' } } } }
    );
    expect(findings).toHaveLength(1);
  });
});
