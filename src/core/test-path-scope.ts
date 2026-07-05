// SPDX-License-Identifier: EUPL-1.2
/**
 * Directory-argument scope analysis for `fireforge test`.
 *
 * mozbuild's test resolver matches command-line paths by STRING PREFIX,
 * so `fireforge test browser/base/content/test/hominis` silently also
 * ran the sibling directory `browser/base/content/test/hominis-tiles`
 * (152.0b7 → 153.0b8 source-refresh drill: 1224 tests instead of ~200,
 * with no indication the scope widened). A trailing separator makes the
 * prefix match exact — `hominis/` cannot prefix `hominis-tiles/…`.
 *
 * FireForge therefore treats a directory argument as meaning EXACTLY
 * that directory: {@link analyzeTestPathScopes} returns a trailing-`/`
 * dispatch form for every existing directory, plus the sibling
 * directories the raw prefix would have swept in so the command layer
 * can tell the operator what was excluded. Note FireForge already
 * rejects non-existent paths up front, so raw prefix-widening was never
 * something an operator could invoke deliberately — it only ever
 * happened by accident.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** A sibling directory the raw mach prefix match would have included. */
export interface SiblingPrefixMatch {
  /** Engine-relative path of the sibling directory. */
  path: string;
  /** Recursive count of `browser_*` / `test_*` JS files under it. */
  testFileCount: number;
}

/** Scope analysis for one `fireforge test` path argument. */
export interface TestPathScope {
  /** The path as the operator passed it (engine-relative, normalized). */
  requestedPath: string;
  /**
   * The form to hand to mach: directories gain a trailing `/` so
   * mozbuild's prefix match is exact; files pass through unchanged.
   */
  dispatchPath: string;
  /** True when the path resolved to a directory under engine/. */
  isDirectory: boolean;
  /** Recursive test-file count inside the requested directory (0 for files). */
  testFileCount: number;
  /** Sibling directories a raw prefix match would also have selected. */
  siblingPrefixMatches: SiblingPrefixMatch[];
}

/** Test implementation files as mozbuild manifests name them. */
const TEST_FILE_PATTERN = /^(?:browser|test)_.*\.m?js$/;

/**
 * Recursively counts test-implementation files under a directory.
 * Returns 0 when the directory cannot be read — the count feeds an
 * informational notice, never a decision.
 */
async function countTestFiles(dir: string): Promise<number> {
  let count = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countTestFiles(join(dir, entry.name));
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      count += 1;
    }
  }
  return count;
}

/** Probes whether `path` is a directory, without throwing. */
async function isDirectorySafe(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Analyzes one engine-relative test path argument. See the module doc
 * comment for the semantics.
 */
async function analyzeTestPathScope(
  engineDir: string,
  requestedPath: string
): Promise<TestPathScope> {
  const stripped = requestedPath.replace(/\/+$/, '');
  const absolute = join(engineDir, stripped);

  if (!(await isDirectorySafe(absolute))) {
    return {
      requestedPath,
      dispatchPath: requestedPath,
      isDirectory: false,
      testFileCount: 0,
      siblingPrefixMatches: [],
    };
  }

  const siblingPrefixMatches: SiblingPrefixMatch[] = [];
  const base = basename(stripped);
  const parentRel = dirname(stripped);
  try {
    const siblings = await readdir(dirname(absolute), { withFileTypes: true });
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      if (entry.name === base || !entry.name.startsWith(base)) continue;
      const siblingRel = parentRel === '.' ? entry.name : `${parentRel}/${entry.name}`;
      const testFileCount = await countTestFiles(join(dirname(absolute), entry.name));
      // A prefix-matching sibling with no test files never surfaces in a
      // mach run, so listing it would only add noise.
      if (testFileCount > 0) {
        siblingPrefixMatches.push({ path: siblingRel, testFileCount });
      }
    }
  } catch {
    // Unreadable parent: skip the sibling probe; exactness via the
    // trailing separator is preserved regardless.
  }

  return {
    requestedPath,
    dispatchPath: `${stripped}/`,
    isDirectory: true,
    testFileCount: await countTestFiles(absolute),
    siblingPrefixMatches,
  };
}

/**
 * Analyzes every test path argument of a run.
 *
 * @param engineDir - Path to the engine directory
 * @param requestedPaths - Engine-relative test path arguments
 */
export async function analyzeTestPathScopes(
  engineDir: string,
  requestedPaths: readonly string[]
): Promise<TestPathScope[]> {
  const scopes: TestPathScope[] = [];
  for (const requestedPath of requestedPaths) {
    scopes.push(await analyzeTestPathScope(engineDir, requestedPath));
  }
  return scopes;
}

/**
 * Formats the sibling-exclusion notice for one scope, or undefined when
 * nothing needs saying (file arg, or no prefix-matching siblings).
 */
export function formatScopeNotice(scope: TestPathScope): string | undefined {
  if (!scope.isDirectory || scope.siblingPrefixMatches.length === 0) return undefined;
  const siblings = scope.siblingPrefixMatches
    .map((s) => `${s.path}/ (${s.testFileCount} test file${s.testFileCount === 1 ? '' : 's'})`)
    .join(', ');
  return (
    `Selected exactly ${scope.dispatchPath} (${scope.testFileCount} test file${scope.testFileCount === 1 ? '' : 's'}). ` +
    `Excluded ${scope.siblingPrefixMatches.length} sibling director${scope.siblingPrefixMatches.length === 1 ? 'y' : 'ies'} ` +
    `that a raw prefix match would also have run: ${siblings}. ` +
    'Pass them as separate paths to include them.'
  );
}
