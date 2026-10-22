// SPDX-License-Identifier: EUPL-1.2
/**
 * In-place rename of a custom element registration in customElements.js.
 *
 * Removing the old entry and adding a new one would, on a registration
 * list the remove path cannot see, leave the old entry beside the new one,
 * and the new entry would lack the project marker every sibling line
 * carries (`// <MARKER>:`), so the next lint would flag it as an unmarked
 * engine edit. Rewriting the tag and module
 * literals inside the existing entry keeps the entry's position, layout and
 * trailing marker comments exactly as they were.
 */

import { join } from 'node:path';

import MagicString from 'magic-string';

import { pathExists, readText, writeText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';
import { parseScript } from './ast-utils.js';
import { CUSTOM_ELEMENTS_JS } from './furnace-constants.js';
import { isTagAlreadyRegistered } from './furnace-registration-ast.js';
import { findRegistrationRanges } from './furnace-registration-remove.js';

/**
 * Rewrites the old tag's literals inside one registration's source: the
 * quoted tag itself and the module file name in its chrome:// URI.
 * Everything else in the range (indentation, line breaks, comments between
 * elements) is left byte-for-byte.
 */
function renameRegistrationSource(source: string, oldTag: string, newTag: string): string {
  const escaped = escapeRegex(oldTag);
  return source
    .replace(new RegExp(`(["'])${escaped}\\1`, 'g'), `$1${newTag}$1`)
    .replace(new RegExp(`/${escaped}(\\.m?js["'])`, 'g'), `/${newTag}$1`);
}

/**
 * Renames `oldTag`'s registration in customElements.js in place.
 *
 * Returns false, writing nothing, when the file is missing or unparsable,
 * holds no registration for `oldTag`, or already registers `newTag` (an
 * in-place rewrite would then register it twice); the caller then falls
 * back to remove-and-add, whose add is idempotent. Never parses with a line-based heuristic: an unparsable
 * file is a doctor problem, not something a rename edits around.
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param oldTag - Tag being renamed away from
 * @param newTag - Tag being renamed to
 * @returns True when at least one registration was rewritten
 */
export async function renameCustomElementRegistration(
  engineDir: string,
  oldTag: string,
  newTag: string
): Promise<boolean> {
  const filePath = join(engineDir, CUSTOM_ELEMENTS_JS);
  if (!(await pathExists(filePath))) return false;

  const content = await readText(filePath);
  if (!content.includes(`"${oldTag}"`) && !content.includes(`'${oldTag}'`)) return false;
  if (isTagAlreadyRegistered(content, newTag)) return false;

  let ranges;
  try {
    ranges = findRegistrationRanges(parseScript(content), oldTag);
  } catch {
    return false;
  }
  if (ranges.length === 0) return false;

  const ms = new MagicString(content);
  for (const range of ranges) {
    const source = content.slice(range.start, range.end);
    const renamed = renameRegistrationSource(source, oldTag, newTag);
    if (renamed !== source) ms.overwrite(range.start, range.end, renamed);
  }
  const next = ms.toString();
  if (next === content) return false;
  await writeText(filePath, next);
  return true;
}
