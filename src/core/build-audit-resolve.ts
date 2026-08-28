// SPDX-License-Identifier: EUPL-1.2
/*
 * Path-resolution helpers for the post-build dist-tree audit.
 *
 * Resolves the expected on-disk artifact location for a given engine source
 * path. Matching purely by basename produces three classes of false
 * positive, each of which these helpers exist to avoid:
 *
 *   1. A branding override (`engine/browser/branding/<name>/content/
 *      aboutDialog.css`, shipped at `chrome/browser/content/branding/
 *      aboutDialog.css`) matching the unrelated upstream
 *      `chrome/browser/content/browser/aboutDialog.css`. Handled by ranking
 *      same-basename candidates on shared trailing path segments.
 *   2. Test files (`browser_*.js`, `test_*.js`) living under `_tests/`, not
 *      `dist/`. Handled by routing test paths to a separate resolver.
 *   3. Build inputs (`jar.mn`, `moz.build`, `Makefile.in`, `moz.configure`)
 *      that are consumed rather than packaged. Handled in `build-audit.ts`
 *      via `isPackageablePath`.
 */

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { pathExists } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';

/** Maximum directory depth to traverse when scanning a tree root. */
const MAX_SCAN_DEPTH = 12;

/**
 * Heuristic test for "this looks like a packaged-test source file" — the
 * audit routes such paths to `_tests/` instead of `dist/`. Matches
 * mochitest / xpcshell / browser-chrome conventions: any source under a
 * `/test/` or `/tests/` directory, anywhere under a `testing/` subtree
 * (which holds mochitest / marionette / xpcshell harness sources), or
 * with a `browser_` / `test_` prefix on a `.js`/`.toml` basename. Test
 * manifests (`*.toml`, `*.list`, `*.ini`) under those directories also
 * qualify.
 *
 * @param sourcePath Engine-relative POSIX path
 * @returns True when the file belongs to the test tree, not the bundle
 */
export function isTestPath(sourcePath: string): boolean {
  if (sourcePath.includes('/test/') || sourcePath.includes('/tests/')) {
    return true;
  }
  // `testing/{mochitest,marionette,xpcshell,...}` are test-infrastructure
  // trees that ship under `_tests/`, not `dist/`. Match both as a root
  // segment (e.g. `testing/mochitest/api.js`) and as an interior segment
  // (e.g. a vendored harness under `third_party/.../testing/...`).
  if (sourcePath.startsWith('testing/') || sourcePath.includes('/testing/')) {
    return true;
  }
  const name = basename(sourcePath);
  if (/^browser_.+\.(js|toml|ini)$/.test(name)) return true;
  if (/^test_.+\.(js|toml|ini)$/.test(name)) return true;
  return false;
}

/**
 * Splits a path into segments, dropping empties.
 *
 * Separators are normalized first because the candidates come from `join()`
 * over a `readdir` walk of the dist tree: on Windows those carry backslashes,
 * which a `/`-only split collapses into a SINGLE segment. Every candidate then
 * scores the same, so the trailing-overlap heuristic that disambiguates
 * same-basename artifacts (`branding/…/aboutDialog.css` versus
 * `browser/…/aboutDialog.css`) silently picks an arbitrary one.
 *
 * @param path Path in either separator style
 */
function pathSegments(path: string): string[] {
  return normalizePathSlashes(path).split('/').filter(Boolean);
}

/**
 * Counts how many trailing segments two paths share. Used to score
 * candidate dist artifacts against a source path so that
 * `branding/<name>/content/aboutDialog.css` prefers a candidate at
 * `…/content/branding/aboutDialog.css` over one at
 * `…/content/browser/aboutDialog.css`.
 *
 * @param a First path
 * @param b Second path
 * @returns Count of matching trailing segments (basename always counts as 1)
 */
export function countTrailingSegmentMatches(a: string, b: string): number {
  const aSegs = pathSegments(a);
  const bSegs = pathSegments(b);
  let matches = 0;
  while (
    matches < aSegs.length &&
    matches < bSegs.length &&
    aSegs[aSegs.length - 1 - matches] === bSegs[bSegs.length - 1 - matches]
  ) {
    matches += 1;
  }
  return matches;
}

/**
 * Path segments too common to identify an artifact on their own.
 *
 * Shared deliberately: this set governs two halves of ONE decision —
 * `scoreCandidate` (selection) and `isConfidentMatch` (confirmation, in
 * `build-audit.ts`). When the halves kept separate copies they disagreed,
 * so a source path could earn a selection bonus for a segment that
 * confirmation then rejected as meaningless, leaving the chosen artifact
 * unconfirmable. Any addition must apply to both halves, which is now
 * automatic.
 */
