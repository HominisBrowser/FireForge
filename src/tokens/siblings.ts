// SPDX-License-Identifier: EUPL-1.2
/**
 * Which stylesheets load together, so that a token one sheet references can
 * be looked up in the sheets beside it. Sheets linked from one document are
 * siblings of each other, as are a sheet and what it `@import`s. Links are
 * read from `<link rel="stylesheet">`, `<?xml-stylesheet?>` and `@import`;
 * `chrome://` URLs resolve through jar.mn, relative URLs beside the document.
 * Settings add pairings no link shows.
 */
import { posix } from 'node:path';

import { matchesAnyGlob } from '../kernel/glob.js';
import { manifestKind, parseJar, resolveManifestPath } from '../mozbuild/index.js';
import type { OwnedFiles, TokenSettings } from './settings.js';

const LINK_TAG = /<(?:html:)?link\b[^>]*>/gi;
const STYLESHEET_PI = /<\?xml-stylesheet\b[^?]*?href\s*=\s*["']([^"']+)["']/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/gi;

/** The stylesheet URLs a document or sheet loads. */
function stylesheetUrls(file: string, content: string): string[] {
  if (file.endsWith('.css')) return [...content.matchAll(CSS_IMPORT)].map((m) => m[1] ?? '');
  const urls: string[] = [];
  for (const [tag] of content.matchAll(LINK_TAG)) {
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"'$]+)["']/i.exec(tag)?.[1];
    if (href !== undefined) urls.push(href);
  }
  for (const match of content.matchAll(STYLESHEET_PI)) urls.push(match[1] ?? '');
  return urls.filter((url) => url.endsWith('.css'));
}

/** jar target (`content/<package>/<path>`) to the engine path it packages, over the owned jar manifests. */
async function jarTargets(owned: OwnedFiles): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  for (const manifest of owned.paths.filter((path) => manifestKind(path) === 'jar')) {
    for (const entry of parseJar((await owned.read(manifest)) ?? '').entries) {
      if (entry.source === undefined || entry.localized) continue;
      const exact = resolveManifestPath(manifest, entry.source)?.exact;
      if (exact !== undefined) targets.set(entry.target, exact);
    }
  }
  return targets;
}

function resolveUrl(
  url: string,
  from: string,
  targets: ReadonlyMap<string, string>,
  sheets: ReadonlySet<string>
): string | undefined {
  const chrome = /^chrome:\/\/([\w.-]+)\/(content|skin|locale)\/(.+)$/.exec(url);
  if (chrome !== null) {
    const [, pkg = '', kind = '', path = ''] = chrome;
    const candidates =
      kind === 'skin'
        ? [`skin/classic/${pkg}/${path}`, `skin/${pkg}/${path}`]
        : [`${kind}/${pkg}/${path}`];
    return candidates.map((target) => targets.get(target)).find((source) => source !== undefined);
  }
  if (/^[a-z][\w+.-]*:/i.test(url)) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(from), url));
  return sheets.has(resolved) ? resolved : undefined;
}

/**
 * Maps each sheet to the sheets that load beside it. A sheet with no
 * siblings is absent.
 *
 * @param owned - The project's files: the documents to read links from, and jar manifests
 * @param sheets - The sheets being judged
 * @param settings - `siblingSheets` pairings
 */
export async function siblingSheets(
  owned: OwnedFiles,
  sheets: readonly string[],
  settings: TokenSettings
): Promise<Map<string, Set<string>>> {
  const known = new Set(sheets);
  const targets = await jarTargets(owned);
  const siblings = new Map<string, Set<string>>();
  const link = (group: readonly string[]): void => {
    for (const sheet of group) {
      const set = siblings.get(sheet) ?? new Set<string>();
      for (const other of group) if (other !== sheet) set.add(other);
      if (set.size > 0) siblings.set(sheet, set);
    }
  };
  for (const file of owned.paths.filter((path) => /\.(?:css|xhtml|html|xml|mjs|js)$/.test(path))) {
    const linked = stylesheetUrls(file, (await owned.read(file)) ?? '')
      .map((url) => resolveUrl(url, file, targets, known))
      .filter((sheet): sheet is string => sheet !== undefined);
    link(file.endsWith('.css') ? [file, ...linked] : linked);
  }
  for (const [pattern, partners] of Object.entries(settings.siblingSheets)) {
    for (const owner of sheets.filter((sheet) => matchesAnyGlob(sheet, [pattern]))) {
      const set = siblings.get(owner) ?? new Set<string>();
      for (const partner of partners) {
        for (const sheet of /[*?]/.test(partner)
          ? sheets.filter((s) => matchesAnyGlob(s, [partner]))
          : [partner]) {
          if (sheet !== owner) set.add(sheet);
        }
      }
      if (set.size > 0) siblings.set(owner, set);
    }
  }
  return siblings;
}
