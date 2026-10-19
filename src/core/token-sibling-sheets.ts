// SPDX-License-Identifier: EUPL-1.2
/**
 * Which stylesheets load together, so `token lint` can resolve a token one
 * sheet references against the declarations of the sheets beside it.
 *
 * A widget sheet may read a token its host document's other sheet
 * declares; judged alone it looks undeclared. Two sources say which sheets
 * share a document:
 *
 * - links the queue's documents make: `<link rel="stylesheet">` (and
 *   `<html:link>`) and `<?xml-stylesheet?>` in markup and Lit templates,
 *   and CSS `@import`. A `chrome://` URL resolves through the jar.mn lines
 *   the queue adds; a relative URL resolves beside the document, and only
 *   to a sheet the queue touches.
 * - `furnace.json#tokenSiblingSheets`: `{ "<glob>": ["<path or glob>"] }`,
 *   for pairings no link in the queue shows (an upstream host document).
 *
 * Sheets linked from one document are siblings of each other; an
 * `@import` makes the importing and the imported sheet siblings.
 */

import { dirname, posix } from 'node:path';

import { matchesAnyGlob } from '../utils/path-glob.js';
import { normalizePathSlashes } from '../utils/paths.js';

const LINK_TAG = /<(?:html:)?link\b[^>]*>/gi;
const STYLESHEET_PI = /<\?xml-stylesheet\b[^?]*?href\s*=\s*["']([^"']+)["']/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/gi;

/** The stylesheet URLs one document or sheet loads, in order. */
export function collectStylesheetUrls(file: string, content: string): string[] {
  const urls: string[] = [];
  if (file.endsWith('.css')) {
    for (const match of content.matchAll(CSS_IMPORT)) urls.push(match[1] ?? '');
    return urls.filter((url) => url !== '');
  }
  for (const match of content.matchAll(LINK_TAG)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"'$]+)["']/i.exec(tag)?.[1];
    if (href !== undefined) urls.push(href);
  }
  for (const match of content.matchAll(STYLESHEET_PI)) urls.push(match[1] ?? '');
  return urls.filter((url) => url.endsWith('.css'));
}

/**
 * Resolves a stylesheet URL to an engine-relative path, or undefined.
 *
 * @param url - The URL as written
 * @param from - Engine-relative path of the document or sheet holding it
 * @param jarTargets - jar target (`content/<pkg>/<path>`) → packaged source
 * @param knownSheets - Sheets a relative URL may resolve to
 */
export function resolveStylesheetUrl(
  url: string,
  from: string,
  jarTargets: ReadonlyMap<string, string>,
  knownSheets: ReadonlySet<string>
): string | undefined {
  const chrome = /^chrome:\/\/([\w.-]+)\/(content|skin|locale)\/(.+)$/.exec(url);
  if (chrome !== null) {
    const [, pkg = '', kind = '', path = ''] = chrome;
    const candidates =
      kind === 'skin'
        ? [`skin/classic/${pkg}/${path}`, `skin/${pkg}/${path}`]
        : [`${kind}/${pkg}/${path}`];
    for (const target of candidates) {
      const source = jarTargets.get(target);
      if (source !== undefined) return source;
    }
    return undefined;
  }
  if (/^[a-z][\w+.-]*:/i.test(url)) return undefined;
  const base = normalizePathSlashes(dirname(from));
  const resolved = posix.normalize(posix.join(base === '.' ? '' : base, url));
  return knownSheets.has(resolved) ? resolved : undefined;
}

/** Inputs of {@link buildSiblingSheetMap}. */
export interface SiblingSheetInputs {
  /** Documents and sheets to read links from: engine-relative path and content. */
  documents: Iterable<readonly [string, string]>;
  /** jar target → packaged source, from the queue's jar.mn lines. */
  jarTargets: ReadonlyMap<string, string>;
  /** The sheets `token lint` judges. */
  sheets: readonly string[];
  /** `furnace.json#tokenSiblingSheets`. */
  explicit?: Readonly<Record<string, readonly string[]>> | undefined;
}

/**
 * Maps each sheet to the other sheets that load beside it. A sheet with no
 * siblings is absent.
 */
export function buildSiblingSheetMap(inputs: SiblingSheetInputs): Map<string, Set<string>> {
  const known = new Set(inputs.sheets);
  const siblings = new Map<string, Set<string>>();
  const link = (group: readonly string[]): void => {
    for (const sheet of group) {
      const set = siblings.get(sheet) ?? new Set<string>();
      for (const other of group) if (other !== sheet) set.add(other);
      if (set.size > 0) siblings.set(sheet, set);
    }
  };
  for (const [file, content] of inputs.documents) {
    const linked = collectStylesheetUrls(file, content)
      .map((url) => resolveStylesheetUrl(url, file, inputs.jarTargets, known))
      .filter((sheet): sheet is string => sheet !== undefined);
    // An @import pairs the importing sheet with what it imports.
    link(file.endsWith('.css') ? [file, ...linked] : linked);
  }
  for (const [pattern, partners] of Object.entries(inputs.explicit ?? {})) {
    const owners = inputs.sheets.filter((sheet) => matchesAnyGlob(sheet, [pattern]));
    for (const owner of owners) {
      const set = siblings.get(owner) ?? new Set<string>();
      for (const partner of partners) {
        if (/[*?]/.test(partner)) {
          for (const sheet of inputs.sheets) {
            if (sheet !== owner && matchesAnyGlob(sheet, [partner])) set.add(sheet);
          }
        } else if (partner !== owner) {
          set.add(partner);
        }
      }
      if (set.size > 0) siblings.set(owner, set);
    }
  }
  return siblings;
}
