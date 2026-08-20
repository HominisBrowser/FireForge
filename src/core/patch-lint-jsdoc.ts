// SPDX-License-Identifier: EUPL-1.2
/**
 * AST-based JSDoc validation for exported declarations in `.sys.mjs`
 * modules. Uses Acorn (already a runtime dependency) to parse the
 * module and inspects JSDoc comments via the `onComment` callback.
 *
 * Separated from `patch-lint.ts` to keep both files within the
 * project's per-file line budget.
 */

import type * as acorn from 'acorn';
import type {
  ClassDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  MethodDefinition,
  Node,
  VariableDeclaration,
} from 'estree';

import { toError } from '../utils/errors.js';
import type { AcornESTreeNode } from './ast-utils.js';
import { asEstree, parseModule } from './ast-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsDocCheck =
  /** The source could not be parsed, so no JSDoc rule could run on it. */
  | 'jsdoc-unparseable-source'
  | 'missing-jsdoc'
  | 'jsdoc-param-mismatch'
  | 'jsdoc-missing-returns'
  | 'missing-jsdoc-class-method'
  | 'jsdoc-class-method-param-mismatch'
  | 'jsdoc-class-method-missing-returns';

export interface JsDocIssue {
  line: number;
  check: JsDocCheck;
  message: string;
  /** Optional severity hint. When undefined, callers default to 'error'. */
  severity?: 'error' | 'warning';
}

export type ClassMethodMode = 'off' | 'warning' | 'error';

export interface ValidateExportJsDocOptions {
  /** Gate for class-method JSDoc enforcement. Default 'off' (no walking). */
  classMethodMode?: ClassMethodMode;
}

// ---------------------------------------------------------------------------
// JSDoc comment helpers
// ---------------------------------------------------------------------------

function isJsDocComment(comment: acorn.Comment): boolean {
  return comment.type === 'Block' && comment.value.startsWith('*');
}

/**
 * Finds the JSDoc comment immediately preceding `declStart` in the
 * source. "Immediately" means only whitespace and newlines may appear
 * between the comment's closing delimiter and the declaration.
 */
function findAttachedJsDoc(
  comments: acorn.Comment[],
  declStart: number,
  source: string
): acorn.Comment | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c || !isJsDocComment(c)) continue;
    const commentEnd = c.end;
    if (commentEnd > declStart) continue;
    const between = source.slice(commentEnd, declStart);
    if (/^\s*$/.test(between)) return c;
    break;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSDoc tag parsing
// ---------------------------------------------------------------------------

/**
 * Skips a balanced `{ … }` JSDoc type expression starting at `start`
 * (which must point at the opening brace). Braces nest in inline object
 * types (`{{ id: string, args?: Record<string, boolean> }}`), so a flat
 * "anything but `}`" regex truncates at the first inner close brace and
 * loses the param name. String literal types may contain braces too, so
 * quoted runs are skipped verbatim.
 *
 * @returns Index just past the matching close brace, or -1 when the type
 *   expression never closes (malformed doc — caller skips the tag).
 */
