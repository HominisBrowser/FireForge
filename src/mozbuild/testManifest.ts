// SPDX-License-Identifier: EUPL-1.2
/**
 * Test manifests (`browser.toml`, `xpcshell.toml`, `mochitest.toml`,
 * `chrome.toml`, `a11y.toml` and their `.ini` forms): sections, keys, the
 * tests a manifest lists and the files its tests read.
 *
 * Only what the tools need is read: `[DEFAULT]` and per-test sections, and
 * each key's string items. A value this does not understand yields no items
 * instead of a guess, so a file it misses is reported as unlisted rather than
 * attributed to the wrong test.
 */
import { posix } from 'node:path';

import { type ManifestReference, resolveManifestPath } from './paths.js';
import {
  joinSource,
  type ManifestEdit,
  type Placement,
  scanStringList,
  sortedInsertIndex,
  type SourceLine,
  spliceLines,
  splitSource,
} from './text.js';

/** One key of a section. */
export interface ManifestKey {
  name: string;
  /** First and last line of the assignment (an array or `.ini` value may span several). */
  line: number;
  endLine: number;
  /** The value text, comments removed, lines joined by a space. */
  raw: string;
  /** The strings of a TOML value, or the whitespace-separated words of an `.ini` value, with their lines. */
  items: { value: string; line: number }[];
}

/** One section, or the keys before the first header. */
export interface ManifestSection {
  /** The header text without brackets and quotes; undefined before the first header. */
  name: string | undefined;
  /** `include` is an `include:<manifest>` header; `preamble` is the part before the first header. */
  kind: 'preamble' | 'default' | 'test' | 'include';
  /** Header line, or -1 for the preamble. */
  line: number;
  /** First line of the section's block: its header and the comments directly above it. */
  start: number;
  /** One past the last line of the block, which is where the next block starts. */
  end: number;
  keys: ManifestKey[];
}

/** A parsed test manifest. `lines` covers the whole file, so the parse is lossless. */
export interface TestManifest {
  format: 'toml' | 'ini';
  lines: SourceLine[];
  sections: ManifestSection[];
}

