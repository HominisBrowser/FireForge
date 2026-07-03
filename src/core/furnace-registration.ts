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
 * `validateJarMnInsertionForFiles` will catch the format mismatch before any writes
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
 * Adds a locale jar.mn entry mapping `<chromeSubPath>/<tagName>.ftl` to the
 * on-disk `.ftl` that `furnace apply` just copied under the FTL tree. Without
 * this entry the chrome URI passed to `window.MozXULElement.insertFTLIfNeeded`
 * does not resolve at runtime, so the generated `--localized` component
 * silently ships broken l10n.
 *
 * Degrades gracefully — if the locale jar.mn (e.g. `toolkit/locales/jar.mn`)
 * does not exist, returns 0 rather than throwing, so a custom fork without a
 * standard locales package can still apply a localized component.
 *
 * The written entry mirrors the Mozilla convention for toolkit widgets:
 *
 *   locale/@AB_CD@/<chromeSubPath>/<tagName>.ftl (%<chromeSubPath>/<tagName>.ftl)
 *
 * @param engineDir - Path to the Firefox engine source root
 * @param jarMnRelPath - Engine-relative path to the locale jar.mn
 * @param tagName - Custom element tag name (base of the `.ftl` file)
 * @param chromeSubPath - Chrome sub-path (e.g. `toolkit/global`)
 * @returns Number of entries inserted (0 when already present, or jar.mn missing)
 */
export async function addLocaleFtlJarMnEntry(
  engineDir: string,
  jarMnRelPath: string,
  tagName: string,
  chromeSubPath: string
): Promise<number> {
  const filePath = join(engineDir, jarMnRelPath);

  if (!(await pathExists(filePath))) {
    return 0;
  }

  const content = await readText(filePath);
  const lines = content.split('\n');

  const ftlFile = `${tagName}.ftl`;
  const escapedTag = escapeForRegex(tagName);
  const escapedChrome = escapeForRegex(chromeSubPath);
  const presencePattern = new RegExp(
    `locale\\/(?:@AB_CD@|[a-zA-Z-]+)\\/${escapedChrome}\\/${escapedTag}\\.ftl`,
    'm'
  );
  if (presencePattern.test(content)) {
    return 0;
  }

  const indent = detectLocaleJarMnIndent(lines, chromeSubPath);
  const newEntry = `${indent}locale/@AB_CD@/${chromeSubPath}/${ftlFile} (%${chromeSubPath}/${ftlFile})`;

  const sectionPattern = new RegExp(
    `^(\\s+)locale\\/(?:@AB_CD@|[a-zA-Z-]+)\\/${escapedChrome}\\/([^.\\s]+)\\.ftl`
  );
  let insertIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = sectionPattern.exec(line);
    if (match) {
      const existingTag = match[2] ?? '';
      if (existingTag > tagName) {
        insertIndex = i;
        break;
      }
      insertIndex = i + 1;
    }
  }

  if (insertIndex === -1) {
    // No existing entries under this chrome sub-path. Fall back to end-of-file
    // placement so the operator can reorder manually if desired.
    insertIndex = lines.length;
  }

  lines.splice(insertIndex, 0, newEntry);
  await writeText(filePath, lines.join('\n'));
  return 1;
}

