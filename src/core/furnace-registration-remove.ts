// SPDX-License-Identifier: EUPL-1.2
/**
 * Removal of custom element registrations from customElements.js.
 *
 * Uses the same AST parser as the add path (`furnace-registration-ast.ts`) to
 * locate and delete registration entries. The earlier implementation walked
 * the file line-by-line with a 20-line scan bound for bracket matching, which
 * only worked against Firefox's stock formatting and silently failed on any
 * hand-reformatted customElements.js. AST-based bracket matching is format-
 * agnostic by construction.
 *
 * Contract:
 * - Idempotent: if the tag is not registered, the file is left unchanged.
 * - Non-destructive on parse failure: if customElements.js cannot be parsed,
 *   the file is left untouched rather than fall through to a line-based
 *   heuristic that could delete the wrong range.
 * - Two registration shapes are recognised:
 *     (A) Standalone statement:
 *           customElements.setElementCreationCallback("tag", ...);
 *     (B) Entry inside a `for (... of [ ... ])` registration array:
 *           ["tag", "chrome://..."]
 *   Both are deleted together with any trailing comma and newline so the
 *   resulting file is still valid JavaScript.
 */

import { join } from 'node:path';

import type * as estree from 'estree';
import MagicString from 'magic-string';

import { pathExists, readText, writeText } from '../utils/fs.js';
import { type AcornESTreeNode, parseScript, walkAST } from './ast-utils.js';
import { CUSTOM_ELEMENTS_JS } from './furnace-constants.js';

interface RemovalRange {
  start: number;
  end: number;
}

/**
 * Expands `[start, end)` to consume a trailing comma and any whitespace up
 * to (and including) the next newline. This keeps the surrounding file
 * layout stable: deleting a list entry should not leave a dangling comma
 * behind, and deleting an expression statement should not leave a blank
 * line where the statement used to be.
 */
function expandRemovalRange(content: string, start: number, end: number): RemovalRange {
  let expandedEnd = end;

  // Walk past horizontal whitespace so a trailing comma is reachable even
  // when the source has `[...]  ,` or similar.
  while (
    expandedEnd < content.length &&
    (content[expandedEnd] === ' ' || content[expandedEnd] === '\t')
  ) {
    expandedEnd++;
  }
  if (content[expandedEnd] === ',') {
    expandedEnd++;
  } else if (content[expandedEnd] === ';') {
    expandedEnd++;
  }
  // Consume a trailing inline comment up to end-of-line so we do not leave
  // the comment marooned on its own line. A leading inline comment is left
  // alone — it may belong to the next entry.
  while (
    expandedEnd < content.length &&
    (content[expandedEnd] === ' ' || content[expandedEnd] === '\t')
  ) {
    expandedEnd++;
  }
  if (content[expandedEnd] === '/' && content[expandedEnd + 1] === '/') {
    while (expandedEnd < content.length && content[expandedEnd] !== '\n') {
      expandedEnd++;
    }
  }
  if (content[expandedEnd] === '\n') {
    expandedEnd++;
  }

  // Also consume leading whitespace on the line the removal starts on, so
  // indentation does not survive as a blank-looking line.
  let expandedStart = start;
  while (expandedStart > 0) {
    const prev = content[expandedStart - 1];
    if (prev === ' ' || prev === '\t') {
      expandedStart--;
      continue;
    }
    break;
  }

  // If the removal now starts at the beginning of a line and the preceding
  // line is blank, consume that blank line as well. This matches the older
  // line-based implementation's "eat one leading blank" behaviour so that
  // removing a callback block from between two blank-line-separated
  // sections does not leave a doubled-up gap behind.
  if (
    expandedStart > 0 &&
    content[expandedStart - 1] === '\n' &&
    expandedStart >= 2 &&
    content[expandedStart - 2] === '\n'
  ) {
    expandedStart--;
  }

  return { start: expandedStart, end: expandedEnd };
}

/**
 * Returns true if `node` represents a `[tag, module]` entry inside a
 * registration array — i.e. an `ArrayExpression` whose first element is a
 * string literal equal to `tagName`. Callers still have to verify the
 * parent is the outer registration array so we do not accidentally delete
 * an arbitrary user-owned `["moz-card", ...]` literal elsewhere in the file.
 */
function isEntryArrayFor(
  node: estree.Node | null | undefined,
  tagName: string
): node is AcornESTreeNode<estree.ArrayExpression> {
  if (!node || node.type !== 'ArrayExpression') return false;
  const [first] = node.elements;
  if (!first || first.type !== 'Literal') return false;
  const literal = first;
  return literal.value === tagName;
}

