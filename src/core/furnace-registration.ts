// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import { pathExists, readText, writeText } from '../utils/fs.js';

// Re-export everything from the AST module so existing imports keep working
export { CUSTOM_ELEMENTS_JS, JAR_MN } from './furnace-constants.js';
export {
  addCustomElementRegistration,
  removeCustomElementRegistration,
} from './furnace-registration-ast.js';
import { JAR_MN } from './furnace-constants.js';

/**
 * Adds jar.mn entries that map chrome:// URIs to on-disk paths for a
 * component's files.
 *
 * Entry format (3-space indent, spaces not tabs):
 * ```
 *    content/global/elements/{file}  (widgets/{tagName}/{file})
 * ```
 *
 * New entries are inserted in alphabetical order relative to existing
 * `content/global/elements/` entries. The operation is idempotent.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Custom element tag name
 * @param files - Filenames to register (e.g. ["moz-widget.mjs", "moz-widget.css"])
 */
export async function addJarMnEntries(
  engineDir: string,
  tagName: string,
  files: string[]
): Promise<void> {
  const filePath = join(engineDir, JAR_MN);

  if (!(await pathExists(filePath))) {
    throw new FurnaceError('jar.mn not found in engine', tagName);
  }

  let content = await readText(filePath);
  const lines = content.split('\n');

  // Filter to files not already registered
  const newFiles = files.filter((f) => !content.includes(`content/global/elements/${f}`));

  if (newFiles.length === 0) return;

  // Build new entry lines
  const newEntries = newFiles.map(
    (f) => `   content/global/elements/${f}  (widgets/${tagName}/${f})`
  );

  // Find insertion point among existing content/global/elements/ lines
  const elementLinePattern = /^\s+content\/global\/elements\/([^.]+)\./;
  let insertIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = elementLinePattern.exec(line);
    if (match) {
      const existingTag = match[1] ?? '';
      if (existingTag > tagName) {
        insertIndex = i;
        break;
      }
      // Track last element entry line as fallback (insert after it)
      insertIndex = i + 1;
    }
  }

  if (insertIndex === -1) {
    // Fallback: find last content/global/ line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== undefined && /^\s+content\/global\//.test(line)) {
        insertIndex = i + 1;
        break;
      }
    }
  }

  if (insertIndex === -1) {
    throw new FurnaceError('Could not find insertion point in jar.mn for element entries', tagName);
  }

  lines.splice(insertIndex, 0, ...newEntries);

  content = lines.join('\n');
  await writeText(filePath, content);
}

/**
 * Removes all jar.mn entries for a given tag name.
 *
 * This operation is idempotent — if no entries exist or the file is missing,
 * nothing happens.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Custom element tag name whose entries should be removed
 */
export async function removeJarMnEntries(engineDir: string, tagName: string): Promise<void> {
  const filePath = join(engineDir, JAR_MN);

  if (!(await pathExists(filePath))) {
    return;
  }

  let content = await readText(filePath);
  const lines = content.split('\n');
  const pattern = `content/global/elements/${tagName}.`;

  const filtered = lines.filter((line) => !line.includes(pattern));

  if (filtered.length === lines.length) return;

  content = filtered.join('\n');
  await writeText(filePath, content);
}
