// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { documentedParams, moduleJsDocProblems, scriptJsDocProblems } from './jsdoc.js';

const messages = (problems: readonly { message: string }[] | undefined): string[] =>
  (problems ?? []).map((problem) => problem.message);

describe('documentedParams', () => {
  it.each([
    ['@param {number} a - A', ['a']],
    ['@param a\n@param {string} b', ['a', 'b']],
    [
      '@param {{ x: { y: number } }} opts - nested braces\n@param {object} opts.id - field',
      ['opts'],
    ],
    ['@param {number} [a=1] - optional', ['a']],
    ['@param {"}"} quoted - a quoted brace in the type', ['quoted']],
    ['@param {number broken', []],
  ])('%j documents %j', (doc, names) => {
    expect(documentedParams(doc)).toEqual(names);
  });
});

describe('moduleJsDocProblems', () => {
  it('accepts documented exports, export lists and the parameters it does not judge', () => {
    const source = [
      '/**',
      ' * Adds.',
      ' * @param {number} a - A',
      ' * @param {number} b - B',
      ' * @returns {number} sum',
      ' */',
      'export function add(a, b) { return a + b; }',
      '/** Destructured, defaulted and rest parameters are not judged. */',
      'export function f({ a }, b = 1, ...rest) {}',
      '/** @returns {number} r */',
      'function g() { return 1; }',
      'export { g };',
      '/** A constant. */',
      'export const Z = 1;',
      '/** Inner returns do not count. */',
      'export function h() { const f = () => { return 1; }; f(); }',
    ].join('\n');
    expect(moduleJsDocProblems(source)).toEqual([]);
  });

  it('reports missing JSDoc, a missing or misnamed @param and a missing @returns, with lines', () => {
    const source = [
      'export function bare() {}',
      '/** @param {number} y - wrong name */',
      'export function misnamed(x) {}',
      '/** No returns tag. */',
      'export function gives() { if (1) { return 2; } }',
      'export const a = 1, b = 2;',
      '/* A plain block comment is not JSDoc. */',
      'export class C {}',
    ].join('\n');
    expect(moduleJsDocProblems(source)).toEqual([
      { line: 1, classMethod: false, message: 'Function "bare" at line 1 has no JSDoc comment.' },
      {
        line: 3,
        classMethod: false,
        message: 'Function "misnamed" at line 3: @param "x" is missing or misnamed in its JSDoc.',
      },
      {
        line: 5,
        classMethod: false,
        message: 'Function "gives" at line 5 returns a value but its JSDoc has no @returns.',
      },
      { line: 6, classMethod: false, message: 'Constant "a" at line 6 has no JSDoc comment.' },
      { line: 6, classMethod: false, message: 'Constant "b" at line 6 has no JSDoc comment.' },
      { line: 8, classMethod: false, message: 'Class "C" at line 8 has no JSDoc comment.' },
    ]);
  });

  it('judges class methods as class-method problems, skipping private, internal and getters', () => {
    const source = [
      '/** A class. */',
      'export class C {',
      '  constructor(a) {}',
      '  /** @param {number} n - n */',
      '  static make(n) { return n; }',
      '  get value() { return 1; }',
      '  /** Doc. */',
      '  get documented() { return 1; }',
      '  _hidden() {}',
      '  /** @internal */',
      '  internal(x) {}',
      '  /** Setter. */',
      '  set value(v) {}',
      '}',
    ].join('\n');
    const problems = moduleJsDocProblems(source);
    expect(problems.every((problem) => problem.classMethod)).toBe(true);
    expect(messages(problems)).toEqual([
      'Constructor of class "C" at line 3 has no JSDoc comment.',
      'Static Method "C.make" at line 5 returns a value but its JSDoc has no @returns.',
      'Getter "C.value" at line 6 has no JSDoc comment.',
      'Setter "C.value" at line 13: @param "v" is missing or misnamed in its JSDoc.',
    ]);
  });

  it('reports source that does not parse as one problem', () => {
    expect(messages(moduleJsDocProblems('export function ('))[0]).toMatch(
      /^The module did not parse, so its JSDoc was not checked: /
    );
  });
});

describe('scriptJsDocProblems', () => {
  it('judges top-level functions and classes of a script, not its constants or nested functions', () => {
    const source = [
      'var gThing = 1;',
      'function load() { function inner() {} }',
      '/** Documented. */',
      'class Panel {}',
    ].join('\n');
    expect(messages(scriptJsDocProblems(source))).toEqual([
      'Function "load" at line 2 has no JSDoc comment.',
    ]);
  });

  it('is undefined for source that is not a script', () => {
    expect(scriptJsDocProblems('import x from "y";')).toBeUndefined();
  });
});
