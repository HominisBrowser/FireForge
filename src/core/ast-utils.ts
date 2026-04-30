// SPDX-License-Identifier: EUPL-1.2
import * as acorn from 'acorn';
import type * as estree from 'estree';
import { walk } from 'estree-walker';

/**
 * An ESTree node augmented with acorn's character-offset positions.
 * At runtime `acorn.parse` produces objects that carry both the ESTree
 * shape *and* `start`/`end` indices, but the type system doesn't know that.
 * This intersection type bridges the gap so we can safely use both APIs.
 */
export type AcornESTreeNode<T extends estree.Node = estree.Node> = T & {
  start: number;
  end: number;
};

/**
 * Parse JavaScript source as a **script** (not an ES module).
 * All Mozilla chrome JS files (`browser-main.js`, `browser-init.js`,
 * `customElements.js`, etc.) are scripts that run in a privileged scope.
 *
 * @param content - Source text to parse
 * @param onComment - Optional array that acorn fills with comment nodes
 * @returns Parsed program AST with character-offset positions
 */
export function parseScript(
  content: string,
  onComment?: acorn.Comment[]
): AcornESTreeNode<estree.Program> {
  const opts: acorn.Options = {
    sourceType: 'script',
    ecmaVersion: 'latest',
  };
  if (onComment) opts.onComment = onComment;
  return acorn.parse(content, opts) as unknown as AcornESTreeNode<estree.Program>;
}

/**
 * Parse JavaScript source as an **ES module**.
 * Used for `.sys.mjs` files which use static import/export syntax.
 *
 * @param content - Source text to parse
 * @param onComment - Optional array that acorn fills with comment nodes
 * @returns Parsed program AST with character-offset positions
 */
export function parseModule(
  content: string,
  onComment?: acorn.Comment[]
): AcornESTreeNode<estree.Program> {
  const opts: acorn.Options = {
    sourceType: 'module',
    ecmaVersion: 'latest',
    locations: true,
  };
  if (onComment) opts.onComment = onComment;
  return acorn.parse(content, opts) as unknown as AcornESTreeNode<estree.Program>;
}

/**
 * Convenience cast from `acorn.Node` (or the generic ESTree union returned
 * by estree-walker callbacks) to a positioned, narrowly-typed node.
 */
export function asEstree<T extends estree.Node>(node: estree.Node): AcornESTreeNode<T> {
  return node as AcornESTreeNode<T>;
}

/**
 * Type-safe wrapper around estree-walker's `walk()` that bridges the
 * acorn→estree type gap. Centralises the single `as unknown as` cast so
 * callers don't need it.
 */
export function walkAST(
  ast: AcornESTreeNode<estree.Program>,
  visitors: Parameters<typeof walk>[1]
): ReturnType<typeof walk> {
  return walk(ast, visitors);
}

/**
 * Read backward from `position` to the preceding newline (or start of
 * string) and return the leading whitespace.  This is the "visual indent"
 * of whatever token begins at `position`.
 *
 * ```
 * "  try {\n    foo();\n  }"
 *                          ^  detectIndent(…, 26) → "  "
 * ```
 */
export function detectIndent(content: string, position: number): string {
  let i = position - 1;
  while (i >= 0 && content[i] !== '\n') {
    i--;
  }
  // i is now at the newline (or -1 for start-of-string)
  const lineStart = i + 1;
  const slice = content.slice(lineStart, position);
  const match = /^(\s*)/.exec(slice);
  return match?.[1] ?? '';
}

/**
 * Extract the raw source text for a node's range.
 */
export function getNodeSource(content: string, node: { start: number; end: number }): string {
  return content.slice(node.start, node.end);
}
