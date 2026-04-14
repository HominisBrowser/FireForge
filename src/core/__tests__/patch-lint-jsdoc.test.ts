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

  it('returns empty on parse error', () => {
    const source = 'export function { broken syntax\n';
    const issues = validateExportJsDoc(source);

    expect(issues).toHaveLength(0);
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
