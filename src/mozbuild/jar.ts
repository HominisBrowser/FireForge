// SPDX-License-Identifier: EUPL-1.2
/**
 * `jar.mn` and `jar.inc.mn`: parsing, queries and edits.
 *
 * A jar manifest is a list of jar sections (`browser.jar:`, `@AB_CD@.jar:`,
 * `[localization] @AB_CD@.jar:`), each holding `%` chrome-manifest lines and
 * entries of the form `[flags] target (source)`. Preprocessor lines (`#ifdef`,
 * `#include`, ...) are kept as they are and never evaluated; entries between
 * a conditional and its `#endif` are marked `conditional`, and edits never
 * place or anchor an entry inside one.
 */
import { posix } from 'node:path';

import { type ManifestReference, resolveManifestPath } from './paths.js';
import {
  joinSource,
  type ManifestEdit,
  manifestError,
  type Placement,
  sortedInsertIndex,
  type SourceLine,
  spliceLines,
  splitSource,
} from './text.js';

/** What one line of a jar manifest is. */
export type JarLineKind =
  'blank' | 'comment' | 'preprocessor' | 'chrome-manifest' | 'header' | 'entry' | 'unknown';

/** One packaging entry. */
export interface JarEntry {
  /** Zero-based line index. */
  line: number;
  /** The whole line. */
  text: string;
  indent: string;
  /** `*` (preprocess), `+`, or both; empty when the entry has none. */
  flags: string;
  /** The path inside the jar. */
  target: string;
  /** The path inside the parentheses, without a leading `%`; undefined when the entry has no parentheses (the source is then the target's last segment, beside the manifest). */
  source: string | undefined;
  /** The source began with `%`: it lives in the locale's source tree. */
  localized: boolean;
  /** The enclosing jar, such as `browser.jar`. */
  jar: string | undefined;
  /** 0 before the first header, then 1 for each header. */
  section: number;
  /** Inside `#if`/`#ifdef`/`#ifndef`. */
  conditional: boolean;
  /** Column of the opening parenthesis. */
  sourceColumn: number | undefined;
  /** Character ranges within `text`. */
  spans: { target: [number, number]; source?: [number, number] };
}

/** A jar section header. */
export interface JarHeader {
  line: number;
  /** The jar, such as `browser.jar`. */
  jar: string;
  /** The bracketed prefix of `[localization] @AB_CD@.jar:`, without brackets. */
  base: string | undefined;
  section: number;
}

/** A `%` line: `% content browser %content/browser/ contentaccessible=yes`. */
export interface JarChromeManifest {
  line: number;
  /** The words after `%`. */
  args: string[];
  section: number;
}

/** A parsed jar manifest. `lines` and `kinds` cover every line, so the parse is lossless. */
export interface JarManifest {
  lines: SourceLine[];
  kinds: JarLineKind[];
  entries: JarEntry[];
  headers: JarHeader[];
  chromeManifests: JarChromeManifest[];
  /** Every conditional is closed and none is closed twice. */
  balanced: boolean;
}

