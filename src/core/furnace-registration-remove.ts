// SPDX-License-Identifier: EUPL-1.2
/**
 * Removal of custom element registrations from customElements.js.
 * Supports three removal strategies: standalone callback, single-line array, multi-line array.
 */

import { join } from 'node:path';

import { pathExists, readText, writeText } from '../utils/fs.js';
import { CUSTOM_ELEMENTS_JS } from './furnace-constants.js';

/**
 * Removes a custom element registration from customElements.js.
 *
 * This operation is idempotent — if the tag is not registered or the file does
 * not exist, nothing happens.
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

  let content = await readText(filePath);
  const lines = content.split('\n');

  // Strategy 1: Remove standalone callback block (setElementCreationCallback("tagName" …))
  const callbackLine = lines.findIndex((l) =>
    l.includes(`setElementCreationCallback("${tagName}"`)
  );
  if (callbackLine !== -1) {
    let endLine = callbackLine;
    for (let i = callbackLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (/^\s*\}\);/.test(line)) {
        endLine = i;
        break;
      }
    }

    let startLine = callbackLine;
    const precedingLine = lines[startLine - 1];
    if (startLine > 0 && precedingLine !== undefined && precedingLine.trim() === '') {
      startLine--;
    }

    lines.splice(startLine, endLine - startLine + 1);
    content = lines.join('\n');
    await writeText(filePath, content);
    return;
  }

  // Strategy 2: Remove single-line array entry  ["tagName", "..."],
  const singleLineIdx = lines.findIndex((l) =>
    new RegExp(`^\\s*\\["${tagName}",\\s*"[^"]*"\\],?\\s*$`).test(l)
  );
  if (singleLineIdx !== -1) {
    lines.splice(singleLineIdx, 1);
    content = lines.join('\n');
    await writeText(filePath, content);
    return;
  }

  // Strategy 3: Remove multi-line array entry where "tagName", is on its own line
  const multiLineTagIdx = lines.findIndex((l) => new RegExp(`^\\s*"${tagName}",\\s*$`).test(l));
  if (multiLineTagIdx !== -1) {
    // Scan backwards from the tag line to find the opening [ (bounded to 20 lines)
    let startLine = multiLineTagIdx;
    const scanLimit = Math.max(0, multiLineTagIdx - 20);
    for (let i = multiLineTagIdx - 1; i >= scanLimit; i--) {
      const line = lines[i];
      if (line !== undefined && /^\s*\[$/.test(line)) {
        startLine = i;
        break;
      }
    }
    const openIndent = (lines[startLine] ?? '').match(/^(\s*)/)?.[1]?.length ?? 0;
    // Scan forwards from the tag line to find the closing ],
    let endLine = multiLineTagIdx;
    for (let i = multiLineTagIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && /^\s*\],?\s*$/.test(line)) {
        const closeIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (closeIndent === openIndent) {
          endLine = i;
          break;
        }
      }
    }

    lines.splice(startLine, endLine - startLine + 1);
    content = lines.join('\n');
    await writeText(filePath, content);
    return;
  }

  // Tag not found in any form — idempotent no-op
}