function skipBalancedTypeBraces(jsDoc: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < jsDoc.length; i++) {
    const ch = jsDoc[i];
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractParamNames(jsDoc: string): string[] {
  const names: string[] = [];
  const tagPattern = /@param\b/g;
  let m: RegExpExecArray | null;
  while ((m = tagPattern.exec(jsDoc)) !== null) {
    let i = m.index + m[0].length;
    while (i < jsDoc.length && /\s/.test(jsDoc[i] ?? '')) i++;

    // Optional `{type}` expression — depth-aware so nested braces inside
    // inline object types or Record<…> generics don't truncate the scan.
    if (jsDoc[i] === '{') {
      const afterType = skipBalancedTypeBraces(jsDoc, i);
      if (afterType === -1) continue;
      i = afterType;
      while (i < jsDoc.length && /\s/.test(jsDoc[i] ?? '')) i++;
    }

    // Name token: bare `name`, optional `[name]`, or defaulted `[name=x]`.
    // Dotted property docs (`opts.id`) record the base object name once.
    const optional = jsDoc[i] === '[';
    if (optional) i++;
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(jsDoc.slice(i));
    if (!nameMatch) continue;
    const name = nameMatch[0];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function hasReturnsTag(jsDoc: string): boolean {
  return /@returns?\b/.test(jsDoc);
}

function hasPrivateOrInternalTag(jsDoc: string): boolean {
  return /@(?:private|internal)\b/.test(jsDoc);
}

// ---------------------------------------------------------------------------
// Return-statement detection
// ---------------------------------------------------------------------------

/**
 * Returns true if any direct `ReturnStatement` in the function body
 * has a non-null argument. Does not recurse into nested functions or
 * arrow expressions which have their own return semantics.
 */
function functionReturnsValue(node: FunctionDeclaration | FunctionExpression): boolean {
  return walkForReturn(node.body);
}

function walkForReturn(node: Node): boolean {
  if (node.type === 'ReturnStatement') {
    return node.argument != null;
  }
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return false;
  }
  // `entries` erases the node's static shape without asserting a new one;
  // the `any` from `Object.entries`' fallback overload widens to `unknown`.
  const entries: [string, unknown][] = Object.entries(node);
  for (const [key, val] of entries) {
    if (key === 'type') continue;
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child === 'object' && 'type' in child) {
            if (walkForReturn(child as Node)) return true;
          }
        }
      } else if ('type' in val) {
        if (walkForReturn(val as Node)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Declaration resolving for named exports
// ---------------------------------------------------------------------------

type TopLevelDeclaration = AcornESTreeNode<
  FunctionDeclaration | ClassDeclaration | VariableDeclaration
>;

function findLocalDeclaration(
  body: AcornESTreeNode[],
  name: string
): TopLevelDeclaration | undefined {
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration') {
      const fn = stmt;
      if (fn.id.name === name) return stmt;
    } else if (stmt.type === 'ClassDeclaration') {
      const cls = stmt;
      if (cls.id.name === name) return stmt;
    } else if (stmt.type === 'VariableDeclaration') {
      const varDecl = stmt;
      for (const d of varDecl.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name) {
          return varDecl;
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Line number helpers
// ---------------------------------------------------------------------------

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Shared param/returns checker
// ---------------------------------------------------------------------------

interface ParamsReturnsContext {
  /** Human-readable subject (e.g. `'function "foo"'`, `'method "Cls.bar"'`). */
  label: string;
  line: number;
  paramCheck: JsDocCheck;
  returnsCheck: JsDocCheck;
  severity?: 'error' | 'warning';
  /** Skip @param matching (used for getters which take no params anyway). */
  skipParams?: boolean;
  /** Skip @returns enforcement (used for setters, getters, constructors). */
  skipReturns?: boolean;
}

/**
 * Validates @param name matching and @returns presence on a function-like
 * node that already has an attached JSDoc comment. Destructured, default-
 * valued, and rest params are silently skipped to match historical behavior
 * of the top-level export check.
 */
function validateParamsAndReturns(
  fnNode: AcornESTreeNode<FunctionDeclaration | FunctionExpression>,
  jsDoc: acorn.Comment,
  issues: JsDocIssue[],
  ctx: ParamsReturnsContext
): void {
  const docText = jsDoc.value;

  if (!ctx.skipParams) {
    const actualParams = fnNode.params
      .map((p) => (p.type === 'Identifier' ? p.name : null))
      .filter((n): n is string => n !== null);

    if (actualParams.length > 0) {
      const docParams = extractParamNames(docText);
      for (const param of actualParams) {
        if (!docParams.includes(param)) {
          issues.push({
            line: ctx.line,
            check: ctx.paramCheck,
            message: `Exported ${ctx.label} at line ${ctx.line}: @param "${param}" is missing or misnamed in JSDoc.`,
            ...(ctx.severity ? { severity: ctx.severity } : {}),
          });
        }
      }
    }
  }

  if (!ctx.skipReturns && functionReturnsValue(fnNode) && !hasReturnsTag(docText)) {
    issues.push({
      line: ctx.line,
      check: ctx.returnsCheck,
      message: `Exported ${ctx.label} at line ${ctx.line} returns a value but JSDoc is missing @returns.`,
      ...(ctx.severity ? { severity: ctx.severity } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Top-level export validation
// ---------------------------------------------------------------------------

/**
 * Validates a top-level function declaration: requires an attached JSDoc
 * comment, then checks @param name matching and @returns presence. Exported
 * so the chrome-subscript validator (`patch-lint-chrome-jsdoc.ts`) can reuse
 * it on `parseScript`-produced declarations — the rule shape is identical
 * between ES-module exports and chrome-subscript top-level declarations.
 *
 * @param fn - FunctionDeclaration AST node
 * @param comments - All Acorn comments collected from the source
 * @param source - Original source text (for line-number resolution)
 * @param issues - Output sink for JSDoc issues
 * @param lookupStart - Optional offset to use when locating the attached
 *   JSDoc (defaults to `fn.start`). Used by the export-walker so the JSDoc
 *   is found relative to the `export` keyword rather than the inner decl.
 */
export function validateFunctionDecl(
  fn: AcornESTreeNode<FunctionDeclaration>,
  comments: acorn.Comment[],
  source: string,
  issues: JsDocIssue[],
  lookupStart?: number
): void {
  const name = fn.id.name;
  const start = lookupStart !== undefined ? lookupStart : fn.start;
  const line = lineAt(source, start);
  const jsDoc = findAttachedJsDoc(comments, start, source);

  if (!jsDoc) {
    issues.push({
      line,
      check: 'missing-jsdoc',
      message: `Exported function "${name}" at line ${line} is missing a JSDoc comment.`,
    });
    return;
  }

  validateParamsAndReturns(fn, jsDoc, issues, {
    label: `function "${name}"`,
    line,
    paramCheck: 'jsdoc-param-mismatch',
    returnsCheck: 'jsdoc-missing-returns',
  });
}

/**
 * Validates a top-level class declaration: requires an attached JSDoc
 * comment on the class itself. Method-level checks live in
 * {@link validateClassMethods}. Exported for reuse in the chrome-subscript
 * validator.
 */
export function validateClassDecl(
  cls: AcornESTreeNode<ClassDeclaration>,
  comments: acorn.Comment[],
  source: string,
  issues: JsDocIssue[],
  lookupStart?: number
): void {
  const name = cls.id.name;
  const start = lookupStart !== undefined ? lookupStart : cls.start;
  const line = lineAt(source, start);
  const jsDoc = findAttachedJsDoc(comments, start, source);

  if (!jsDoc) {
    issues.push({
      line,
      check: 'missing-jsdoc',
      message: `Exported class "${name}" at line ${line} is missing a JSDoc comment.`,
    });
  }
}

function validateVariableDecl(
  varDecl: AcornESTreeNode<VariableDeclaration>,
  comments: acorn.Comment[],
  source: string,
  issues: JsDocIssue[],
  lookupStart?: number
): void {
  const start = lookupStart !== undefined ? lookupStart : varDecl.start;
  const jsDoc = findAttachedJsDoc(comments, start, source);
  if (jsDoc) return; // has a JSDoc block — sufficient for constants

  for (const decl of varDecl.declarations) {
    const name = decl.id.type === 'Identifier' ? decl.id.name : '<destructured>';
    const line = lineAt(source, start);
    issues.push({
      line,
      check: 'missing-jsdoc',
      message: `Exported constant "${name}" at line ${line} is missing a JSDoc comment.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Class-method validation (opt-in via classMethodMode)
// ---------------------------------------------------------------------------

/**
 * Returns the method's identifier name when statically resolvable, or
 * undefined for computed keys (e.g. `[Symbol.iterator]()`). Private fields
 * (`#name`) are treated as private-by-syntax and surface as undefined here
 * so the walker skips them up front.
 */
function staticMethodName(method: MethodDefinition): string | undefined {
  if (method.computed) return undefined;
  const key = method.key as { type: string; name?: string };
  if (key.type !== 'Identifier') return undefined;
  return key.name;
}

function isPrivateMethodKey(method: MethodDefinition): boolean {
  return (method.key as { type: string }).type === 'PrivateIdentifier';
}

function classMethodLabel(className: string, method: MethodDefinition, name: string): string {
  if (method.kind === 'constructor') return `constructor of class "${className}"`;
  const prefix = method.static ? 'static ' : '';
  if (method.kind === 'get') return `${prefix}getter "${className}.${name}"`;
  if (method.kind === 'set') return `${prefix}setter "${className}.${name}"`;
  return `${prefix}method "${className}.${name}"`;
}

/**
 * Walks an exported class body and emits class-method JSDoc issues per
 * the configured severity. Skip rules (in evaluation order):
 *   1. private syntax (`#foo`) and underscore-prefixed names
 *   2. zero-parameter constructors
 *   3. methods whose JSDoc carries `@private` or `@internal`
 *
 * Pure-override skip (`super.method(...args)`-only bodies bypassing the
 * @returns check) is deferred — V1 keeps the rule simple.
 */
export function validateClassMethods(
  cls: AcornESTreeNode<ClassDeclaration>,
  comments: acorn.Comment[],
  source: string,
  issues: JsDocIssue[],
  severity: 'warning' | 'error'
): void {
  const className = cls.id.name;

  for (const member of cls.body.body) {
    if (member.type !== 'MethodDefinition') continue;
    const method = asEstree<MethodDefinition>(member);

    if (isPrivateMethodKey(method)) continue;
    const name = staticMethodName(method);
    if (name === undefined) continue;
    if (method.kind !== 'constructor' && name.startsWith('_')) continue;

    if (method.kind === 'constructor' && method.value.params.length === 0) continue;

    const methodStart = method.start;
    const line = lineAt(source, methodStart);
    const jsDoc = findAttachedJsDoc(comments, methodStart, source);

    if (jsDoc && hasPrivateOrInternalTag(jsDoc.value)) continue;

    const label = classMethodLabel(className, method, name);

    if (!jsDoc) {
      issues.push({
        line,
        check: 'missing-jsdoc-class-method',
        message: `Exported ${label} at line ${line} is missing a JSDoc comment.`,
        severity,
      });
      continue;
    }

    if (method.kind === 'get') {
      // Presence already verified; getter expression is the contract.
      continue;
    }

    const skipReturns = method.kind === 'constructor' || method.kind === 'set';

    validateParamsAndReturns(asEstree<FunctionExpression>(method.value), jsDoc, issues, {
      label,
      line,
      paramCheck: 'jsdoc-class-method-param-mismatch',
      returnsCheck: 'jsdoc-class-method-missing-returns',
      severity,
      skipReturns,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates JSDoc on exported declarations in a `.sys.mjs` source file.
 *
 * @param source - File content
 * @param options - Optional gates for opt-in checks (e.g. class-method JSDoc)
 * @returns Array of JSDoc issues found
 */
export function validateExportJsDoc(
  source: string,
  options?: ValidateExportJsDocOptions
): JsDocIssue[] {
  const classMethodMode = options?.classMethodMode ?? 'off';
  const comments: acorn.Comment[] = [];
  let ast: AcornESTreeNode<import('estree').Program>;
  try {
    ast = parseModule(source, comments);
  } catch (error: unknown) {
    // An unparseable source is NOT a clean file. Returning `[]` here was the
    // same value as "fully documented", so a syntax error silently cleared
    // every rule this module enforces. Report it instead.
    return [
      {
        line: 1,
        check: 'jsdoc-unparseable-source',
        message: `Source could not be parsed for JSDoc analysis: ${toError(error).message}`,
      },
    ];
  }

  const issues: JsDocIssue[] = [];
  const body = ast.body as AcornESTreeNode[];

  for (const node of body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    const exportNode = node;

    // Case 1: inline export declaration — JSDoc attaches to `export`
    if (exportNode.declaration) {
      const decl = exportNode.declaration as AcornESTreeNode;
      const exportStart = exportNode.start;
      if (decl.type === 'FunctionDeclaration') {
        validateFunctionDecl(decl, comments, source, issues, exportStart);
      } else if (decl.type === 'ClassDeclaration') {
        validateClassDecl(decl, comments, source, issues, exportStart);
        if (classMethodMode !== 'off') {
          validateClassMethods(decl, comments, source, issues, classMethodMode);
        }
      } else if (decl.type === 'VariableDeclaration') {
        validateVariableDecl(decl, comments, source, issues, exportStart);
      }
      continue;
    }

    // Case 2: `export { foo, Bar }` — resolve back to local declarations
    if (exportNode.specifiers.length > 0 && !exportNode.source) {
      for (const spec of exportNode.specifiers) {
        const local = spec.local;
        if (local.type !== 'Identifier') continue;
        const localName = local.name;
        const localDecl = findLocalDeclaration(body, localName);
        if (!localDecl) continue;

        if (localDecl.type === 'FunctionDeclaration') {
          validateFunctionDecl(localDecl, comments, source, issues);
        } else if (localDecl.type === 'ClassDeclaration') {
          validateClassDecl(localDecl, comments, source, issues);
          if (classMethodMode !== 'off') {
            validateClassMethods(localDecl, comments, source, issues, classMethodMode);
          }
        } else {
          validateVariableDecl(localDecl, comments, source, issues);
        }
      }
    }
  }

  return issues;
}
