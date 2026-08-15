// SPDX-License-Identifier: EUPL-1.2
import type * as estree from 'estree';

import { GeneralError, ParserFallbackError } from '../errors/base.js';
import { type AcornESTreeNode, asEstree, walkAST } from './ast-utils.js';

/**
 * Validates a name for safe interpolation into generated JavaScript string literals.
 * Rejects strings containing characters that could break out of JS strings or inject code.
 */
export function validateWireName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_$][\w$.-]*(?:\(\))?$/.test(value)) {
    throw new GeneralError(
      `Invalid ${label} "${value}": must contain only letters, digits, hyphens, underscores, dots, and $ signs`
    );
  }
  // Reject property chains that could reach dangerous built-in properties
  const segments = value.replace(/\(\)$/, '').split('.');
  const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
  for (const seg of segments) {
    if (dangerous.has(seg)) {
      throw new GeneralError(
        `Invalid ${label} "${value}": must not contain "${seg}" as a property segment`
      );
    }
  }
}

/**
 * Coerces an init/destroy expression into a function call by appending `()`
 * when the caller passed a bare property chain. Idempotent: an expression
 * already ending in `()` is returned unchanged, so operators can pass either
 * `EvalStartup.init` or `EvalStartup.init()` and get the same wired output.
 *
 * Motivation (eval finding 8): `validateWireName` accepts both shapes, but
 * the generated block interpolated the expression verbatim inside
 * `${expression};`. When a caller passed `EvalStartup.init`, the emitted
 * code was `EvalStartup.init;` — a plain property reference that never
 * invoked the lifecycle hook. The symptom was silent: `wire` reported
 * success and the browser-init block looked plausible, but the hook
 * never fired at runtime. Coercion at the template site closes that gap.
 */
export function coerceToCall(expression: string): string {
  return expression.endsWith('()') ? expression : `${expression}()`;
}

/**
 * Counts net brace depth change in a single line, ignoring braces inside
 * string literals (single, double, template), line comments (`//`), and
 * block comments.
 *
 * Tracks multi-line block comment state across calls via the `inBlockComment`
 * parameter, allowing callers to iterate over lines while preserving context.
 *
 * **Regex literal heuristic:** When a `/` follows an operator or keyword-boundary
 * character (one of `= ( : , ! | & ? ; ~ ^ { [ \n + - * % < >`), it is treated
 * as a regex literal opener and characters are skipped until the closing `/`.
 * This heuristic can misfire on:
 *   - Division operators where the left operand is an identifier (`x / y / z`
 *     would incorrectly treat ` y ` as regex content).
 *   - Tagged template literals or unusual formatting.
 *
 * For Firefox source files this heuristic is sufficient because the AST-based
 * parser (via `withParserFallback`) is tried first; this function is only
 * used in the regex-based fallback path.
 *
 * @param line - A single line of source text
 * @param inBlockComment - Whether the previous line ended inside a block comment
 * @returns The net brace depth change and updated block comment state
 */
export function countBraceDepth(
  line: string,
  inBlockComment: boolean
): { depth: number; inBlockComment: boolean } {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let inLine = false;
  let inBlock = inBlockComment;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    const next = line[i + 1];

    if (inLine) continue;
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (ch === '\\' && quote !== null) {
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '/' && next !== undefined && isRegexLiteralStart(line, i)) {
      i = scanToRegexLiteralEnd(line, i);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }
  return { depth, inBlockComment: inBlock };
}

/**
 * Regex-literal opener heuristic for the fallback scanner: a `/` is
 * treated as starting a regex when it follows an operator or
 * keyword-boundary character (or starts the line). See the misfire notes
 * on {@link countBraceDepth}.
 */
function isRegexLiteralStart(line: string, i: number): boolean {
  const prev = i > 0 ? line[i - 1] : undefined;
  return prev === undefined || /[=(:,!|&?;~^{[\n+\-*%<>]/.test(prev);
}

/**
 * Scans from the opening `/` of a regex literal to its closing `/`
 * (honouring escapes), returning the index of the closing slash — or the
 * end of the line when the literal never closes.
 */
function scanToRegexLiteralEnd(line: string, start: number): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === '\\') {
      i++; // skip escaped character
    } else if (line[i] === '/') {
      break;
    }
    i++;
  }
  return i;
}

