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
  ExportNamedDeclaration,
  FunctionDeclaration,
  Node,
  VariableDeclaration,
} from 'estree';

import type { AcornESTreeNode } from './ast-utils.js';
import { parseModule } from './ast-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsDocCheck = 'missing-jsdoc' | 'jsdoc-param-mismatch' | 'jsdoc-missing-returns';

export interface JsDocIssue {
  line: number;
  check: JsDocCheck;
  message: string;
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

function extractParamNames(jsDoc: string): string[] {
  const names: string[] = [];
  const paramPattern = /@param\s+(?:\{[^}]*\}\s+)?(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = paramPattern.exec(jsDoc)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function hasReturnsTag(jsDoc: string): boolean {
  return /@returns?\b/.test(jsDoc);
}

// ---------------------------------------------------------------------------
// Return-statement detection
// ---------------------------------------------------------------------------

/**
 * Returns true if any direct `ReturnStatement` in the function body
 * has a non-null argument. Does not recurse into nested functions or
 * arrow expressions which have their own return semantics.
 */
function functionReturnsValue(node: FunctionDeclaration): boolean {
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
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const val = (node as unknown as Record<string, unknown>)[key];
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
      const fn = stmt as AcornESTreeNode<FunctionDeclaration>;
      if (fn.id.name === name) return stmt as TopLevelDeclaration;
    } else if (stmt.type === 'ClassDeclaration') {
      const cls = stmt as AcornESTreeNode<ClassDeclaration>;
      if (cls.id.name === name) return stmt as TopLevelDeclaration;
    } else if (stmt.type === 'VariableDeclaration') {
      const varDecl = stmt as AcornESTreeNode<VariableDeclaration>;
      for (const d of varDecl.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name) {
          return varDecl as TopLevelDeclaration;
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
// Core validation
// ---------------------------------------------------------------------------

function validateFunctionDecl(
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

  const docText = jsDoc.value;

  const actualParams = fn.params
    .map((p) => (p.type === 'Identifier' ? p.name : null))
    .filter((n): n is string => n !== null);

  if (actualParams.length > 0) {
    const docParams = extractParamNames(docText);
    for (const param of actualParams) {
      if (!docParams.includes(param)) {
        issues.push({
          line,
          check: 'jsdoc-param-mismatch',
          message: `Exported function "${name}" at line ${line}: @param "${param}" is missing or misnamed in JSDoc.`,
        });
      }
    }
  }

  if (functionReturnsValue(fn) && !hasReturnsTag(docText)) {
    issues.push({
      line,
      check: 'jsdoc-missing-returns',
      message: `Exported function "${name}" at line ${line} returns a value but JSDoc is missing @returns.`,
    });
  }
}

function validateClassDecl(
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates JSDoc on exported declarations in a `.sys.mjs` source file.
 *
 * @param source - File content
 * @returns Array of JSDoc issues found
 */
export function validateExportJsDoc(source: string): JsDocIssue[] {
  const comments: acorn.Comment[] = [];
  let ast: AcornESTreeNode<import('estree').Program>;
  try {
    ast = parseModule(source, comments);
  } catch {
    return [];
  }

  const issues: JsDocIssue[] = [];
  const body = ast.body as AcornESTreeNode[];

  for (const node of body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    const exportNode = node as AcornESTreeNode<ExportNamedDeclaration>;

    // Case 1: inline export declaration — JSDoc attaches to `export`
    if (exportNode.declaration) {
      const decl = exportNode.declaration as AcornESTreeNode;
      const exportStart = exportNode.start;
      if (decl.type === 'FunctionDeclaration') {
        validateFunctionDecl(
          decl as AcornESTreeNode<FunctionDeclaration>,
          comments,
          source,
          issues,
          exportStart
        );
      } else if (decl.type === 'ClassDeclaration') {
        validateClassDecl(
          decl as AcornESTreeNode<ClassDeclaration>,
          comments,
          source,
          issues,
          exportStart
        );
      } else if (decl.type === 'VariableDeclaration') {
        validateVariableDecl(
          decl as AcornESTreeNode<VariableDeclaration>,
          comments,
          source,
          issues,
          exportStart
        );
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
          validateFunctionDecl(
            localDecl as AcornESTreeNode<FunctionDeclaration>,
            comments,
            source,
            issues
          );
        } else if (localDecl.type === 'ClassDeclaration') {
          validateClassDecl(
            localDecl as AcornESTreeNode<ClassDeclaration>,
            comments,
            source,
            issues
          );
        } else {
          validateVariableDecl(
            localDecl as AcornESTreeNode<VariableDeclaration>,
            comments,
            source,
            issues
          );
        }
      }
    }
  }

  return issues;
}
