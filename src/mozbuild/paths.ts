// SPDX-License-Identifier: EUPL-1.2
/**
 * What a file name says about a manifest, and how a path written inside a
 * manifest resolves to engine paths.
 */
import { posix } from 'node:path';

import { globToRegExp } from '../kernel/glob.js';

/** The manifest formats this module reads and edits. */
export type ManifestKind = 'jar' | 'moz-build' | 'test-manifest';

/** The harness flavour of a test manifest, as the moz.build variable that lists it names it. */
export type TestFlavor = 'browser-chrome' | 'xpcshell' | 'mochitest' | 'chrome' | 'a11y';

/** The moz.build variables that list test manifests, and the flavour each one declares. */
export const TEST_MANIFEST_VARIABLES: Readonly<Record<string, TestFlavor>> = {
  BROWSER_CHROME_MANIFESTS: 'browser-chrome',
  XPCSHELL_TESTS_MANIFESTS: 'xpcshell',
  MOCHITEST_MANIFESTS: 'mochitest',
  MOCHITEST_CHROME_MANIFESTS: 'chrome',
  A11Y_MANIFESTS: 'a11y',
};

/**
 * Test manifest names: a flavour word, optionally followed by a suffix
 * (`browser-srd.toml`, `browserNova.toml`, `xpcshell_snap.toml`). The
 * moz.build that lists a manifest is the authority; this covers the names
 * Firefox uses for nearly all of them. A pattern such as "any `.toml`"
 * would sweep in Cargo and taskcluster files whose keys mean something else.
 */
const TEST_MANIFEST_NAME =
  /^(browser|xpcshell|mochitest|chrome|a11y)(?:[-_.][\w.-]*|[A-Z][\w-]*)?\.(?:toml|ini)$/;
const NAME_FLAVOR: Readonly<Record<string, TestFlavor>> = {
  browser: 'browser-chrome',
  xpcshell: 'xpcshell',
  mochitest: 'mochitest',
  chrome: 'chrome',
  a11y: 'a11y',
};
/** `jar.mn`, `addon-jar.mn`, `desktop-jar.inc.mn`, `minimal-toolkit.jar.inc.mn`, and included `*.inc.mn`. */
const JAR_NAME = /^(?:(?:[\w-]+[.-])?jar(?:\.[\w-]+)*|[\w.-]+\.inc)\.mn$/;

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/**
 * The manifest format a path names, or undefined when it is none of them.
 *
 * @param path - A path with either separator
 */
export function manifestKind(path: string): ManifestKind | undefined {
  const name = fileName(path);
  if (JAR_NAME.test(name)) return 'jar';
  if (name === 'moz.build') return 'moz-build';
  if (TEST_MANIFEST_NAME.test(name)) return 'test-manifest';
  return undefined;
}

/**
 * The flavour a test manifest's name declares, or undefined when the name
 * is not a test manifest's.
 *
 * @param path - A path with either separator
 */
export function testManifestFlavor(path: string): TestFlavor | undefined {
  const word = TEST_MANIFEST_NAME.exec(fileName(path))?.[1];
  return word === undefined ? undefined : NAME_FLAVOR[word];
}

/** A path written in a manifest, resolved to the engine paths it names. */
export interface PathMatcher {
  /** Whether an engine-relative path is one the written path names. */
  matches: (path: string) => boolean;
  /** The one path named, when the written path has no wildcard. */
  exact?: string;
}

/** How the file that carries a path reads it. */
export interface ResolveOptions {
  /** A path without wildcards also names everything beneath it (test-manifest `support-files`). */
  directories?: boolean;
}

/**
 * Resolves a path written in a manifest to a matcher over engine-relative
 * paths. The path is relative to the manifest's directory (`../` allowed);
 * `/` and `!/` start at the engine root. `*` and `?` stay inside a segment
 * and `**` crosses segments. Anything that names no engine path returns
 * undefined: an objdir path (`!foo`), a build-time substitution
 * (`@AB_CD@`), a path with whitespace, or one that climbs out of the tree.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param written - The path as written, without quotes
 * @param options - How the carrying file reads paths
 */
export function resolveManifestPath(
  manifestPath: string,
  written: string,
  options: ResolveOptions = {}
): PathMatcher | undefined {
  if (written === '' || /\s/.test(written) || /@[A-Za-z_]+@/.test(written)) return undefined;
  const rooted = /^!?\//.test(written);
  if (!rooted && written.startsWith('!')) return undefined;
  const base = posix.dirname(manifestPath.replaceAll('\\', '/'));
  const joined = rooted ? written.replace(/^!?\/+/, '') : posix.join(base, written);
  const resolved = posix.normalize(joined).replace(/\/+$/, '');
  if (resolved === '' || resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
    return undefined;
  }
  if (/[*?]/.test(resolved)) {
    const pattern = globToRegExp(resolved);
    return { matches: (path) => pattern.test(path) };
  }
  if (options.directories === true) {
    return {
      matches: (path) => path === resolved || path.startsWith(`${resolved}/`),
      exact: resolved,
    };
  }
  return { matches: (path) => path === resolved, exact: resolved };
}

/** A path as written in a manifest that names engine paths, and where it was written. */
export interface ManifestReference {
  /** What carries it: `jar-source`, `list-item`, `test`, `support-files`, `head` or `tail`. */
  kind: string;
  /** The path as written. */
  token: string;
  /** Zero-based line it is written on. */
  line: number;
  /** The trimmed text of that line. */
  text: string;
  /** What it names. */
  matcher: PathMatcher;
}