const PP_OPEN = /^#(?:if|ifdef|ifndef)\b/;
const PP_MIDDLE = /^#(?:else|elif\w*)\b/;
const PP_CLOSE = /^#endif\b/;
const PP_OTHER = /^#(?:define|undef|include|filter|unfilter|expand|literal|error)\b/;
const HEADER = /^(?:\[([^\]]+)\]\s+)?(\S+?)\s*:\s*$/;
const INLINE_JAR = /^(\S+\.jar):\s+(?=\S)/;
const ENTRY = /^(\s*)([*+]*)\s*([^\s(]+)(?:\s*\((%?)(.*?)\))?\s*(?:#.*)?$/d;

interface ParsedEntry {
  indent: string;
  flags: string;
  target: string;
  source: string | undefined;
  localized: boolean;
  column: number | undefined;
  spans: JarEntry['spans'];
}

function parseEntryText(text: string, offset: number): ParsedEntry | undefined {
  const match = ENTRY.exec(text.slice(offset));
  const target = match?.indices?.[3];
  if (match === null || target === undefined) return undefined;
  const source = match.indices?.[5];
  const localized = match[4] === '%';
  return {
    indent: match[1] ?? '',
    flags: match[2] ?? '',
    target: match[3] ?? '',
    source: match[5],
    localized,
    column: source === undefined ? undefined : offset + source[0] - (localized ? 2 : 1),
    spans: {
      target: [offset + target[0], offset + target[1]],
      ...(source === undefined ? {} : { source: [offset + source[0], offset + source[1]] }),
    },
  };
}

/**
 * Parses a jar manifest. Never throws: a line it cannot read is `unknown`,
 * and an unbalanced conditional only clears `balanced`. Fragments (the added
 * lines of a diff) parse as well as whole files.
 *
 * @param text - Manifest text
 */
export function parseJar(text: string): JarManifest {
  const lines = splitSource(text);
  const manifest: JarManifest = {
    lines,
    kinds: [],
    entries: [],
    headers: [],
    chromeManifests: [],
    balanced: true,
  };
  let depth = 0;
  let section = 0;
  let jar: string | undefined;
  for (const [index, { text: line }] of lines.entries()) {
    const trimmed = line.trim();
    let kind: JarLineKind = 'unknown';
    if (trimmed === '') {
      kind = 'blank';
    } else if (trimmed.startsWith('#')) {
      kind = 'comment';
      if (PP_OPEN.test(trimmed)) {
        kind = 'preprocessor';
        depth++;
      } else if (PP_CLOSE.test(trimmed)) {
        kind = 'preprocessor';
        if (depth === 0) manifest.balanced = false;
        else depth--;
      } else if (PP_MIDDLE.test(trimmed)) {
        kind = 'preprocessor';
        if (depth === 0) manifest.balanced = false;
      } else if (PP_OTHER.test(trimmed)) {
        kind = 'preprocessor';
      }
    } else if (trimmed.startsWith('%')) {
      kind = 'chrome-manifest';
      manifest.chromeManifests.push({
        line: index,
        args: trimmed.slice(1).trim().split(/\s+/),
        section,
      });
    } else {
      const header = /^\s/.test(line) ? null : HEADER.exec(line);
      const inline = INLINE_JAR.exec(line);
      if (header !== null) {
        kind = 'header';
        section++;
        jar = header[2];
        manifest.headers.push({ line: index, jar: header[2] ?? '', base: header[1], section });
      } else {
        const offset = inline?.[0].length ?? 0;
        const parsed = parseEntryText(line, offset);
        if (parsed !== undefined) {
          kind = 'entry';
          manifest.entries.push({
            line: index,
            text: line,
            indent: parsed.indent,
            flags: parsed.flags,
            target: parsed.target,
            source: parsed.source,
            localized: parsed.localized,
            jar: inline?.[1] ?? jar,
            section,
            conditional: depth > 0,
            sourceColumn: parsed.column,
            spans: parsed.spans,
          });
        }
      }
    }
    manifest.kinds.push(kind);
  }
  if (depth !== 0) manifest.balanced = false;
  return manifest;
}

/** Fields an entry must have; an omitted field matches anything. */
export interface JarQuery {
  target?: string | readonly string[];
  source?: string;
}

/**
 * The entries whose target and source equal the query's, comments and
 * longer names excluded.
 *
 * @param text - Manifest text
 * @param query - Target (one or any of several) and source to match
 */
export function findJarEntries(text: string, query: JarQuery): JarEntry[] {
  const targets = query.target === undefined ? undefined : [query.target].flat();
  return parseJar(text).entries.filter(
    (entry) =>
      (targets === undefined || targets.includes(entry.target)) &&
      (query.source === undefined || entry.source === query.source)
  );
}

/**
 * The engine paths a jar manifest's sources name. An entry without
 * parentheses packages the file named by its target's last segment, found
 * beside the manifest, as Firefox's jar maker reads it. A source with `%`
 * lives in the locale tree and is not listed. An included manifest
 * (`*.inc.mn`) is read from the directory of the manifest that includes it,
 * which the file does not name, so only its root-relative (`/…`) sources
 * are listed.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param text - Manifest text
 */
export function jarReferences(manifestPath: string, text: string): ManifestReference[] {
  const included = manifestPath.endsWith('.inc.mn');
  const references: ManifestReference[] = [];
  for (const entry of parseJar(text).entries) {
    if (entry.localized) continue;
    const token = entry.source ?? posix.basename(entry.target);
    if (included && !token.startsWith('/')) continue;
    const matcher = resolveManifestPath(manifestPath, token);
    if (matcher !== undefined)
      references.push({
        kind: 'jar-source',
        token,
        line: entry.line,
        text: entry.text.trim(),
        matcher,
      });
  }
  return references;
}

/** An entry to add. */
export interface NewJarEntry {
  target: string;
  /** Written in parentheses; omitted when the source is the target. */
  source?: string;
  /** `*`, `+` or both. */
  flags?: string;
  /** Prefix the source with `%`. */
  localized?: boolean;
}

/** Where and how {@link insertJarEntry} places an entry. */
export interface JarInsertOptions {
  /**
   * The jar section to use, as its header is written without the colon
   * (`browser.jar`, `[localization] @AB_CD@.jar`); required when the entry
   * could belong to several.
   */
  jar?: string;
  /** Place the entry right after the entry whose target or source ends with this name. */
  after?: string;
  /** Maps a target to its sort key; the default is the target itself. */
  sortKey?: (target: string) => string;
  /** Put the entry after its neighbours instead of in sort order. */
  append?: boolean;
  /** Indentation when no neighbour shows one. */
  indent?: string;
  /** Fewest spaces between a target and its `(`. */
  minGap?: number;
}

const DEFAULT_INDENT = '    ';

/** Lines of comment directly above `index`: a comment belongs to the entry below it. */
function blockStart(manifest: JarManifest, index: number): number {
  let start = index;
  while (start > 0 && manifest.kinds[start - 1] === 'comment') start--;
  return start;
}

/** Entries near `target`'s directory: the same directory, else the nearest ancestor with any. */
function neighbourhood(entries: readonly JarEntry[], target: string): JarEntry[] {
  let dir = posix.dirname(target);
  const same = entries.filter((entry) => posix.dirname(entry.target) === dir);
  if (same.length > 0) return same;
  while (dir !== '.' && dir !== '/') {
    const below = entries.filter((entry) => entry.target.startsWith(`${dir}/`));
    if (below.length > 0) return below;
    dir = posix.dirname(dir);
  }
  return [];
}

/** A section header as written, without the colon: `browser.jar`, `[localization] @AB_CD@.jar`. */
function headerName(header: JarHeader): string {
  return header.base === undefined ? header.jar : `[${header.base}] ${header.jar}`;
}

function chooseSection(manifest: JarManifest, near: readonly JarEntry[], jar?: string): number {
  const sections = new Set(near.map((entry) => entry.section));
  if (sections.size === 0) {
    for (const header of manifest.headers)
      if (jar === undefined || headerName(header) === jar) sections.add(header.section);
    if (manifest.headers.length === 0) sections.add(0);
  }
  if (sections.size === 0)
    throw manifestError(`The manifest has no jar section named ${jar ?? ''}.`);
  if (sections.size > 1) {
    throw jar === undefined
      ? manifestError(
          'The entry could belong to several jar sections.',
          'Name the section with the jar option, as its header is written.'
        )
      : manifestError(
          `The manifest has several ${jar} sections that could hold the entry.`,
          'Add the entry by hand in the section it belongs to.'
        );
  }
  return [...sections][0] ?? 0;
}

function formatEntry(
  entry: NewJarEntry,
  indent: string,
  column: number | undefined,
  minGap: number
): string {
  const flags = entry.flags ?? '';
  const lead =
    flags === '' ? indent : flags + ' '.repeat(Math.max(1, indent.length - flags.length));
  const head = lead + entry.target;
  if (entry.source === undefined) return head;
  const width = Math.max(column ?? 0, head.length + minGap);
  return `${head}${' '.repeat(width - head.length)}(${entry.localized === true ? '%' : ''}${entry.source})`;
}

/**
 * Adds an entry to a jar manifest. The entry joins the entries of its own
 * directory (or the nearest directory that has any) in one jar section, in
 * sort order when those are sorted and after them when they are not, never
 * inside a preprocessor conditional. It copies the neighbour's indentation
 * and source column. A leading comment stays attached to its entry.
 *
 * An entry already present (same target, same source) changes nothing. The
 * same target with another source, an unbalanced conditional, an anchor
 * inside a conditional, or several candidate jar sections is refused.
 *
 * @param text - Manifest text
 * @param entry - The entry to add
 * @param options - Section, anchor, ordering and layout
 */
export function insertJarEntry(
  text: string,
  entry: NewJarEntry,
  options: JarInsertOptions = {}
): Placement {
  const manifest = parseJar(text);
  if (!manifest.balanced)
    throw manifestError('The manifest has an unbalanced preprocessor conditional.');
  const present = manifest.entries.find((existing) => existing.target === entry.target);
  if (present !== undefined) {
    if (present.source === entry.source && present.localized === (entry.localized === true)) {
      return { text, changed: false, line: present.line };
    }
    throw manifestError(`${entry.target} is already registered with a different source.`);
  }

  const named = new Set(
    manifest.headers
      .filter((header) => headerName(header) === options.jar)
      .map((header) => header.section)
  );
  const pool = manifest.entries.filter(
    (existing) =>
      options.jar === undefined ||
      named.has(existing.section) ||
      (named.size === 0 && existing.jar === options.jar)
  );
  const section = chooseSection(manifest, neighbourhood(pool, entry.target), options.jar);
  const sectionEntries = pool.filter((existing) => existing.section === section);
  const open = sectionEntries.filter((existing) => !existing.conditional);
  const slots = neighbourhood(open, entry.target);

  let at: number | undefined;
  let previous: JarEntry | undefined;
  let afterFallback = false;
  if (options.after !== undefined) {
    const name = options.after;
    const named = (candidate: JarEntry): boolean =>
      [candidate.target, candidate.source ?? ''].some(
        (path) => path === name || path.endsWith(`/${name}`)
      );
    const anchor = open.find(named);
    if (anchor !== undefined) {
      at = anchor.line + 1;
      previous = anchor;
    } else if (sectionEntries.some(named)) {
      throw manifestError(
        'The requested anchor is inside a preprocessor conditional.',
        'Choose an unconditional anchor.'
      );
    } else {
      afterFallback = true;
    }
  }
  if (at === undefined) {
    const key = options.sortKey ?? ((target: string) => target);
    const index =
      slots.length === 0 || options.append === true
        ? slots.length
        : sortedInsertIndex(
            slots.map((slot) => key(slot.target)),
            key(entry.target)
          );
    const next = slots[index];
    previous = slots[index - 1];
    if (next !== undefined) at = blockStart(manifest, next.line);
    else if (previous !== undefined) at = previous.line + 1;
    else at = headOfSection(manifest, section);
  }

  const around = previous ?? slots[0];
  const withSource = [previous, ...slots].find((slot) => slot?.sourceColumn !== undefined);
  const line = formatEntry(
    entry,
    around === undefined
      ? (options.indent ?? DEFAULT_INDENT)
      : around.text.slice(0, around.spans.target[0]).replace(/[*+]/g, ' '),
    withSource?.sourceColumn,
    options.minGap ?? 2
  );
  const result: Placement = {
    text: joinSource(spliceLines(manifest.lines, at, 0, [line])),
    changed: true,
    line: at,
  };
  if (previous !== undefined) result.previous = previous.text.trim();
  if (afterFallback) result.afterFallback = true;
  return result;
}

/** The line after a section's header and the `%` lines that follow it. */
function headOfSection(manifest: JarManifest, section: number): number {
  const header = manifest.headers.find((candidate) => candidate.section === section);
  let at = header === undefined ? 0 : header.line + 1;
  while (manifest.kinds[at] === 'chrome-manifest') at++;
  return at;
}

/** What to do with one entry: leave it (undefined), drop it (null), or change its target or source. */
export type JarUpdate = { target?: string; source?: string } | null | undefined;

/** The result of {@link updateJarEntries}. */
export interface JarUpdateResult extends ManifestEdit {
  removed: JarEntry[];
  updated: JarEntry[];
}

/**
 * Removes or retargets entries in place. A changed entry keeps its position,
 * indentation, column spacing and trailing comment; everything else in the
 * file is left as it is.
 *
 * @param text - Manifest text
 * @param decide - Called for each entry in file order
 */
export function updateJarEntries(
  text: string,
  decide: (entry: JarEntry) => JarUpdate
): JarUpdateResult {
  const manifest = parseJar(text);
  const removed: JarEntry[] = [];
  const updated: JarEntry[] = [];
  let lines = manifest.lines.map((line) => ({ ...line }));
  for (const entry of manifest.entries) {
    const change = decide(entry);
    if (change === undefined) continue;
    if (change === null) {
      removed.push(entry);
      continue;
    }
    const edits: [[number, number], string][] = [];
    if (change.target !== undefined) edits.push([entry.spans.target, change.target]);
    if (change.source !== undefined && entry.spans.source !== undefined) {
      edits.push([entry.spans.source, change.source]);
    }
    let edited = entry.text;
    for (const [[start, end], value] of edits.sort((a, b) => b[0][0] - a[0][0])) {
      edited = edited.slice(0, start) + value + edited.slice(end);
    }
    const target = lines[entry.line];
    if (target !== undefined && edited !== entry.text) {
      target.text = edited;
      updated.push(entry);
    }
  }
  for (const entry of [...removed].reverse()) lines = spliceLines(lines, entry.line, 1, []);
  const changed = removed.length > 0 || updated.length > 0;
  return { text: changed ? joinSource(lines) : text, changed, removed, updated };
}