/**
 * Extracts the class/object name from an expression like "MyComponent.init()".
 */
export function extractNameFromExpression(expression: string): string {
  const match = /^(\w+)/.exec(expression);
  return match?.[1] ?? expression;
}

/** Token types for XHTML/preprocessor files */
export interface XhtmlToken {
  type: 'xml' | 'macro' | 'empty';
  raw: string;
}

/**
 * Tokenize an XHTML file with Mozilla preprocessor `#include` directives
 * into a structured array.
 */
export function tokenizeXhtml(lines: string[]): XhtmlToken[] {
  return lines.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return { type: 'empty' as const, raw };
    }
    if (trimmed.startsWith('#include ')) {
      return { type: 'macro' as const, raw };
    }
    return { type: 'xml' as const, raw };
  });
}

// ---------------------------------------------------------------------------
// Legacy (line-based) helpers — shared by fallback implementations in
// wire-targets.ts.  Extracted to reduce duplication and make the brace-
// walking logic independently testable.
// ---------------------------------------------------------------------------

/**
 * Finds the line index of a method signature matching `pattern`, then
 * advances to the line containing the opening brace.
 *
 * By default this helper is tolerant: when no `{` is found anywhere after
 * the signature, it still returns `braceIndex: methodLine` — which is the
 * correct answer when the signature and body brace live on the same line,
 * but is ambiguous when the method is abstract or truncated. Opt into
 * stricter behaviour by passing `requireBrace: true`; the function will
 * return `null` instead of guessing, letting the caller surface a clean
 * {@link ParserFallbackError} rather than inserting into a wrong offset.
 *
 * @returns `{ methodLine, braceIndex }`, or `null` if the pattern is not
 *   found (or, under `requireBrace`, no brace follows the signature).
 */
export function findMethodBraceIndex(
  lines: string[],
  pattern: RegExp,
  options?: { requireBrace?: boolean }
): { methodLine: number; braceIndex: number } | null {
  let methodLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? '')) {
      methodLine = i;
      break;
    }
  }
  if (methodLine === -1) return null;

  let braceIndex = methodLine;
  let braceFound = false;
  for (let i = methodLine; i < lines.length; i++) {
    if (lines[i]?.includes('{')) {
      braceIndex = i;
      braceFound = true;
      break;
    }
  }

  if (!braceFound && options?.requireBrace) {
    return null;
  }

  return { methodLine, braceIndex };
}

/**
 * Starting from `startLine`, walks lines using {@link countBraceDepth}
 * until the brace depth returns to zero (i.e., the enclosing block closes).
 *
 * Default behaviour is defensive — if the block never closes, the helper
 * returns `startLine + 1` so a single malformed file does not stop the
 * entire fallback path. Pass `{ strict: true }` to opt into failing loudly
 * with a {@link ParserFallbackError} instead; new callers should prefer
 * strict mode so silent mis-insertions surface as the fallback refusing
 * to touch the file.
 *
 * @param lines - The full file split by newline
 * @param startLine - Line index of the `try {` (or other block opener) to walk
 * @param options - Pass `{ strict: true }` to throw when the block never closes
 * @returns The line index *after* the closing brace
 */
export function walkToTryBlockEnd(
  lines: string[],
  startLine: number,
  options?: { strict?: boolean; context?: string }
): number {
  let depth = 0;
  let inBlock = false;
  for (let j = startLine; j < lines.length; j++) {
    const r = countBraceDepth(lines[j] ?? '', inBlock);
    depth += r.depth;
    inBlock = r.inBlockComment;
    if (depth <= 0 && j > startLine) {
      return j + 1;
    }
  }

  if (options?.strict) {
    throw new ParserFallbackError(
      `Block starting at line ${startLine + 1} never closes — fallback parser refuses to insert`,
      options.context
    );
  }

  return startLine + 1;
}

/**
 * Scans the entire file and returns the net brace balance so callers can
 * assert that a legacy fallback mutation did not silently introduce or
 * drop a `{` / `}`. The helper reuses {@link countBraceDepth} so strings,
 * comments, and regex literals are handled consistently with the walker.
 *
 * @param content - Full file contents (will be split by newline)
 * @returns The net depth across the file (`opens - closes`) and a
 *   convenience `balanced` flag equal to `depth === 0`.
 */
