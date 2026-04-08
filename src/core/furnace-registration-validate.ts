// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared validation for furnace custom element registration placement.
 * Used after both AST and legacy code paths to avoid duplicating logic.
 */

import { FurnaceError } from '../errors/furnace.js';

/** Regex for valid custom element tag names. */
export const CUSTOM_ELEMENT_TAG_PATTERN = /^[a-z][a-z0-9]*-[a-z0-9-]*$/;

/**
 * Validates that a tag name conforms to custom element naming requirements.
 * @throws FurnaceError if the tag name is invalid
 */
export function validateTagName(tagName: string): void {
  if (!CUSTOM_ELEMENT_TAG_PATTERN.test(tagName)) {
    throw new FurnaceError(
      `Invalid tag name "${tagName}": must contain a hyphen and match /^[a-z][a-z0-9]*-[a-z0-9-]*$/`,
      tagName
    );
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

  if (isESModule && !hasDCLBefore) {
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
