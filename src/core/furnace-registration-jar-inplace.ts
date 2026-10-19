// SPDX-License-Identifier: EUPL-1.2
/**
 * In-place edits to a widget's `toolkit/content/jar.mn` block.
 *
 * Undeploying one file and renaming a component used to drop every line of
 * the widget and re-add the live ones, which re-sorted the whole block and
 * left the owning patch carrying reorder hunks. These helpers touch only
 * the lines that change: a deleted file's line goes, a renamed component's
 * lines are rewritten where they stand, and anything still missing is left
 * for `addJarMnEntries` to insert.
 */
import { join } from 'node:path';

import { pathExists, readText, writeText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';
import { JAR_MN } from './furnace-constants.js';

/**
 * The file a widget jar.mn line registers: the `(widgets/<tag>/<file>)`
 * source mapping, or the legacy `content/global/elements/<tag>.<ext>`
 * target written before the mapping existed. Undefined when the line is
 * not one of this tag's.
 */
function registeredFile(line: string, tagName: string): string | undefined {
  const tag = escapeRegex(tagName);
  const source = new RegExp(`\\(widgets/${tag}/([^)]+)\\)`).exec(line);
  if (source) return source[1];
  const legacy = new RegExp(`content/global/elements/(${tag}\\.[^\\s]+)`).exec(line);
  return legacy?.[1];
}

/**
 * Removes the lines registering `files` for `tagName`, leaving every other
 * line of the block where it is. Returns how many lines were removed.
 */
export async function removeJarMnFileEntries(
  engineDir: string,
  tagName: string,
  files: readonly string[]
): Promise<number> {
  const filePath = join(engineDir, JAR_MN);
  if (files.length === 0 || !(await pathExists(filePath))) return 0;
  const doomed = new Set(files);
  const lines = (await readText(filePath)).split('\n');
  const kept = lines.filter((line) => {
    const file = registeredFile(line, tagName);
    return file === undefined || !doomed.has(file);
  });
  const removed = lines.length - kept.length;
  if (removed > 0) await writeText(filePath, kept.join('\n'));
  return removed;
}

/**
 * Rewrites `oldTag`'s lines in place as `newTag`'s. A line whose renamed
 * file is in `liveFiles` keeps its position and layout; one whose file is
 * gone is dropped. Returns the renamed files that already had a line; the
 * caller's `addJarMnEntries` pass then inserts only the rest.
 */
export async function renameJarMnEntriesInPlace(
  engineDir: string,
  oldTag: string,
  newTag: string,
  liveFiles: readonly string[],
  renameFile: (file: string) => string
): Promise<string[]> {
  const filePath = join(engineDir, JAR_MN);
  if (!(await pathExists(filePath))) return [];
  const live = new Set(liveFiles);
  const covered: string[] = [];
  const out: string[] = [];
  for (const line of (await readText(filePath)).split('\n')) {
    const file = registeredFile(line, oldTag);
    if (file === undefined) {
      out.push(line);
      continue;
    }
    const renamed = renameFile(file);
    if (!live.has(renamed) || covered.includes(renamed)) continue;
    // Textual substitution keeps the indent, column spacing and any
    // trailing comment the line carried.
    out.push(
      line
        .replace(`content/global/elements/${file}`, `content/global/elements/${renamed}`)
        .replace(`(widgets/${oldTag}/${file})`, `(widgets/${newTag}/${renamed})`)
    );
    covered.push(renamed);
  }
  await writeText(filePath, out.join('\n'));
  return covered;
}
