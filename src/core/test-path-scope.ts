// SPDX-License-Identifier: EUPL-1.2
/**
 * Directory-argument scope analysis for `fireforge test`.
 *
 * mozbuild's test resolver matches command-line paths by STRING PREFIX,
 * so `fireforge test browser/base/content/test/hominis` silently also
 * ran the sibling directory `browser/base/content/test/hominis-tiles`
 * (152.0b7 → 153.0b8 source-refresh drill: 1224 tests instead of ~200,
 * with no indication the scope widened).
 *
 * FireForge therefore treats a directory argument as meaning EXACTLY
 * that directory: {@link analyzeTestPathScopes} enumerates the test
 * files of exactly that directory and dispatches THAT explicit file
 * list to mach — a file list cannot prefix-match anything. (0.35.0
 * instead normalized the directory with a trailing `/`, assuming the
 * separator makes the prefix match exact; field verification on Firefox
 * 153 showed mach still swept in the prefix-named sibling, so the
 * trailing-slash mechanism was cosmetic and its exclusion echo was
 * wrong.) The prefix-matching sibling directories are still reported so
 * the command layer can tell the operator what was excluded. Note
 * FireForge already rejects non-existent paths up front, so raw
 * prefix-widening was never something an operator could invoke
 * deliberately — it only ever happened by accident.
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
   * The paths to hand to mach for this argument: the explicit test-file
   * list for a directory (mach cannot prefix-widen an explicit file
   * list), or the argument unchanged for files. A directory containing
   * no enumerable test files falls back to the trailing-`/` directory
   * form — there is nothing to list, and mach owns the "no tests found"
   * failure.
   */
  dispatchPaths: string[];
  /** True when the path resolved to a directory under engine/. */
  isDirectory: boolean;
  /** Test files enumerated inside the requested directory (empty for files). */
  testFileCount: number;
  /** Sibling directories a raw prefix match would also have selected. */
  siblingPrefixMatches: SiblingPrefixMatch[];
}

/** Test implementation files as mozbuild manifests name them. */
const TEST_FILE_PATTERN = /^(?:browser|test)_.*\.(?:m?js|x?html)$/;

/**
 * Recursively enumerates test-implementation files under a directory,
 * returned engine-relative and sorted for deterministic dispatch order.
 * Returns [] when the directory cannot be read — the caller then falls
 * back to the directory form and mach owns the failure.
 */
async function collectTestFiles(dir: string, relPrefix: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(join(dir, entry.name), `${relPrefix}${entry.name}/`)));
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      files.push(`${relPrefix}${entry.name}`);
    }
  }
  return files.sort();
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
      dispatchPaths: [requestedPath],
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
      const testFileCount = (
        await collectTestFiles(join(dirname(absolute), entry.name), `${siblingRel}/`)
      ).length;
      // A prefix-matching sibling with no test files never surfaces in a
      // mach run, so listing it would only add noise.
      if (testFileCount > 0) {
        siblingPrefixMatches.push({ path: siblingRel, testFileCount });
      }
    }
  } catch {
    // Unreadable parent: skip the sibling probe; exactness via the
    // explicit file list is preserved regardless.
  }

  const testFiles = await collectTestFiles(absolute, `${stripped}/`);
  return {
    requestedPath,
    // The explicit file list is what makes the selection exact; an empty
    // enumeration falls back to the directory form.
    dispatchPaths: testFiles.length > 0 ? testFiles : [`${stripped}/`],
    isDirectory: true,
    testFileCount: testFiles.length,
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
  const requestedDir = scope.requestedPath.replace(/\/+$/, '');
  const siblings = scope.siblingPrefixMatches
    .map((s) => `${s.path}/ (${s.testFileCount} test file${s.testFileCount === 1 ? '' : 's'})`)
    .join(', ');
  if (scope.testFileCount === 0) {
    // Fallback dispatch: with nothing to enumerate, the raw directory
    // form goes to mach, whose prefix matching CAN sweep the siblings in.
    // Claiming exclusion here would repeat the 0.35.0 mistake.
    return (
      `${requestedDir}/ contains no enumerable test files, so the directory is passed to mach ` +
      `as-is — mach resolves paths by string prefix, which may also select: ${siblings}.`
    );
  }
  return (
    `Selected exactly ${requestedDir}/ by passing its ${scope.testFileCount} test file${scope.testFileCount === 1 ? '' : 's'} ` +
    'explicitly to mach (an explicit file list cannot prefix-match a sibling). ' +
    `Excluded ${scope.siblingPrefixMatches.length} prefix-named sibling director${scope.siblingPrefixMatches.length === 1 ? 'y' : 'ies'}: ${siblings}. ` +
    'Pass them as separate paths to include them.'
  );
}
