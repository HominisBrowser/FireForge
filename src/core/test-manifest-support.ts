// SPDX-License-Identifier: EUPL-1.2
/**
 * Which tests a test manifest says a file serves.
 *
 * A manifest (`xpcshell.toml`, `browser.toml`, `mochitest.toml`,
 * `chrome.toml`, `a11y.toml` and their `.ini` forms) lists its tests as
 * sections and the files they read under `support-files`, `head` and
 * `tail`. A key under `[DEFAULT]` (or before the first section) serves
 * every test of the manifest; one under a test's own section serves that
 * test. An entry resolves against the manifest's directory, `../` included;
 * `!/` and `/` make it engine-root relative. `*`, `?` and `**` glob as in
 * {@link globToRegExp}, and an entry naming a directory serves everything
 * beneath it.
 *
 * Without a TOML dependency, as the other manifest readers here: an entry
 * this cannot read serves nothing, so a file it misses is refused as
 * unclassified, never run as a test it is not.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { globToRegExp } from '../utils/path-glob.js';
import {
  extractSupportFileEntries,
  isTestManifestPath,
} from './patch-lint-forward-registration.js';

export { isTestManifestPath };

/** A manifest's engine-relative path and text. */
export interface ManifestFile {
  path: string;
  content: string;
}

/** The keys whose entries are files a test reads. */
const FILE_KEYS = ['support-files', 'head', 'tail'] as const;