const HEADER = /^\s*\[\s*(.+?)\s*\]\s*(?:[#;].*)?$/;
const KEY = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/;
const unquote = (text: string): string => text.replace(/^(["'])(.*)\1$/, '$2');

function sectionKind(name: string): ManifestSection['kind'] {
  if (name.toUpperCase() === 'DEFAULT') return 'default';
  return name.startsWith('include:') ? 'include' : 'test';
}

function words(text: string, line: number): { value: string; line: number }[] {
  return text
    .replace(/\s[#;].*$/, '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((value) => ({ value, line }));
}

function parseKey(
  lines: readonly SourceLine[],
  index: number,
  format: 'toml' | 'ini'
): ManifestKey | undefined {
  const text = lines[index]?.text ?? '';
  const match = KEY.exec(text);
  if (match === null) return undefined;
  const name = unquote(match[1] ?? '');
  const value = match[2] ?? '';
  if (format === 'toml' && value.startsWith('[')) {
    const scan = scanStringList(lines, index, text.length - value.length + 1);
    if (scan === undefined) return { name, line: index, endLine: index, raw: value, items: [] };
    const raw = lines
      .slice(index, scan.endLine + 1)
      .map((line) => line.text.trim())
      .join(' ');
    return {
      name,
      line: index,
      endLine: scan.endLine,
      raw: raw.slice(raw.indexOf('[')),
      items: scan.items.map((item) => ({ value: item.value, line: item.line })),
    };
  }
  if (format === 'toml') {
    const quoted = /^(["'])(.*?)\1/.exec(value);
    const bare = value.replace(/\s*[#;].*$/, '').trim();
    return {
      name,
      line: index,
      endLine: index,
      raw: bare,
      items: quoted === null ? words(bare, index) : [{ value: quoted[2] ?? '', line: index }],
    };
  }
  let end = index;
  const parts = [value];
  while (
    /^\s+\S/.test(lines[end + 1]?.text ?? '') &&
    !(lines[end + 1]?.text ?? '').trimStart().startsWith('#')
  ) {
    end++;
    parts.push((lines[end]?.text ?? '').trim());
  }
  return {
    name,
    line: index,
    endLine: end,
    raw: parts.join(' ').replace(/\s[#;].*$/, ''),
    items: parts.flatMap((part, offset) => words(part, index + offset)),
  };
}

/**
 * Parses a test manifest. Never throws, and accepts fragments.
 *
 * @param path - The manifest's path; `.ini` selects the INI reading, anything else TOML
 * @param text - Manifest text
 */
export function parseTestManifest(path: string, text: string): TestManifest {
  const format = path.endsWith('.ini') ? 'ini' : 'toml';
  const lines = splitSource(text);
  const sections: ManifestSection[] = [
    { name: undefined, kind: 'preamble', line: -1, start: 0, end: lines.length, keys: [] },
  ];
  for (let index = 0; index < lines.length; index++) {
    const header = HEADER.exec(lines[index]?.text ?? '');
    const current = sections.at(-1);
    if (header !== null) {
      const name = unquote(header[1] ?? '');
      let start = index;
      while (start > 0 && (lines[start - 1]?.text ?? '').trimStart().startsWith('#')) start--;
      if (current !== undefined) current.end = Math.max(start, current.start);
      sections.push({
        name,
        kind: sectionKind(name),
        line: index,
        start,
        end: lines.length,
        keys: [],
      });
      continue;
    }
    const key = parseKey(lines, index, format);
    if (key !== undefined && current !== undefined) {
      current.keys.push(key);
      index = key.endLine;
    }
  }
  return { format, lines, sections };
}

/**
 * The tests a manifest lists, as engine-relative paths.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param text - Manifest text
 */
export function listTests(manifestPath: string, text: string): string[] {
  const dir = posix.dirname(manifestPath);
  return parseTestManifest(manifestPath, text)
    .sections.filter((section) => section.kind === 'test')
    .map((section) => posix.normalize(posix.join(dir, section.name ?? '')));
}

/** The keys whose items are files a test reads. */
export const FILE_KEYS = ['support-files', 'head', 'tail'] as const;

/** One file a manifest says its tests read. */
export interface SupportEntry {
  key: (typeof FILE_KEYS)[number];
  /** The path as written. */
  entry: string;
  line: number;
  /** The trimmed text of that line. */
  text: string;
  /** The test it serves; undefined when it serves every test (`[DEFAULT]` or before any section). */
  test: string | undefined;
}

/**
 * The `support-files`, `head` and `tail` entries of a manifest, in file order.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param text - Manifest text
 * @param keys - Which keys to read
 */
export function supportEntries(
  manifestPath: string,
  text: string,
  keys: readonly (typeof FILE_KEYS)[number][] = FILE_KEYS
): SupportEntry[] {
  const dir = posix.dirname(manifestPath);
  const manifest = parseTestManifest(manifestPath, text);
  return manifest.sections.flatMap((section) => {
    const test =
      section.kind === 'test' ? posix.normalize(posix.join(dir, section.name ?? '')) : undefined;
    return section.kind === 'include'
      ? []
      : section.keys.flatMap((key) =>
          keys.some((wanted) => wanted === key.name)
            ? key.items.map(({ value, line }) => ({
                key: key.name as SupportEntry['key'],
                entry: value,
                line,
                text: (manifest.lines[line]?.text ?? '').trim(),
                test,
              }))
            : []
        );
  });
}

/**
 * The tests whose manifests list `path` as a file they read, sorted. A
 * manifest's own tests are never counted as their own support.
 *
 * @param path - Engine-relative path of the file
 * @param manifests - The manifests to read
 */
export function supportUsers(
  path: string,
  manifests: readonly { path: string; text: string }[]
): string[] {
  const users = new Set<string>();
  for (const manifest of manifests) {
    const tests = listTests(manifest.path, manifest.text);
    if (tests.includes(path)) continue;
    for (const { entry, test } of supportEntries(manifest.path, manifest.text)) {
      if (resolveManifestPath(manifest.path, entry, { directories: true })?.matches(path) !== true)
        continue;
      for (const user of test === undefined ? tests : [test]) users.add(user);
    }
  }
  return [...users].sort();
}

/**
 * Every path a test manifest names: its tests and its support entries.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param text - Manifest text
 */
export function testManifestReferences(manifestPath: string, text: string): ManifestReference[] {
  const manifest = parseTestManifest(manifestPath, text);
  const references: ManifestReference[] = [];
  const add = (kind: string, token: string, line: number, directories: boolean): void => {
    const matcher = resolveManifestPath(manifestPath, token, { directories });
    if (matcher === undefined) return;
    references.push({
      kind,
      token,
      line,
      text: (manifest.lines[line]?.text ?? '').trim(),
      matcher,
    });
  };
  for (const section of manifest.sections) {
    if (section.kind === 'test') add('test', section.name ?? '', section.line, false);
  }
  for (const entry of supportEntries(manifestPath, text))
    add(entry.key, entry.entry, entry.line, true);
  return references;
}

/**
 * The value of a scalar key in `[DEFAULT]` (or before the first section,
 * which the harness reads as defaults).
 *
 * @param manifestPath - Path of the manifest
 * @param text - Manifest text
 * @param key - The key, such as `firefox-appdir`
 */
export function defaultValue(
  manifestPath: string,
  text: string,
  key: string
): { value: string; line: number } | undefined {
  for (const section of parseTestManifest(manifestPath, text).sections) {
    if (section.kind !== 'preamble' && section.kind !== 'default') continue;
    const found = section.keys.find((candidate) => candidate.name === key);
    const value = found?.items[0]?.value;
    if (found !== undefined && value !== undefined && value !== '')
      return { value, line: found.line };
  }
  return undefined;
}

/** Keys of a new test section. */
export interface NewTest {
  /** `key = value` lines; a list is written `["a", "b"]` in TOML and space-separated in `.ini`. */
  keys?: Readonly<Record<string, string | readonly string[]>>;
  /** Put the section after the one with this name (or whose header contains this text) instead of in sort order. */
  after?: string;
}

function sectionLines(format: 'toml' | 'ini', name: string, keys: NewTest['keys']): string[] {
  const rows = Object.entries(keys ?? {}).map(([key, value]) => {
    if (typeof value === 'string')
      return format === 'toml' ? `${key} = "${value}"` : `${key} = ${value}`;
    return format === 'toml'
      ? `${key} = [${value.map((item) => `"${item}"`).join(', ')}]`
      : `${key} = ${value.join(' ')}`;
  });
  return [format === 'toml' ? `["${name}"]` : `[${name}]`, ...rows];
}

/** What a new test manifest starts with. */
export interface NewTestManifest {
  /** Comment lines above everything else, such as a license header. */
  header?: string;
  /** Keys of the `[DEFAULT]` section. */
  defaults?: NewTest['keys'];
}

/**
 * A new test manifest listing one test: the `[DEFAULT]` section and the
 * test's section.
 *
 * @param manifestPath - Path of the manifest; `.ini` picks that format, anything else TOML
 * @param name - The test, as written in the header (relative to the manifest)
 * @param options - Header and defaults
 */
export function newTestManifest(
  manifestPath: string,
  name: string,
  options: NewTestManifest = {}
): string {
  const format = manifestPath.endsWith('.ini') ? 'ini' : 'toml';
  const [, ...defaults] = sectionLines(format, 'DEFAULT', options.defaults);
  return [
    ...(options.header === undefined ? [] : [options.header, '']),
    '[DEFAULT]',
    ...defaults,
    '',
    ...sectionLines(format, name, undefined),
    '',
  ].join('\n');
}

/**
 * Adds a test section. In sort order (byte order, or case-insensitive when
 * that is how the existing sections are sorted) when the existing tests are
 * sorted, otherwise last. It goes ahead of the comments that introduce the
 * next section, with one blank line between sections. A test already listed
 * changes nothing.
 *
 * @param manifestPath - Path of the manifest
 * @param text - Manifest text
 * @param name - The test, as written in the header (relative to the manifest)
 * @param options - Keys for the section and an anchor
 */
export function addTest(
  manifestPath: string,
  text: string,
  name: string,
  options: NewTest = {}
): Placement {
  const manifest = parseTestManifest(manifestPath, text);
  const tests = manifest.sections.filter((section) => section.kind === 'test');
  const present = tests.find((section) => section.name === name);
  if (present !== undefined) return { text, changed: false, line: present.line };

  const block = sectionLines(manifest.format, name, options.keys);
  let previous: ManifestSection | undefined;
  let next: ManifestSection | undefined;
  let afterFallback = false;
  const anchor = options.after;
  if (anchor !== undefined) {
    const found =
      manifest.sections.find((section) => section.line >= 0 && section.name === anchor) ??
      manifest.sections.find(
        (section) =>
          section.line >= 0 && (manifest.lines[section.line]?.text ?? '').includes(anchor)
      );
    if (found === undefined) afterFallback = true;
    else previous = found;
  }
  if (previous === undefined) {
    const index = sortedInsertIndex(
      tests.map((section) => section.name ?? ''),
      name,
      'bytes'
    );
    next = tests[index];
    previous = tests[index - 1];
  } else {
    next = manifest.sections[manifest.sections.indexOf(previous) + 1];
  }

  let lines: SourceLine[];
  let at: number;
  if (next !== undefined) {
    at = next.start;
    lines = spliceLines(manifest.lines, at, 0, [...block, '']);
  } else {
    let last = manifest.lines.length;
    while (last > 0 && (manifest.lines[last - 1]?.text ?? '').trim() === '') last--;
    at = last + (last > 0 ? 1 : 0);
    lines = spliceLines(manifest.lines, last, manifest.lines.length - last, [
      ...(last > 0 ? [''] : []),
      ...block,
    ]);
  }
  const result: Placement = { text: joinSource(lines), changed: true, line: at };
  if (previous !== undefined && previous.line >= 0)
    result.previous = (manifest.lines[previous.line]?.text ?? '').trim();
  if (afterFallback) result.afterFallback = true;
  return result;
}

/**
 * Removes a test's section: its header, its keys, the comments directly
 * above it and the blank lines that separated it from the next section.
 *
 * @param manifestPath - Path of the manifest
 * @param text - Manifest text
 * @param name - The test, as written in the header
 */
export function removeTest(manifestPath: string, text: string, name: string): ManifestEdit {
  const manifest = parseTestManifest(manifestPath, text);
  const index = manifest.sections.findIndex(
    (section) => section.kind === 'test' && section.name === name
  );
  const section = manifest.sections[index];
  if (section === undefined) return { text, changed: false };
  let start = section.start;
  if (index === manifest.sections.length - 1) {
    while (start > 0 && (manifest.lines[start - 1]?.text ?? '').trim() === '') start--;
  }
  return {
    text: joinSource(spliceLines(manifest.lines, start, section.end - start, [])),
    changed: true,
  };
}