/**
 * Returns true if `call` is `customElements.setElementCreationCallback(tagName, ...)`
 * (optionally prefixed with `lazy.` or similar member chain). We only match
 * the property name rather than the full callee chain so unusual-but-valid
 * receivers (`lazy.customElements…`, `this.customElements…`) still count.
 */
function isStandaloneCallbackCallFor(
  call: AcornESTreeNode<estree.CallExpression>,
  tagName: string
): boolean {
  if (call.callee.type !== 'MemberExpression') return false;
  const prop = call.callee.property;
  if (prop.type !== 'Identifier' || prop.name !== 'setElementCreationCallback') return false;
  const [tagArg] = call.arguments;
  if (!tagArg || tagArg.type !== 'Literal') return false;
  return tagArg.value === tagName;
}

/**
 * Walks the AST and collects every removal range for `tagName`. Ancestor
 * tracking lets us tell an "entry" array from a random `["moz-foo", ...]`
 * literal (only direct children of the outer registration `ArrayExpression`
 * are entries) and lets us lift a `setElementCreationCallback` call up to
 * its enclosing statement.
 */
function collectRemovalRanges(
  ast: AcornESTreeNode<estree.Program>,
  content: string,
  tagName: string
): RemovalRange[] {
  const ranges: RemovalRange[] = [];
  const ancestors: estree.Node[] = [];

  walkAST(ast, {
    enter(node) {
      // Entry array: [tag, module] inside the outer for-of array literal.
      // The immediate parent must be an ArrayExpression (the registration
      // list) whose own grandparent is the `for (...) of <array>` loop.
      if (node.type === 'ArrayExpression' && isEntryArrayFor(node, tagName)) {
        const parent = ancestors[ancestors.length - 1];
        const grandparent = ancestors[ancestors.length - 2];
        if (
          parent &&
          parent.type === 'ArrayExpression' &&
          grandparent &&
          grandparent.type === 'ForOfStatement'
        ) {
          ranges.push(expandRemovalRange(content, node.start, node.end));
        }
      }

      // Standalone call: customElements.setElementCreationCallback(tag, …)
      if (node.type === 'CallExpression') {
        const call = node as AcornESTreeNode<estree.CallExpression>;
        if (isStandaloneCallbackCallFor(call, tagName)) {
          // Find the enclosing statement so we can delete `call(...);` as
          // a unit, not just the call expression body.
          let enclosing: AcornESTreeNode<estree.Statement> | null = null;
          for (let i = ancestors.length - 1; i >= 0; i--) {
            const ancestor = ancestors[i];
            if (!ancestor) continue;
            if (
              ancestor.type === 'ExpressionStatement' ||
              ancestor.type === 'VariableDeclaration'
            ) {
              enclosing = ancestor as AcornESTreeNode<estree.Statement>;
              break;
            }
          }
          const target = enclosing ?? call;
          ranges.push(expandRemovalRange(content, target.start, target.end));
        }
      }

      ancestors.push(node);
    },
    leave() {
      ancestors.pop();
    },
  });

  return ranges;
}

/**
 * Removes a custom element registration from customElements.js.
 *
 * This operation is idempotent — if the tag is not registered or the file
 * does not exist, nothing happens. If the file exists but cannot be parsed,
 * the file is left unchanged rather than fall back to a line-based
 * heuristic; a corrupted customElements.js is a doctor problem, not
 * something `furnace remove` should "helpfully" edit around.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Custom element tag name to remove
 */
export async function removeCustomElementRegistration(
  engineDir: string,
  tagName: string
): Promise<void> {
  const filePath = join(engineDir, CUSTOM_ELEMENTS_JS);

  if (!(await pathExists(filePath))) {
    return;
  }

  const content = await readText(filePath);

  // Cheap pre-check: if the tag literal never appears in the file there is
  // nothing to remove and we avoid the cost of parsing a large file on the
  // hot path of a no-op remove.
  if (!content.includes(`"${tagName}"`) && !content.includes(`'${tagName}'`)) {
    return;
  }

  let ast: AcornESTreeNode<estree.Program>;
  try {
    ast = parseScript(content);
  } catch {
    return;
  }

  const ranges = collectRemovalRanges(ast, content, tagName);
  if (ranges.length === 0) {
    return;
  }

  // Apply all removals in a single MagicString pass. MagicString tracks
  // original offsets so the ranges do not need to be sorted or reversed.
  const ms = new MagicString(content);
  for (const range of ranges) {
    ms.remove(range.start, range.end);
  }
  const next = ms.toString();

  if (next !== content) {
    await writeText(filePath, next);
  }
}
