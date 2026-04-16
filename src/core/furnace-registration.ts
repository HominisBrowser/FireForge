// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import { pathExists, readText, writeText } from '../utils/fs.js';

/** Escapes special regex characters in a literal string. */
function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detects the indentation used by existing `content/global/elements/` lines
 * in jar.mn. Falls back to 3 spaces (the historical Firefox convention) when
 * no reference line is found.
 */
function detectJarMnIndent(lines: string[]): string {
  for (const line of lines) {
    const match = /^(\s+)content\/global\/elements\//.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }
  return '   ';
}

// Re-export everything from the AST module so existing imports keep working
export { CUSTOM_ELEMENTS_JS, JAR_MN } from './furnace-constants.js';
export {
  addCustomElementRegistration,
  removeCustomElementRegistration,
  validateCustomElementRegistration,
} from './furnace-registration-ast.js';
import { JAR_MN } from './furnace-constants.js';

/**
 * Adds jar.mn entries that map chrome:// URIs to on-disk paths for a
 * component's files.
 *
 * ## Assumed jar.mn format
 *
 * Firefox's `toolkit/content/jar.mn` uses a stable format that has not
 * changed in the custom-element era (Firefox 90+). The entry format is:
 *
 * ```
 *    content/global/elements/{file}  (widgets/{tagName}/{file})
 * ```
 *
 * - **Indent**: detected dynamically from the nearest existing
 *   `content/global/elements/` line. Falls back to 3 spaces when no
 *   reference line exists.
 * - **Insertion point**: identified by existing lines matching the regex
 *   `^\s+content\/global\/elements\/([^.]+)\.` — new entries are inserted
 *   in alphabetical order relative to these.
 * - **Fallback**: if no `content/global/elements/` line exists (empty
 *   project), looks for any `content/global/` line and inserts after it.
 * - **Idempotency**: entries already present (checked by exact path match
 *   on `content/global/elements/{file}` with a trailing whitespace or
 *   end-of-line boundary) are skipped.
 *
 * If Firefox upstream changes the jar.mn section ordering or switches to a
 * different resource registration mechanism, the preflight validation in
 * `validateJarMnEntries` will catch the format mismatch before any writes
 * occur.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param tagName - Custom element tag name
 * @param files - Filenames to register (e.g. ["moz-widget.mjs", "moz-widget.css"])
 */
export async function addJarMnEntries(
  engineDir: string,
  tagName: string,
  files: string[]
): Promise<number> {
  const filePath = join(engineDir, JAR_MN);

  if (!(await pathExists(filePath))) {
    throw new FurnaceError('jar.mn not found in engine', tagName);
  }

  let content = await readText(filePath);
  const lines = content.split('\n');

  // Filter to files not already registered. Use a word-boundary-aware
  // check so that "moz-card.css" does not match "moz-card-group.css".
  const newFiles = files.filter(
    (f) => !new RegExp(`content/global/elements/${escapeForRegex(f)}(?:\\s|$)`, 'm').test(content)
  );

  if (newFiles.length === 0) return 0;

  // Build new entry lines using the indent detected from existing entries.
  const indent = detectJarMnIndent(lines);
  const newEntries = newFiles.map(
    (f) => `${indent}content/global/elements/${f}  (widgets/${tagName}/${f})`
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
    const nonEmpty = lines.some((line) => line.trim().length > 0);
    if (!nonEmpty) {
      throw new FurnaceError(
        'jar.mn is empty or contains only whitespace. It may be malformed — verify the engine was downloaded correctly.',
        tagName
      );
    }
    throw new FurnaceError(
      'Could not find a content/global/ section in jar.mn for element entries. The file may be malformed.',
      tagName
    );
  }

  lines.splice(insertIndex, 0, ...newEntries);

  content = lines.join('\n');
  await writeText(filePath, content);
  return newFiles.length;
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
  // Use a regex with word boundary so "moz-card" does not match "moz-card-group".
  const pattern = new RegExp(`content/global/elements/${escapeForRegex(tagName)}\\.`);

  const filtered = lines.filter((line) => !pattern.test(line));

  if (filtered.length === lines.length) return;

  content = filtered.join('\n');
  await writeText(filePath, content);
}

/**
 * Validates that jar.mn entries *could* be added without writing anything.
 * Used by dry-run to surface structural problems early.
 */
export async function validateJarMnEntries(
  engineDir: string,
  tagName: string,
  files: string[]
): Promise<void> {
  const filePath = join(engineDir, JAR_MN);

  if (!(await pathExists(filePath))) {
    throw new FurnaceError('jar.mn not found in engine', tagName);
  }

  const content = await readText(filePath);
  const lines = content.split('\n');

  const newFiles = files.filter(
    (f) => !new RegExp(`content/global/elements/${escapeForRegex(f)}(?:\\s|$)`, 'm').test(content)
  );
  if (newFiles.length === 0) return;

  const elementLinePattern = /^\s+content\/global\/elements\/([^.]+)\./;
  let hasInsertionPoint = false;

  for (const line of lines) {
    if (elementLinePattern.test(line)) {
      hasInsertionPoint = true;
      break;
    }
  }

  if (!hasInsertionPoint) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== undefined && /^\s+content\/global\//.test(line)) {
        hasInsertionPoint = true;
        break;
      }
    }
  }

  if (!hasInsertionPoint) {
    const nonEmpty = lines.some((line) => line.trim().length > 0);
    if (!nonEmpty) {
      throw new FurnaceError(
        'jar.mn is empty or contains only whitespace. It may be malformed — verify the engine was downloaded correctly.',
        tagName
      );
    }
    throw new FurnaceError(
      'Could not find a content/global/ section in jar.mn for element entries. The file may be malformed.',
      tagName
    );
  }
}
