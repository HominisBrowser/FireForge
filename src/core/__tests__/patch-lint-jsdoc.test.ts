// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateExportJsDoc } from '../patch-lint-jsdoc.js';

describe('validateExportJsDoc', () => {
  // ── Missing JSDoc ────────────────────────────────────────────────────

  it('flags export function with no JSDoc', () => {
    const source = 'export function doWork() {\n  return 1;\n}\n';
    const issues = validateExportJsDoc(source);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-jsdoc');
    expect(issues[0]?.message).toContain('doWork');
  });

  it('flags export async function with no JSDoc', () => {
    const source = 'export async function fetchData() {\n  return 1;\n}\n';
    const issues = validateExportJsDoc(source);

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues[0]?.message).toContain('fetchData');
  });

  it('flags export class with no JSDoc', () => {
    const source = 'export class Manager {\n  constructor() {}\n}\n';
    const issues = validateExportJsDoc(source);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-jsdoc');
    expect(issues[0]?.message).toContain('Manager');
  });

  it('flags export const with no JSDoc', () => {
    const source = 'export const MAX_SIZE = 100;\n';
    const issues = validateExportJsDoc(source);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-jsdoc');
    expect(issues[0]?.message).toContain('MAX_SIZE');
  });

  it('flags named export { foo } when declaration lacks JSDoc', () => {
    const source = 'function helper() {\n  return 1;\n}\n\nexport { helper };\n';
    const issues = validateExportJsDoc(source);

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues[0]?.message).toContain('helper');
  });

  it('flags named export { Foo } for class without JSDoc', () => {
    const source = 'class Foo {\n  run() {}\n}\n\nexport { Foo };\n';
    const issues = validateExportJsDoc(source);

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
  });

  it('flags named export { val } for const without JSDoc', () => {
    const source = 'const val = 42;\n\nexport { val };\n';
    const issues = validateExportJsDoc(source);

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
  });

  // ── Param mismatch ──────────────────────────────────────────────────

  it('flags param name mismatch', () => {
    const source = [
      '/**',
      ' * Process data.',
      ' * @param {string} wrong - Wrong name',
      ' */',
      'export function process(input) {',
      '  return input;',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    const paramIssue = issues.find((i) => i.check === 'jsdoc-param-mismatch');

    expect(paramIssue).toBeDefined();
    expect(paramIssue?.message).toContain('input');
  });

  it('flags missing @param for one of multiple parameters', () => {
    const source = [
      '/**',
      ' * Add two numbers.',
      ' * @param {number} a - First number',
      ' * @returns {number} Sum',
      ' */',
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    const paramIssue = issues.find((i) => i.check === 'jsdoc-param-mismatch');

    expect(paramIssue).toBeDefined();
    expect(paramIssue?.message).toContain('b');
  });

  // ── Missing @returns ────────────────────────────────────────────────

  it('flags missing @returns when function returns a value', () => {
    const source = [
      '/**',
      ' * Get the value.',
      ' */',
      'export function getValue() {',
      '  return 42;',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    const returnIssue = issues.find((i) => i.check === 'jsdoc-missing-returns');

    expect(returnIssue).toBeDefined();
  });

  it('does not flag @returns when function has no return value', () => {
    const source = [
      '/**',
      ' * Log a message.',
      ' * @param {string} msg - The message',
      ' */',
      'export function logMessage(msg) {',
      '  console.log(msg);',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues.some((i) => i.check === 'jsdoc-missing-returns')).toBe(false);
  });

  it('accepts @return as alternative to @returns', () => {
    const source = [
      '/**',
      ' * Get value.',
      ' * @return {number} The value',
      ' */',
      'export function getValue() {',
      '  return 42;',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues.some((i) => i.check === 'jsdoc-missing-returns')).toBe(false);
  });

  // ── Constants require only a JSDoc block (no @type needed) ──────────

  it('passes export const with description-only JSDoc', () => {
    const source = [
      '/** Maximum retries for the operation. */',
      'export const MAX_RETRIES = 3;',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues).toHaveLength(0);
  });

  it('passes export const singleton object with module-style JSDoc', () => {
    const source = [
      '/**',
      ' * Central coordinator for flush cycles.',
      ' */',
      'export const FlushManager = {',
      '  start() {},',
      '};',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues).toHaveLength(0);
  });

  // ── All-correct file ────────────────────────────────────────────────

  it('returns no issues for a fully documented file', () => {
    const source = [
      '/**',
      ' * Initialise the sidebar.',
      ' * @param {Window} win - The browser window',
      ' * @returns {boolean} Whether init succeeded',
      ' */',
      'export function initSidebar(win) {',
      '  return true;',
      '}',
      '',
      '/** Sidebar manager. */',
      'export class SidebarManager {',
      '  open() {}',
      '}',
      '',
      '/** Sidebar width in pixels. */',
      'export const SIDEBAR_WIDTH = 300;',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues for named exports with documented declarations', () => {
    const source = [
      '/**',
      ' * Helper function.',
      ' * @returns {string} A greeting',
      ' */',
      'function greet() {',
      '  return "hi";',
      '}',
      '',
      '/** Current version. */',
      'const VERSION = 1;',
      '',
      'export { greet, VERSION };',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues).toHaveLength(0);
  });

  // ── Re-exports from other modules (should be skipped) ───────────────

  it('ignores re-exports from other modules', () => {
    const source = 'export { Foo } from "./other.mjs";\n';
    const issues = validateExportJsDoc(source);

    expect(issues).toHaveLength(0);
  });

  // ── Parse error resilience ──────────────────────────────────────────

  it('reports a parse failure instead of silently passing the file', () => {
    // `[]` is the same value as "fully documented", so returning it here made
    // an unparseable .sys.mjs clear every rule in this module. A source that
    // cannot be analysed has not passed analysis.
    const source = 'export function { broken syntax\n';
    const issues = validateExportJsDoc(source);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 1, check: 'jsdoc-unparseable-source' });
    expect(issues[0]?.message).toMatch(/could not be parsed for JSDoc analysis/);
  });

  // ── Line numbers ────────────────────────────────────────────────────

  it('reports correct line numbers', () => {
    const source = ['', '', 'export function atLineThree() {', '  return 1;', '}', ''].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues[0]?.line).toBe(3);
  });

  // ── Bare return statement (no argument) ─────────────────────────────

  it('does not require @returns for bare return statements', () => {
    const source = [
      '/**',
      ' * Early exit function.',
      ' * @param {boolean} flag - The flag',
      ' */',
      'export function maybeExit(flag) {',
      '  if (flag) return;',
      '  console.log("continuing");',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues.some((i) => i.check === 'jsdoc-missing-returns')).toBe(false);
  });

  // ── Nested function returns do not affect outer ─────────────────────

  it('does not require @returns when only a nested function returns', () => {
    const source = [
      '/**',
      ' * Set up handler.',
      ' * @param {object} target - The target',
      ' */',
      'export function setup(target) {',
      '  target.handler = function() { return 42; };',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source);
    expect(issues.some((i) => i.check === 'jsdoc-missing-returns')).toBe(false);
  });
});

