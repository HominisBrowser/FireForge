// SPDX-License-Identifier: EUPL-1.2
/**
 * AST-based custom element registration updates for customElements.js.
 * Removal logic is in furnace-registration-remove.ts.
 */

import { join } from 'node:path';

import type * as estree from 'estree';
import MagicString from 'magic-string';

import { FurnaceError } from '../errors/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import {
  type AcornESTreeNode,
  detectIndent,
  getNodeSource,
  parseScript,
  walkAST,
} from './ast-utils.js';
import { CUSTOM_ELEMENTS_JS } from './furnace-constants.js';
import { validateRegistrationPlacement, validateTagName } from './furnace-registration-validate.js';

// Re-export from split modules so existing import sites continue working
export { removeCustomElementRegistration } from './furnace-registration-remove.js';

// Re-export constants so existing import sites continue working
export { CUSTOM_ELEMENTS_JS, JAR_MN } from './furnace-constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a `ForOfStatement` is nested inside a
 * `document.addEventListener("DOMContentLoaded", ...)` call by
 * inspecting the ancestor stack.
 */
function isInsideDOMContentLoaded(ancestors: estree.Node[], content: string): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (!ancestor || ancestor.type !== 'CallExpression') continue;
    const call = ancestor as AcornESTreeNode<estree.CallExpression>;
    if (
      call.callee.type === 'MemberExpression' &&
      call.callee.object.type === 'Identifier' &&
      call.callee.object.name === 'document' &&
      call.callee.property.type === 'Identifier' &&
      call.callee.property.name === 'addEventListener'
    ) {
      const firstArg = call.arguments[0];
      if (
        firstArg &&
        firstArg.type === 'Literal' &&
        (firstArg as estree.Literal).value === 'DOMContentLoaded'
      ) {
        return true;
      }
      // Check if "DOMContentLoaded" appears in the call's source (handles edge cases)
      const src = getNodeSource(content, call);
      if (/["']DOMContentLoaded["']/.test(src)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// AST implementation
// ---------------------------------------------------------------------------

/**
 * Represents a parsed entry from the registration array for format detection.
 */
interface ASTEntryInfo {
  tag: string;
  node: AcornESTreeNode<estree.ArrayExpression>;
  isMultiLine: boolean;
  indent: string;
  innerIndent?: string | undefined;
}

interface RegistrationTargetInfo {
  array: AcornESTreeNode<estree.ArrayExpression>;
  insideDCL: boolean;
}

function selectRegistrationTarget(
  targets: RegistrationTargetInfo[],
  isESModule: boolean,
  tagName: string
): RegistrationTargetInfo {
  const target = isESModule
    ? targets.find((candidate) => candidate.insideDCL)
    : targets.find((candidate) => !candidate.insideDCL);

  if (target) {
    return target;
  }

  if (isESModule) {
    throw new FurnaceError('Could not find DOMContentLoaded block in customElements.js', tagName);
  }

  throw new FurnaceError(
    `${tagName} would land in the DOMContentLoaded/importESModule block (Pattern B) instead of the loadSubScript block (Pattern A) — no non-DOMContentLoaded registration array found in customElements.js. The file structure may have changed upstream — manual intervention required.`,
    tagName
  );
}

function buildRegistrationEntry(
  referenceEntry: ASTEntryInfo | undefined,
  tagName: string,
  modulePath: string
): string {
  if (!referenceEntry) {
    return `    ["${tagName}", "${modulePath}"],`;
  }

  if (referenceEntry.isMultiLine) {
    const indent = referenceEntry.indent;
    const inner = referenceEntry.innerIndent ?? indent + '  ';
    return `${indent}[\n${inner}"${tagName}",\n${inner}"${modulePath}",\n${indent}],`;
  }

  return `${referenceEntry.indent}["${tagName}", "${modulePath}"],`;
}

/**
 * AST-based implementation: parses customElements.js, walks to find the
 * target ForOfStatement array, and inserts the new entry at the correct
 * alphabetical position using magic-string.
 */
function addRegistrationAST(
  content: string,
  tagName: string,
  modulePath: string,
  isESModule: boolean
): string {
  validateTagName(tagName);
  const ast = parseScript(content);
  const ancestors: estree.Node[] = [];

  // Collect all ForOfStatement nodes with ArrayExpression rights
  const forOfs: RegistrationTargetInfo[] = [];

  walkAST(ast, {
    enter(node) {
      ancestors.push(node);
      if (node.type === 'ForOfStatement') {
        const forOf = node as AcornESTreeNode<estree.ForOfStatement>;
        if (forOf.right.type === 'ArrayExpression') {
          const array = forOf.right as AcornESTreeNode<estree.ArrayExpression>;
          forOfs.push({
            array,
            insideDCL: isInsideDOMContentLoaded(ancestors, content),
          });
        }
      }
    },
    leave() {
      ancestors.pop();
    },
  });

  // Select the target array
  const target = selectRegistrationTarget(forOfs, isESModule, tagName);

  const array = target.array;

  // Parse existing entries from the ArrayExpression elements
  const entries: ASTEntryInfo[] = [];
  for (const el of array.elements) {
    if (!el || el.type !== 'ArrayExpression') continue;
    const entryArr = el as AcornESTreeNode<estree.ArrayExpression>;
    const firstEl = entryArr.elements[0];
    if (!firstEl || firstEl.type !== 'Literal') continue;
    const tag = String((firstEl as estree.Literal).value);

    // Detect if this entry is multi-line
    const entrySrc = getNodeSource(content, entryArr);
    const isMultiLine = entrySrc.includes('\n');
    const indent = detectIndent(content, entryArr.start);

    let innerIndent: string | undefined;
    if (isMultiLine) {
      const firstElNode = firstEl as AcornESTreeNode<estree.Literal>;
      innerIndent = detectIndent(content, firstElNode.start);
    }

    entries.push({ tag, node: entryArr, isMultiLine, indent, innerIndent });
  }

  // Find alphabetical insertion position
  let insertAfterNode: AcornESTreeNode<estree.ArrayExpression> | null = null;
  let insertBeforeNode: AcornESTreeNode<estree.ArrayExpression> | null = null;
  let referenceEntry: ASTEntryInfo | undefined;

  for (const entry of entries) {
    if (entry.tag > tagName) {
      insertBeforeNode = entry.node;
      if (!referenceEntry) referenceEntry = entry;
      break;
    }
    insertAfterNode = entry.node;
    referenceEntry = entry;
  }

  // Build new entry string matching detected format
  const newEntry = buildRegistrationEntry(referenceEntry, tagName, modulePath);

  const ms = new MagicString(content);

  // Helper: find the start-of-line position for a given offset
  function lineStart(pos: number): number {
    let i = pos - 1;
    while (i >= 0 && content[i] !== '\n') i--;
    return i + 1;
  }

  // Helper: find the end-of-line position (the \n itself) for a given offset
  function lineEnd(pos: number): number {
    let i = pos;
    while (i < content.length && content[i] !== '\n') i++;
    return i;
  }

  // Find the insertion position (character offset)
  if (insertBeforeNode) {
    const sol = lineStart(insertBeforeNode.start);
    ms.appendLeft(sol, newEntry + '\n');
  } else if (insertAfterNode) {
    const eol = lineEnd(insertAfterNode.end);
    ms.appendRight(eol, '\n' + newEntry);
  } else {
    const eol = lineEnd(array.start);
    ms.appendRight(eol, '\n' + newEntry);
  }

  return ms.toString();
}

/**
 * Adds a custom element registration entry to customElements.js.
 *
 * The entry is inserted into the array literal inside the `for...of` loop
 * that registers all custom elements:
 * ```js
 *   ["tag", "chrome://global/content/elements/tag.mjs"],
 * ```
 *
 * New entries are inserted in alphabetical order relative to existing entries.
 * This operation is idempotent — if the tag is already registered the file is
 * left unchanged.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Custom element tag name
 * @param modulePath - chrome:// URI for the module
 */
export async function addCustomElementRegistration(
  engineDir: string,
  tagName: string,
  modulePath: string
): Promise<void> {
  const filePath = join(engineDir, CUSTOM_ELEMENTS_JS);

  if (!(await pathExists(filePath))) {
    throw new FurnaceError('customElements.js not found in engine', tagName);
  }

  const content = await readText(filePath);

  // Idempotency: already registered (standalone block or array entry).
  if (
    content.includes(`setElementCreationCallback("${tagName}"`) ||
    content.includes(`["${tagName}",`) ||
    new RegExp(`^\\s*"${tagName}",\\s*$`, 'm').test(content)
  ) {
    return;
  }

  const isESModule = modulePath.endsWith('.mjs');

  let nextContent: string;
  try {
    nextContent = addRegistrationAST(content, tagName, modulePath, isESModule);
  } catch (error: unknown) {
    if (error instanceof FurnaceError) {
      throw error;
    }

    const parserError = toError(error);
    throw new FurnaceError(
      `Failed to update ${CUSTOM_ELEMENTS_JS} using AST registration parsing: ${parserError.message}`,
      tagName,
      parserError
    );
  }

  validateRegistrationPlacement(nextContent, tagName, isESModule);

  await writeText(filePath, nextContent);
}