/** Detects locale jar.mn indentation by sampling an existing matching entry. */
function detectLocaleJarMnIndent(lines: string[], chromeSubPath: string): string {
  const escapedChrome = escapeForRegex(chromeSubPath);
  const pattern = new RegExp(`^(\\s+)locale\\/(?:@AB_CD@|[a-zA-Z-]+)\\/${escapedChrome}\\/`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  // Fall back to detecting any existing `locale/...` indent before giving up.
  for (const line of lines) {
    const match = /^(\s+)locale\//.exec(line);
    if (match?.[1]) return match[1];
  }
  return '  ';
}

/**
 * Removes a locale jar.mn entry previously written by `addLocaleFtlJarMnEntry`.
 * Idempotent — if the entry is absent or the file is missing, nothing happens.
 */
export async function removeLocaleFtlJarMnEntry(
  engineDir: string,
  jarMnRelPath: string,
  tagName: string,
  chromeSubPath: string
): Promise<void> {
  const filePath = join(engineDir, jarMnRelPath);

  if (!(await pathExists(filePath))) {
    return;
  }

  const content = await readText(filePath);
  const lines = content.split('\n');
  const pattern = new RegExp(
    `locale\\/(?:@AB_CD@|[a-zA-Z-]+)\\/${escapeForRegex(chromeSubPath)}\\/${escapeForRegex(tagName)}\\.ftl`
  );

  const filtered = lines.filter((line) => !pattern.test(line));
  if (filtered.length === lines.length) return;

  await writeText(filePath, filtered.join('\n'));
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
  // Match by the SOURCE MAPPING segment `(widgets/<tagName>/...)` so every
  // line the component registered is removed regardless of the target
  // basename — a helper `.mjs` whose name does not start with the tag
  // (e.g. a renamed `foo-utils.mjs`) used to survive the remove pass and
  // leave a stale registration that broke packaging (0.34.0 field
  // report). The legacy target-path match is kept as an OR for lines
  // written by older FireForge versions without a source mapping. Word
  // boundaries keep "moz-card" from matching "moz-card-group".
  const sourcePattern = new RegExp(`\\(widgets/${escapeForRegex(tagName)}/`);
  const legacyTargetPattern = new RegExp(`content/global/elements/${escapeForRegex(tagName)}\\.`);

  const filtered = lines.filter(
    (line) => !sourcePattern.test(line) && !legacyTargetPattern.test(line)
  );

  if (filtered.length === lines.length) return;

  content = filtered.join('\n');
  await writeText(filePath, content);
}

/** A jar.mn widget registration line whose source file no longer exists. */
export interface StaleJarMnEntry {
  /** Component tag name from the `(widgets/<tag>/<file>)` source mapping. */
  tagName: string;
  /** File name from the source mapping. */
  fileName: string;
  /** The full (trimmed) jar.mn line. */
  line: string;
}

const WIDGET_SOURCE_MAPPING_PATTERN = /\(widgets\/([^/)]+)\/([^)]+)\)/;

/**
 * Scans jar.mn for widget registration lines `(widgets/<tag>/<file>)`
 * whose workspace source file no longer exists (0.34.0 field report: a
 * renamed component helper left the old line pointing at a deleted file,
 * and every build failed at packaging). Only tags in `managedTags`
 * (furnace-managed custom components) are inspected so upstream lines are
 * never touched.
 */
export async function findStaleJarMnEntries(
  engineDir: string,
  customDir: string,
  managedTags: readonly string[]
): Promise<StaleJarMnEntry[]> {
  const filePath = join(engineDir, JAR_MN);
  if (!(await pathExists(filePath))) return [];

  const managed = new Set(managedTags);
  const stale: StaleJarMnEntry[] = [];
  for (const line of (await readText(filePath)).split('\n')) {
    const match = WIDGET_SOURCE_MAPPING_PATTERN.exec(line);
    if (!match) continue;
    const tagName = match[1] ?? '';
    const fileName = match[2] ?? '';
    if (!managed.has(tagName)) continue;
    if (!(await pathExists(join(customDir, tagName, fileName)))) {
      stale.push({ tagName, fileName, line: line.trim() });
    }
  }
  return stale;
}

/**
 * Removes every stale widget registration line found by
 * {@link findStaleJarMnEntries}. Returns the removed entries. Used by
 * `furnace validate --fix` and `doctor --repair-furnace`.
 */
export async function pruneStaleJarMnEntries(
  engineDir: string,
  customDir: string,
  managedTags: readonly string[]
): Promise<StaleJarMnEntry[]> {
  const stale = await findStaleJarMnEntries(engineDir, customDir, managedTags);
  if (stale.length === 0) return [];

  const filePath = join(engineDir, JAR_MN);
  const staleLines = new Set(stale.map((entry) => entry.line));
  const lines = (await readText(filePath)).split('\n');
  const filtered = lines.filter((line) => !staleLines.has(line.trim()));
  await writeText(filePath, filtered.join('\n'));
  return stale;
}

/**
 * Validates that jar.mn entries *could* be added without writing anything.
 * Used by dry-run to surface structural problems early.
 */
export async function validateJarMnInsertionForFiles(
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