export function computeFileBraceBalance(content: string): { depth: number; balanced: boolean } {
  const lines = content.split('\n');
  let depth = 0;
  let inBlock = false;
  for (const line of lines) {
    const r = countBraceDepth(line, inBlock);
    depth += r.depth;
    inBlock = r.inBlockComment;
  }
  return { depth, balanced: depth === 0 };
}

/**
 * Round-trip guard used after a legacy fallback mutation: if the file's
 * net brace balance drifts between `before` and `after`, something went
 * wrong and the fallback is refusing to write a corrupted file. Expects
 * the delta to be exactly zero — wire fallbacks only insert whole
 * try/catch blocks, which always contribute equal opens and closes.
 *
 * @throws {@link ParserFallbackError} when the balance delta is non-zero.
 */
export function assertBraceBalancePreserved(before: string, after: string, context: string): void {
  const beforeDepth = computeFileBraceBalance(before).depth;
  const afterDepth = computeFileBraceBalance(after).depth;
  if (beforeDepth !== afterDepth) {
    throw new ParserFallbackError(
      `Brace balance drifted from ${beforeDepth} to ${afterDepth} after fallback mutation; refusing to write`,
      context
    );
  }
}

/**
 * Looks backward from `fromLine` (exclusive) to find the nearest `try {`
 * line.  If nothing is found searching backward, also searches forward.
 *
 * @returns The line index of `try {`, or -1 if not found.
 */
export function findNearestTryLine(lines: string[], fromLine: number, lowerBound: number): number {
  // Backward search
  for (let k = fromLine; k > lowerBound; k--) {
    if (/\btry\s*\{/.test(lines[k] ?? '')) return k;
  }
  // Forward search
  for (let k = fromLine; k < lines.length; k++) {
    if (/\btry\s*\{/.test(lines[k] ?? '')) return k;
  }
  return -1;
}

/** Patterns that identify a fireforge init/destroy try-catch block. */
const FIREFORGE_BLOCK_PATTERN = /\/\/\s*.*init\s*—|typeof\s+\w+\s*!==\s*"undefined"/;

/**
 * Scans lines starting from `startLine` for consecutive fireforge try-catch
 * blocks (identified by init comments or typeof guards) and returns the
 * line index just after the last such block — i.e., where a new block should
 * be inserted.
 *
 * Non-fireforge, non-blank, non-comment lines terminate the scan.
 */
export function findInsertionAfterFireforgeBlocks(
  lines: string[],
  startLine: number,
  lowerBound: number
): number {
  let insertIndex = startLine;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FIREFORGE_BLOCK_PATTERN.test(line)) {
      const tryLine = findNearestTryLine(lines, i, lowerBound);
      if (tryLine !== -1) {
        const end = walkToTryBlockEnd(lines, tryLine);
        insertIndex = end;
        i = end - 1; // continue after this block
      }
      continue;
    }
    if (line.trim() && !line.trim().startsWith('//')) {
      insertIndex = i;
      break;
    }
  }

  return insertIndex;
}

// ---------------------------------------------------------------------------
// AST-based helpers
// ---------------------------------------------------------------------------

/**
 * Find the `Property` node for a method name like `onLoad` or `onUnload`
 * inside the AST. Returns the function body's `BlockStatement`.
 */
export function findMethodBody(
  ast: AcornESTreeNode<estree.Program>,
  methodName: string | string[]
): AcornESTreeNode<estree.BlockStatement> | null {
  const names = Array.isArray(methodName) ? methodName : [methodName];
  let found: AcornESTreeNode<estree.BlockStatement> | null = null;

  walkAST(ast, {
    enter(node) {
      if (found) return;
      if (node.type === 'Property') {
        const prop = asEstree<estree.Property>(node);
        if (
          prop.key.type === 'Identifier' &&
          names.includes(prop.key.name) &&
          (prop.value.type === 'FunctionExpression' ||
            prop.value.type === 'ArrowFunctionExpression')
        ) {
          const fn = asEstree<estree.FunctionExpression>(prop.value);
          found = asEstree<estree.BlockStatement>(fn.body);
        }
      }
    },
  });

  return found;
}
