// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateChromeScriptJsDoc } from '../patch-lint-chrome-jsdoc.js';

describe('validateChromeScriptJsDoc', () => {
  // ── Top-level class declarations ──────────────────────────────────────

  it('flags a top-level class with no JSDoc (script form, no export keyword)', () => {
    // Chrome subscripts use bare `class` declarations rather than ES module
    // exports — the rule must visit them anyway, since they are exposed as
    // globals on the loading window via Services.scriptloader.loadSubScript.
    const source = 'class MyBrowserDock {\n  constructor() {}\n}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-jsdoc');
    expect(issues[0]?.message).toContain('MyBrowserDock');
  });

  it('does not flag a top-level class that has a JSDoc comment attached', () => {
    const source = '/** Dock controller for the mybrowser chrome. */\nclass MyBrowserDock {\n}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues.filter((i) => i.check === 'missing-jsdoc')).toHaveLength(0);
  });

  // ── Top-level function declarations ───────────────────────────────────

  it('flags a top-level function with no JSDoc', () => {
    const source = 'function init() {\n  return 1;\n}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues[0]?.message).toContain('init');
  });

  it('flags @param mismatches on a documented top-level function', () => {
    const source =
      '/**\n * Initialise the dock.\n * @param wrong - some doc\n */\nfunction init(host) {}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues.some((i) => i.check === 'jsdoc-param-mismatch')).toBe(true);
  });

  it('flags missing @returns on a documented function that returns a value', () => {
    const source =
      '/**\n * Compute id.\n * @param host - host\n */\nfunction makeId(host) {\n  return host + "-id";\n}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues.some((i) => i.check === 'jsdoc-missing-returns')).toBe(true);
  });

  // ── Class-method gating (chromeScriptJsDoc severity) ──────────────────

  it("does not visit class methods when classMethodMode is 'off' (default)", () => {
    const source = '/** Dock. */\nclass MyBrowserDock {\n  attach(host) { return host; }\n}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues.some((i) => i.check === 'missing-jsdoc-class-method')).toBe(false);
  });

  it("flags methods missing JSDoc at the configured severity when classMethodMode='warning'", () => {
    const source = '/** Dock. */\nclass MyBrowserDock {\n  attach(host) { return host; }\n}\n';
    const issues = validateChromeScriptJsDoc(source, { classMethodMode: 'warning' });

    const methodIssue = issues.find((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssue).toBeDefined();
    expect(methodIssue?.severity).toBe('warning');
    expect(methodIssue?.message).toContain('MyBrowserDock');
    expect(methodIssue?.message).toContain('attach');
  });

  it('does not flag fully documented class methods', () => {
    const source =
      '/** Dock. */\nclass MyBrowserDock {\n  /** Attach to host.\n   * @param host - host id\n   * @returns Host id\n   */\n  attach(host) { return host; }\n}\n';
    const issues = validateChromeScriptJsDoc(source, { classMethodMode: 'warning' });

    expect(issues).toHaveLength(0);
  });

  it('skips underscore-prefixed methods (treated as private convention)', () => {
    const source = '/** Dock. */\nclass MyBrowserDock {\n  _internal(host) { return host; }\n}\n';
    const issues = validateChromeScriptJsDoc(source, { classMethodMode: 'warning' });

    expect(issues.some((i) => i.check === 'missing-jsdoc-class-method')).toBe(false);
  });

  it('skips zero-parameter constructors', () => {
    const source = '/** Dock. */\nclass MyBrowserDock {\n  constructor() {}\n}\n';
    const issues = validateChromeScriptJsDoc(source, { classMethodMode: 'warning' });

    expect(issues.some((i) => i.check === 'missing-jsdoc-class-method')).toBe(false);
  });

  // ── Parser-mode boundary ──────────────────────────────────────────────

  it('returns no issues when the source uses module-only syntax (parse failure)', () => {
    // Chrome subscripts that mistakenly use `import`/`export` should NOT
    // emit pseudo-issues — they should silently disable the rule (parse
    // returns no AST). The orchestrator runs the export-walker rule on
    // `.sys.mjs` separately, so this carve-out only affects `.js` files
    // that were misclassified.
    const source = 'import { Foo } from "./bar.js";\nclass Baz {}\n';
    const issues = validateChromeScriptJsDoc(source);

    expect(issues).toEqual([]);
  });

  it('handles mixed top-level class + function in one file', () => {
    const source = 'class Dock {}\n\nfunction tile(host) { return host; }\n';
    const issues = validateChromeScriptJsDoc(source);

    // Both declarations missing JSDoc — expect two missing-jsdoc issues.
    const missing = issues.filter((i) => i.check === 'missing-jsdoc');
    expect(missing).toHaveLength(2);
    const messages = missing.map((i) => i.message).join('\n');
    expect(messages).toContain('Dock');
    expect(messages).toContain('tile');
  });
});
