// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared validation for furnace custom element registration placement.
 * Used after both AST and legacy code paths to avoid duplicating logic.
 */

import { FurnaceError } from '../errors/furnace.js';

/**
 * Regex for valid custom element tag names. A valid name is lowercase, starts
 * with a letter, and contains one or more hyphen-separated groups where each
 * group is a non-empty alphanumeric run. Consecutive hyphens and trailing
 * hyphens are both rejected. Kept in sync with the HTML custom element spec
 * requirement that a name contain at least one hyphen.
 *
 * A single shared constant is used by every furnace authoring path
 * (`furnace create`, `furnace override`, and the AST registration helper) so
 * that a name accepted by one command cannot be rejected by another.
 */
export const CUSTOM_ELEMENT_TAG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** Human-readable description of the tag-name rules, for CLI error messages. */
export const CUSTOM_ELEMENT_TAG_RULES =
  'must be lowercase, start with a letter, and use hyphens to separate non-empty alphanumeric groups (e.g., "my-widget")';

/**
 * Validates that a tag name conforms to custom element naming requirements.
 * @throws FurnaceError if the tag name is invalid
 */
export function validateTagName(tagName: string): void {
  if (!CUSTOM_ELEMENT_TAG_PATTERN.test(tagName)) {
    throw new FurnaceError(`Invalid tag name "${tagName}": ${CUSTOM_ELEMENT_TAG_RULES}`, tagName);
  }
}

/**
 * Validates that a registration entry landed in the correct block
 * (Pattern A = loadSubScript, Pattern B = DOMContentLoaded/importESModule).
 *
 * @param result - The full file content after insertion
 * @param tagName - The tag that was inserted
 * @param isESModule - Whether the module uses ESM (Pattern B) or not (Pattern A)
 */
export function validateRegistrationPlacement(
  result: string,
  tagName: string,
  isESModule: boolean
): void {
  const dclPattern = /document\.addEventListener\(\s*["']DOMContentLoaded["']/;
  const insertedPos = result.lastIndexOf(`"${tagName}"`);
  if (insertedPos === -1) return;

  const contentBeforeTag = result.slice(0, insertedPos);
  const hasDCLBefore = dclPattern.test(contentBeforeTag);

  if (isESModule && !hasDCLBefore && !isTagInArrayConsumedInsideDOMContentLoaded(result, tagName)) {
    throw new FurnaceError(
      `${tagName} was registered in the loadSubScript block (Pattern A) instead of the DOMContentLoaded/importESModule block (Pattern B). This will cause the component to fail at runtime. The customElements.js file structure may have changed upstream — manual intervention required.`,
      tagName
    );
  }
  if (!isESModule && hasDCLBefore) {
    throw new FurnaceError(
      `${tagName} was registered in the DOMContentLoaded/importESModule block (Pattern B) instead of the loadSubScript block (Pattern A). This will cause the component to fail at runtime. The customElements.js file structure may have changed upstream — manual intervention required.`,
      tagName
    );
  }
}

function isTagInArrayConsumedInsideDOMContentLoaded(content: string, tagName: string): boolean {
  const dclMatch = /document\.addEventListener\(\s*["']DOMContentLoaded["']/.exec(content);
  if (!dclMatch) return false;

  const beforeDcl = content.slice(0, dclMatch.index);
  const afterDcl = content.slice(dclMatch.index);
  const consumedArrays = new Set<string>();
  const forOfPattern = /for\s*\(\s*(?:let|const|var)\s*\[[^)]*\]\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = forOfPattern.exec(afterDcl)) !== null) {
    if (match[1]) consumedArrays.add(match[1]);
  }

  for (const arrayName of consumedArrays) {
    const declarationPattern = new RegExp(
      `(?:const|let|var)\\s+${escapeRegex(arrayName)}\\s*=\\s*\\[([\\s\\S]*?)\\];`
    );
    const declaration = declarationPattern.exec(beforeDcl);
    if (declaration?.[1] && new RegExp(`["']${escapeRegex(tagName)}["']`).test(declaration[1])) {
      return true;
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