/** A section header: `[DEFAULT]`, `[test_a.js]`, `["test_a.js"]`. */
const SECTION = /^\s*\[\s*(.+?)\s*\]\s*(?:[#;].*)?$/;

/** A reftest or crashtest manifest, which `mach test` runs by path. */
const REFTEST_LIST = /(?:^|\/)[\w.-]+\.list$/;

/** Named as a test: a harness can be asked to run it. Mirrors the planner's own rule. */
const TEST_NAME = /(?:^|\/)(?:browser_|test_)[^/]+\.[A-Za-z0-9]+$/;

interface Section {
  /** The test's engine-relative path; undefined for the defaults. */
  test: string | undefined;
  lines: string[];
}

const unquote = (value: string): string => value.replace(/^["']|["']$/g, '');

function sections(manifest: ManifestFile): Section[] {
  const dir = posix.dirname(manifest.path);
  const result: Section[] = [{ test: undefined, lines: [] }];
  for (const line of manifest.content.split(/\r?\n/)) {
    const header = SECTION.exec(line);
    if (header?.[1] === undefined) {
      result.at(-1)?.lines.push(line);
      continue;
    }
    const name = unquote(header[1]);
    result.push({
      test: name.toUpperCase() === 'DEFAULT' ? undefined : posix.normalize(posix.join(dir, name)),
      lines: [],
    });
  }
  return result;
}

/** One entry as a matcher over engine-relative paths, or undefined when it names nothing here. */
function entryMatcher(dir: string, raw: string): ((path: string) => boolean) | undefined {
  const entry = unquote(raw.trim()).replace(/,$/, '');
  if (entry === '') return undefined;
  const rooted = /^!?\//.test(entry);
  if (!rooted && entry.startsWith('!')) return undefined;
  const resolved = posix.normalize(rooted ? entry.replace(/^!?\/+/, '') : posix.join(dir, entry));
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) return undefined;
  const bare = resolved.replace(/\/+$/, '');
  if (/[*?]/.test(bare)) {
    const pattern = globToRegExp(bare);
    return (path) => pattern.test(path);
  }
  return (path) => path === bare || path.startsWith(`${bare}/`);
}

/** The entries of every file key in one section's text, a `.ini` line split on whitespace. */
function fileEntries(text: string): string[] {
  return FILE_KEYS.flatMap((key) =>
    extractSupportFileEntries(text, key).flatMap(({ entry }) =>
      entry.split(/\s+/).filter((token) => token.length > 0)
    )
  );
}

/** The tests a manifest lists, engine-relative. */
function manifestTests(manifest: ManifestFile): string[] {
  return sections(manifest).flatMap(({ test }) => (test === undefined ? [] : [test]));
}

/**
 * The tests whose manifests list `path` as a file they read, sorted. A
 * manifest's own tests are never their own support.
 *
 * @param path - Engine-relative path of the file
 * @param manifests - The manifests to read
 */
export function supportUsers(path: string, manifests: readonly ManifestFile[]): string[] {
  const users = new Set<string>();
  for (const manifest of manifests) {
    if (!isTestManifestPath(manifest.path)) continue;
    const dir = posix.dirname(manifest.path);
    const all = sections(manifest);
    const tests = all.flatMap(({ test }) => (test === undefined ? [] : [test]));
    if (tests.includes(path)) continue;
    for (const section of all) {
      const listed = fileEntries(section.lines.join('\n')).some(
        (entry) => entryMatcher(dir, entry)?.(path) === true
      );
      if (!listed) continue;
      if (section.test === undefined) tests.forEach((test) => users.add(test));
      else users.add(section.test);
    }
  }
  return [...users].sort();
}

/** How many directories above a file its manifest may sit, as `fixtures/` sits below one. */
const MANIFEST_DEPTH = 4;

/**
 * The manifests in a file's directory and the few above it, read from disk.
 *
 * @param engineDir - Absolute engine directory
 * @param path - Engine-relative path of the file
 */
export async function nearbyManifests(engineDir: string, path: string): Promise<ManifestFile[]> {
  const manifests: ManifestFile[] = [];
  let dir = posix.dirname(path);
  for (let depth = 0; depth < MANIFEST_DEPTH && dir !== '.' && dir !== ''; depth += 1) {
    const names = await readdir(join(engineDir, dir)).catch(() => [] as string[]);
    for (const name of names.filter((entry) => isTestManifestPath(entry)).sort()) {
      const manifest = `${dir}/${name}`;
      const content = await readFile(join(engineDir, manifest), 'utf8').catch(() => undefined);
      if (content !== undefined) manifests.push({ path: manifest, content });
    }
    dir = posix.dirname(dir);
  }
  return manifests;
}

/** What a named path is, for a step that may only run tests. */
export type NamedPathKind =
  | { kind: 'test' }
  | { kind: 'manifest' }
  | { kind: 'support'; users: string[] }
  | { kind: 'other' };

/**
 * Whether a named file can be a test step's input: a file named as a test,
 * a test a manifest lists, or a manifest. Anything else is a support file,
 * with the tests that read it, or not a test input at all.
 *
 * @param path - Engine-relative path of a file (not a directory)
 * @param manifests - The manifests that could list it
 */
export function classifyNamedPath(path: string, manifests: readonly ManifestFile[]): NamedPathKind {
  if (isTestManifestPath(path) || REFTEST_LIST.test(path)) return { kind: 'manifest' };
  if (TEST_NAME.test(path)) return { kind: 'test' };
  if (manifests.some((manifest) => manifestTests(manifest).includes(path))) return { kind: 'test' };
  const users = supportUsers(path, manifests);
  return users.length > 0 ? { kind: 'support', users } : { kind: 'other' };
}

/**
 * The refusal for a named path that is not a test, naming what it is.
 *
 * @param path - The path as named
 * @param kind - From {@link classifyNamedPath}
 */
export function notATestMessage(path: string, kind: NamedPathKind): string {
  if (kind.kind === 'support') {
    const shown = kind.users.slice(0, 5).join(', ');
    const more = kind.users.length > 5 ? ` and ${String(kind.users.length - 5)} more` : '';
    return `${path} is a support file, not a test: its manifest lists it for ${shown}${more}. Name those tests instead.`;
  }
  return `${path} is not a test: name a test file (browser_*/test_*), a test directory or a test manifest.`;
}
