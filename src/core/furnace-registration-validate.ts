// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared validation for furnace custom element registration placement.
 * Used after both AST and legacy code paths to avoid duplicating logic.
 */

import { FurnaceError } from '../errors/furnace.js';
import { escapeRegex, stripJsComments } from '../utils/regex.js';

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
  const problem = describeTagNameProblem(tagName);
  if (problem !== undefined) {
    throw new FurnaceError(problem, tagName);
  }
}

/**
 * Returns why `tagName` is invalid, or `undefined` when it is fine.
 *
 * The message-returning half of {@link validateTagName}, for callers that
 * must not throw — specifically clack `validate` callbacks, which expect a
 * returned string and re-prompt on it. Passing the THROWING form to one
 * makes an invalid tag name escape clack's validation loop as a
 * `FurnaceError`, killing the prompt instead of showing the rule inline.
 *
 * @param tagName - Candidate custom element tag name
 * @returns The rule violation, or undefined when the name is valid
 */
export function describeTagNameProblem(tagName: string): string | undefined {
  if (!CUSTOM_ELEMENT_TAG_PATTERN.test(tagName)) {
    return `Invalid tag name "${tagName}": ${CUSTOM_ELEMENT_TAG_RULES}`;
  }
  return undefined;
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
  const insertedPos = result.lastIndexOf(`"${tagName}"`);
  if (insertedPos === -1) return;

  if (!isTagInCorrectCustomElementsPlacement(result, tagName, isESModule)) {
    if (!isESModule) {
      throw new FurnaceError(
        `${tagName} was registered in the DOMContentLoaded/importESModule block (Pattern B) instead of the loadSubScript block (Pattern A). This will cause the component to fail at runtime. The customElements.js file structure may have changed upstream — manual intervention required.`,
        tagName
      );
    }
    throw new FurnaceError(
      `${tagName} was registered in the loadSubScript block (Pattern A) instead of the DOMContentLoaded/importESModule block (Pattern B). This will cause the component to fail at runtime. The customElements.js file structure may have changed upstream — manual intervention required.`,
      tagName
    );
  }
}

/**
 * Returns whether a tag appears in the correct customElements.js placement.
 * ESM entries may either appear textually inside/after DOMContentLoaded or
 * inside an array declared before DOMContentLoaded and consumed by a for-of
 * loop inside the listener, as Firefox 152 Beta does for acornElements.
 */
export function isTagInCorrectCustomElementsPlacement(
  content: string,
  tagName: string,
  isESModule: boolean
): boolean {
  const stripped = stripJsComments(content);
  const tagPattern = new RegExp(`["']${escapeRegex(tagName)}["']`);
  const dclMatch = /document\.addEventListener\(\s*["']DOMContentLoaded["']/.exec(stripped);
  if (!dclMatch) {
    return !isESModule && tagPattern.test(stripped);
  }

  const beforeDcl = stripped.slice(0, dclMatch.index);
  const afterDcl = stripped.slice(dclMatch.index);
  const tagBeforeDcl = tagPattern.test(beforeDcl);
  const tagAfterDcl = tagPattern.test(afterDcl);

  if (!isESModule) {
    return tagBeforeDcl && !tagAfterDcl;
  }
  return (
    tagAfterDcl || isTagInArrayConsumedInsideDOMContentLoaded(stripped, dclMatch.index, tagName)
  );
}

function isTagInArrayConsumedInsideDOMContentLoaded(
  content: string,
  domContentLoadedIdx: number,
  tagName: string
): boolean {
  const beforeDcl = content.slice(0, domContentLoadedIdx);
  const afterDcl = content.slice(domContentLoadedIdx);
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