describe('validateExportJsDoc — class-method enforcement', () => {
  // Common scaffold: a documented exported class with one method body to vary.
  const wrapClass = (methodLines: string[]): string =>
    ['/** Storage class. */', 'export class Store {', ...methodLines, '}', ''].join('\n');

  it('passes a class with one fully documented method', () => {
    const source = wrapClass([
      '  /**',
      '   * Save a value.',
      '   * @param {string} key - The key',
      '   * @returns {boolean} Whether save succeeded',
      '   */',
      '  save(key) {',
      '    return true;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(0);
  });

  it('flags method missing JSDoc as missing-jsdoc-class-method', () => {
    const source = wrapClass(['  save(key) {', '    return true;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const methodIssues = issues.filter((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssues).toHaveLength(1);
    expect(methodIssues[0]?.message).toContain('Store.save');
  });

  it('flags @param name mismatch on a class method', () => {
    const source = wrapClass([
      '  /**',
      '   * Save.',
      '   * @param {string} wrong - Wrong name',
      '   */',
      '  save(key) {',
      '    void key;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const paramIssues = issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch');
    expect(paramIssues).toHaveLength(1);
    expect(paramIssues[0]?.message).toContain('key');
  });

  it('accepts inline object types with nested generics in @param', () => {
    // The exact reported doc shape: nested braces inside the type used to
    // truncate the flat-regex scan at the first inner "}", losing the
    // param name and firing "@param message missing or misnamed".
    const source = wrapClass([
      '  /**',
      '   * Send a message.',
      '   * @param {{ id: string, args?: Record<string, string | number | boolean> }} message - The message',
      '   * @returns {boolean} Whether send succeeded',
      '   */',
      '  send(message) {',
      '    return Boolean(message);',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch')).toHaveLength(0);
  });

  it('accepts optional and defaulted bracket params after a braced type', () => {
    const source = wrapClass([
      '  /**',
      '   * Lookup.',
      '   * @param {{ depth?: number }} [opts={}] - Options',
      '   * @returns {number} Result',
      '   */',
      '  lookup(opts) {',
      '    return Number(opts);',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch')).toHaveLength(0);
  });

  it('still flags a genuinely misnamed param after a nested-brace type', () => {
    const source = wrapClass([
      '  /**',
      '   * Send.',
      '   * @param {{ id: string, args?: Record<string, boolean> }} wrong - Wrong name',
      '   * @returns {boolean} Whether ok',
      '   */',
      '  send(message) {',
      '    return Boolean(message);',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const paramIssues = issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch');
    expect(paramIssues).toHaveLength(1);
    expect(paramIssues[0]?.message).toContain('message');
  });

  it('does not crash on an unterminated brace type and reports the missing param', () => {
    const source = wrapClass([
      '  /**',
      '   * Broken doc.',
      '   * @param {{ id: string message - Truncated type',
      '   * @returns {boolean} Whether ok',
      '   */',
      '  send(message) {',
      '    return Boolean(message);',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues.some((i) => i.check === 'jsdoc-class-method-param-mismatch')).toBe(true);
  });

  it('matches dotted property docs through their base name', () => {
    const source = wrapClass([
      '  /**',
      '   * Configure.',
      '   * @param {object} opts - Options bag',
      '   * @param {string} opts.id - Identifier',
      '   * @returns {boolean} Whether ok',
      '   */',
      '  configure(opts) {',
      '    return Boolean(opts);',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch')).toHaveLength(0);
  });

  it('flags missing @returns on a class method that returns a value', () => {
    const source = wrapClass([
      '  /**',
      '   * Get value.',
      '   * @param {string} key - The key',
      '   */',
      '  get(key) {',
      '    return key;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const returnIssues = issues.filter((i) => i.check === 'jsdoc-class-method-missing-returns');
    expect(returnIssues).toHaveLength(1);
  });

  it('skips methods whose name starts with an underscore', () => {
    const source = wrapClass(['  _helper() {', '    return 1;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(0);
  });

  it('skips private-syntax methods (#name)', () => {
    const source = wrapClass(['  #helper() {', '    return 1;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(0);
  });

  it('skips methods with @private in JSDoc', () => {
    const source = wrapClass([
      '  /**',
      '   * Internal.',
      '   * @private',
      '   */',
      '  helper(arg) {',
      '    return arg;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(0);
  });

  it('skips methods with @internal in JSDoc', () => {
    const source = wrapClass([
      '  /**',
      '   * Internal.',
      '   * @internal',
      '   */',
      '  helper(arg) {',
      '    return arg;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(0);
  });

  it('skips zero-parameter constructor without JSDoc', () => {
    const source = wrapClass(['  constructor() {}']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(0);
  });

  it('flags constructor with parameter missing @param', () => {
    const source = wrapClass([
      '  /**',
      '   * Build a store.',
      '   */',
      '  constructor(opts) {',
      '    this.opts = opts;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const paramIssues = issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch');
    expect(paramIssues).toHaveLength(1);
    expect(paramIssues[0]?.message).toContain('opts');
  });

  it('flags getter without JSDoc with only missing-jsdoc-class-method', () => {
    const source = wrapClass(['  get size() {', '    return 0;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-jsdoc-class-method');
    expect(issues[0]?.message).toContain('getter');
  });

  it('flags setter missing @param for its parameter', () => {
    const source = wrapClass([
      '  /**',
      '   * Set width.',
      '   */',
      '  set width(value) {',
      '    this._w = value;',
      '  }',
    ]);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const paramIssues = issues.filter((i) => i.check === 'jsdoc-class-method-param-mismatch');
    expect(paramIssues).toHaveLength(1);
    expect(paramIssues[0]?.message).toContain('value');
    expect(issues.some((i) => i.check === 'jsdoc-class-method-missing-returns')).toBe(false);
  });

  it('flags static method missing JSDoc', () => {
    const source = wrapClass(['  static factory() {', '    return new Store();', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const methodIssues = issues.filter((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssues).toHaveLength(1);
    expect(methodIssues[0]?.message).toContain('static method');
  });

  it('emits no class-method issues when classMethodMode is absent', () => {
    const source = wrapClass(['  save(key) {', '    return key;', '  }']);

    const issues = validateExportJsDoc(source);
    expect(issues.filter((i) => i.check.startsWith('missing-jsdoc-class-method'))).toHaveLength(0);
    expect(issues.filter((i) => i.check.includes('class-method'))).toHaveLength(0);
  });

  it("emits no class-method issues when classMethodMode is 'off'", () => {
    const source = wrapClass(['  save(key) {', '    return key;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'off' });
    expect(issues.filter((i) => i.check.includes('class-method'))).toHaveLength(0);
  });

  it("emits class-method issues at severity 'warning' when knob is 'warning'", () => {
    const source = wrapClass(['  save(key) {', '    return key;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'warning' });
    const methodIssues = issues.filter((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssues).toHaveLength(1);
    expect(methodIssues[0]?.severity).toBe('warning');
  });

  it("emits class-method issues at severity 'error' when knob is 'error'", () => {
    const source = wrapClass(['  save(key) {', '    return key;', '  }']);

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const methodIssues = issues.filter((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssues).toHaveLength(1);
    expect(methodIssues[0]?.severity).toBe('error');
  });

  it('reports the method line, not the class line', () => {
    const source = [
      '/** Storage. */',
      'export class Store {',
      '',
      '',
      '  save(key) {',
      '    return key;',
      '  }',
      '}',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    const methodIssue = issues.find((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssue?.line).toBe(5);
  });

  it('walks methods on classes exported via named-export specifier', () => {
    const source = [
      '/** Store. */',
      'class Store {',
      '  save(key) {',
      '    return key;',
      '  }',
      '}',
      '',
      'export { Store };',
      '',
    ].join('\n');

    const issues = validateExportJsDoc(source, { classMethodMode: 'error' });
    expect(issues.some((i) => i.check === 'missing-jsdoc-class-method')).toBe(true);
  });
});
