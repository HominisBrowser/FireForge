// SPDX-License-Identifier: EUPL-1.2
/**
 * AST-based JSDoc validation for top-level declarations in patch-owned
 * chrome subscripts (`browser/base/content/<binaryName>*.js` and similar
 * `.js` files loaded via `Services.scriptloader.loadSubScript`).
 *
 * Why a separate module from {@link ./patch-lint-jsdoc.ts}: chrome
 * subscripts are not ES modules. They are parsed as scripts (no static
 * `export`) and their top-level `class`/`function` declarations are
 * exposed to the loading window as globals rather than declared exports.
 * The export-walker in `patch-lint-jsdoc.ts` would never visit them.
 *
 * The rule shape is identical to the `.sys.mjs` rule once you remove the
 * `export` framing: every top-level class needs a JSDoc, every method
 * needs one when `chromeScriptJsDoc` is at `warning`/`error`, and every
 * top-level function needs a matching @param/@returns block. So the
 * per-declaration validators are reused verbatim from the export module.
 */

import type * as acorn from 'acorn';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { PatchLintSeverityGate } from '../types/config.js';
import type { AcornESTreeNode } from './ast-utils.js';
import { parseScript } from './ast-utils.js';
import type { JsDocIssue, ValidateExportJsDocOptions } from './patch-lint-jsdoc.js';
import {
  validateClassDecl,
  validateClassMethods,
  validateFunctionDecl,
} from './patch-lint-jsdoc.js';

/**
 * Validates JSDoc on top-level declarations in a chrome-subscript `.js`
 * source file. A parse failure returns an empty issue list. Chrome
 * subscripts that use module-only syntax (rare) silently disable the
 * rule rather than emitting confusing parse-error issues.
 *
 * @param source - File content
 * @param options - Optional gates (e.g. class-method JSDoc severity).
 *   `classMethodMode` defaults to `'off'`. The orchestrator passes the
 *   `chromeScriptJsDoc` severity here so a single knob controls both
 *   class-level and method-level enforcement.
 * @returns Array of JSDoc issues found
 */
export function validateChromeScriptJsDoc(
  source: string,
  options?: ValidateExportJsDocOptions
): JsDocIssue[] {
  const classMethodMode = options?.classMethodMode ?? 'off';
  const comments: acorn.Comment[] = [];
  let ast: AcornESTreeNode<import('estree').Program>;
  try {
    ast = parseScript(source, comments);
  } catch {
    // Deliberate carve-out, unlike the `.sys.mjs` walker in
    // `patch-lint-jsdoc.ts` (which reports a parse failure as an issue).
    // `parseScript` rejects `import`/`export`, so a chrome subscript that was
    // misclassified as a `.js` file (or that mistakenly uses module syntax)
    // would emit a pseudo-issue for every rule here. The orchestrator already
    // runs the export walker on `.sys.mjs` separately, so silently declining
    // to lint an unparseable script is the correct degradation for this file
    // and only this file.
    return [];
  }

  const issues: JsDocIssue[] = [];
  const body = ast.body as AcornESTreeNode[];

  for (const node of body) {
    if (node.type === 'FunctionDeclaration') {
      issues.push(...validateFunctionDecl(node, comments, source));
    } else if (node.type === 'ClassDeclaration') {
      issues.push(...validateClassDecl(node, comments, source));
      if (classMethodMode !== 'off') {
        issues.push(...validateClassMethods(node, comments, source, classMethodMode));
      }
    }
    // Top-level `var Foo = class {...}` / `let Foo = function() {...}`
    // patterns are out of scope for V1: chrome subscripts
    // overwhelmingly use bare `class`/`function` declarations and the
    // variable-init form would require unwrapping the initializer. Add
    // it later if a real chrome subscript uses that shape.
  }

  return issues;
}

/**
 * Per-file dispatch: applies the chrome-subscript JSDoc rule to one file if
 * it qualifies, mapping {@link JsDocIssue} into {@link PatchLintIssue}.
 * Returns an empty array when the file does not qualify (not a chrome
 * subscript, not patch-owned, or the mode is `'off'` / unset). The
 * orchestrator pre-computes `isChromeOwned` (true iff the file is a
 * patch-owned `.js` non-`.sys.mjs`) so the call site fits on a single line.
 */
export function lintChromeScriptJsDocForFile(
  file: string,
  content: string,
  isChromeOwned: boolean,
  mode: PatchLintSeverityGate | undefined
): PatchLintIssue[] {
  if (!isChromeOwned || !mode || mode === 'off') return [];
  const jsdocIssues = validateChromeScriptJsDoc(content, { classMethodMode: mode });
  return jsdocIssues.map((issue) => ({
    file,
    check: issue.check,
    message: issue.message,
    severity: issue.severity ?? mode,
  }));
}