export const GENERIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'content',
  'chrome',
  'bin',
  'browser',
  'toolkit',
  'modules',
  'base',
  'app',
  'profile',
  'shared',
  'themes',
  'test',
  'tests',
  'unit',
  'common',
  'xpcshell',
  'mochitest',
]);

/**
 * Computes a score for `candidatePath` relative to `sourcePath`. Higher
 * scores win. Score = trailing-segment match count, with a bonus when the
 * candidate's path contains a meaningful intermediate segment from the
 * source (e.g. `branding`, or the branding dir name itself).
 *
 * The bonus exists because Firefox packaging often re-roots files: a source
 * `branding/<name>/content/aboutDialog.css` lands at
 * `chrome/browser/content/branding/aboutDialog.css` — only the basename
 * trails-match, but the `branding` segment moved into the middle of the
 * candidate path. Without the bonus that candidate ties with the unrelated
 * `chrome/browser/content/browser/aboutDialog.css`.
 *
 * @param sourcePath Engine-relative POSIX path
 * @param candidatePath Absolute path under the dist tree
 * @returns Numeric score; higher means better match
 */
export function scoreCandidate(sourcePath: string, candidatePath: string): number {
  const trailing = countTrailingSegmentMatches(sourcePath, candidatePath);
  const sourceSegs = pathSegments(sourcePath);
  const candSegs = pathSegments(candidatePath);

  // Look for source segments that appear anywhere in the candidate path
  // but are not part of the trailing match. Each unique mid-path hit on
  // a meaningful (>2-char, not generic like 'content'/'chrome'/'bin')
  // segment adds 1 to the score.
  const generic = GENERIC_PATH_SEGMENTS;
  const trailingSet = new Set(sourceSegs.slice(sourceSegs.length - trailing));
  let bonus = 0;
  for (const seg of sourceSegs) {
    if (seg.length <= 2) continue;
    if (generic.has(seg)) continue;
    if (trailingSet.has(seg)) continue;
    if (candSegs.includes(seg)) bonus += 1;
  }
  return trailing * 10 + bonus;
}

/**
 * Walks a tree under `root` and returns every file whose basename equals
 * `name`. Skips dotfile / hidden directories so the symlinked
 * `.mozbuild` cache (a full upstream copy) does not dominate the scan
 * on macOS.
 *
 * @param root Tree root to search
 * @param name Basename to match
 * @param maxDepth Optional traversal cap (default 12)
 * @returns All matching absolute paths
 */
export async function findAllByBasename(
  root: string,
  name: string,
  maxDepth: number = MAX_SCAN_DEPTH
): Promise<string[]> {
  const results: string[] = [];
  if (!(await pathExists(root))) return results;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.depth > maxDepth) continue;
    let children;
    try {
      children = await readdir(entry.dir, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory yields no candidates. Skip it and keep
      // scoring the rest rather than abandoning the whole resolution.
      continue;
    }
    for (const child of children) {
      const fullPath = join(entry.dir, child.name);
      if (child.isDirectory()) {
        if (child.name.startsWith('.')) continue;
        stack.push({ dir: fullPath, depth: entry.depth + 1 });
        continue;
      }
      if (child.name === name) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Resolves the best-matching artifact for a source path under one or
 * more search roots. Returns the highest-scoring candidate by trailing
 * segment overlap; ties go to the first-found path (deterministic via
 * the directory-walk order). Returns undefined when no candidate exists.
 *
 * @param sourcePath Engine-relative POSIX source path
 * @param searchRoots Absolute roots to scan (e.g. dist/, _tests/)
 * @returns Best-matching artifact path, or undefined
 */
export async function resolveBestArtifact(
  sourcePath: string,
  searchRoots: readonly string[]
): Promise<string | undefined> {
  const name = basename(sourcePath);
  const allCandidates: string[] = [];
  for (const root of searchRoots) {
    const found = await findAllByBasename(root, name);
    allCandidates.push(...found);
  }
  if (allCandidates.length === 0) return undefined;
  if (allCandidates.length === 1) return allCandidates[0];

  let bestScore = -1;
  let best: string | undefined;
  for (const candidate of allCandidates) {
    const score = scoreCandidate(sourcePath, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
