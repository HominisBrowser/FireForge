// SPDX-License-Identifier: EUPL-1.2
import type * as estree from 'estree';

import { GeneralError } from '../errors/base.js';
import { type AcornESTreeNode, walkAST } from './ast-utils.js';

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
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
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
    if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '`') inTemplate = false;
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
    // Heuristic for regex literals: if / follows an operator or keyword boundary,
    // treat it as a regex start and skip to the closing /
    if (ch === '/' && next !== undefined) {
      const prev = i > 0 ? line[i - 1] : undefined;
      if (prev === undefined || /[=(:,!|&?;~^{[\n+\-*%<>]/.test(prev)) {
        // Skip to closing /
        i++;
        while (i < line.length) {
          if (line[i] === '\\') {
            i++; // skip escaped character
          } else if (line[i] === '/') {
            break;
          }
          i++;
        }
        continue;
      }
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }
  return { depth, inBlockComment: inBlock };
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
 * @returns `{ methodLine, braceIndex }`, or `null` if the pattern is not found.
 */
export function findMethodBraceIndex(
  lines: string[],
  pattern: RegExp
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
  for (let i = methodLine; i < lines.length; i++) {
    if (lines[i]?.includes('{')) {
      braceIndex = i;
      break;
    }
  }
  return { methodLine, braceIndex };
}

/**
 * Starting from `startLine`, walks lines using {@link countBraceDepth}
 * until the brace depth returns to zero (i.e., the enclosing block closes).
 *
 * @returns The line index *after* the closing brace, or `startLine + 1` if
 *   the block never closes (defensive).
 */
export function walkToTryBlockEnd(lines: string[], startLine: number): number {
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
  return startLine + 1;
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
        const prop = node as AcornESTreeNode<estree.Property>;
        if (
          prop.key.type === 'Identifier' &&
          names.includes(prop.key.name) &&
          (prop.value.type === 'FunctionExpression' ||
            prop.value.type === 'ArrowFunctionExpression')
        ) {
          const fn = prop.value as AcornESTreeNode<estree.FunctionExpression>;
          found = fn.body as AcornESTreeNode<estree.BlockStatement>;
        }
      }
    },
  });

  return found;
}
