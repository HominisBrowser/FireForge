// SPDX-License-Identifier: EUPL-1.2
/*
 * Post-build dist-tree audit.
 *
 * Purpose: catch the class of bug where a file under engine/ was edited
 * but never registered in moz.build, jar.mn, or package-manifest.in, so
 * the mach build reports success but the packaged bundle carries stale
 * or missing content. A fork-specific pref file that was never registered
 * for packaging is the motivating case.
 *
 * The audit is best-effort and warn-only:
 *   - It enumerates engine files changed since the previous build baseline
 *     (git-tracked diff + workdir modifications).
 *   - For each file whose path pattern implies packaging, it resolves
 *     the expected dist artifact under obj-star/dist/binary-name-star.
 *   - A warning fires when the expected artifact is missing OR when its
 *     mtime is older than the engine source (the build was reported
 *     successful but that file's path never flowed through packaging).
 *   - False positives are acceptable at this stage: fork-specific packaging
 *     tricks FireForge doesn't know about will surface as warnings an
 *     operator can investigate. The audit never fails the build.
 *
 * Routing rules:
 *   - Build inputs (jar.mn, moz.build, Makefile.in, moz.configure) are
 *     skipped; they are consumed, not packaged.
 *   - Test sources (anything under /test(s)/, browser_*.js, test_*.js)
 *     are looked up under _tests/, not dist/ — that's where mach copies
 *     them.
 *   - Files inside an `if CONFIG[...]:` block in moz.build that gates
 *     off on the current host are skipped (Windows stubinstaller CSS on
 *     a macOS build, etc.).
 *   - Same-basename collisions in dist/ are disambiguated by trailing-
 *     segment overlap so a branding override does not get matched
 *     against an unrelated upstream file with the same basename.
 */

import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, verbose, warn } from '../utils/logger.js';
import { detectPlatformGate } from './build-audit-platform.js';
import {
  countTrailingSegmentMatches,
  isTestPath,
  resolveBestArtifact,
} from './build-audit-resolve.js';
import type { BuildBaseline } from './build-baseline.js';
import { hasChanges, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

/** Path extensions that are conventionally packaged into the Firefox bundle. */
const PACKAGEABLE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.jsm',
  '.css',
  '.ftl',
  '.xhtml',
  '.xul',
  '.html',
  '.properties',
];

/** Path fragments whose contents are packaged regardless of extension. */
const PACKAGEABLE_PATH_FRAGMENTS = ['/app/profile/', '/chrome/', '/locales/'];

/** Directories that are build artifacts, not source — never audited. */
const IGNORE_PATH_FRAGMENTS = ['obj-', 'node_modules/', '.git/', '.cargo/', '.mozbuild/'];

/**
 * Basenames that are build-system inputs, not packaged artifacts.
 * `jar.mn` is consumed to produce chrome registrations; `moz.build` /
 * `moz.configure` / `Makefile.in` feed the build backend; none of them
 * ship in the bundle. Auditing them produced a guaranteed false
 * positive on every edit (nothing under dist/ ever has these names),
 * and a worse failure mode when an unrelated upstream `moz.build`
 * coincidentally exists at e.g. `MyBrowser.app/Contents/moz.build` and
 * gets matched as a "stale artifact" of an entirely different file.
 */
const BUILD_INPUT_BASENAMES = new Set([
  'jar.mn',
  'moz.build',
  'moz.configure',
  'Makefile.in',
  'mozbuild.in',
]);

/** Result of a single artifact lookup. */
export interface AuditEntry {
  /** Engine-relative source file path (POSIX separators). */
  source: string;
  /**
   * Resolved artifact path inside the dist tree, or undefined when no
   * candidate bundle location was found. An entry with an undefined path
   * and status "missing" means the source was packageable but nothing
   * that looked like its artifact showed up in the bundle.
   */
  artifact: string | undefined;
  /**
   * updated: an artifact exists and is at least as new as the source.
   * stale:   artifact exists but is older than the source (probable packaging drop).
   * missing: no artifact with a matching basename was found anywhere under dist/.
   * skipped: the file extension / path does not imply packaging; not counted.
   */
  status: 'updated' | 'stale' | 'missing' | 'skipped';
}

/** Summary counts for the "Packaged:" end-of-build line. */
export interface AuditSummary {
  updated: number;
  stale: number;
  missing: number;
  skipped: number;
  entries: AuditEntry[];
}

/**
 * Decides whether a source path should be packaged. Returns true for paths
 * whose extension or directory fragment matches a known-packaged pattern,
 * after excluding build inputs (`jar.mn`, `moz.build`, etc.) which are
 * consumed by the build but never themselves packaged.
 *
 * @param sourcePath Engine-relative POSIX path (for example browser/app/profile/pref.js).
 * @returns True when the path implies packaging.
 */
export function isPackageablePath(sourcePath: string): boolean {
  for (const fragment of IGNORE_PATH_FRAGMENTS) {
    if (sourcePath.includes(fragment)) return false;
  }
  if (BUILD_INPUT_BASENAMES.has(basename(sourcePath))) return false;
  for (const ext of PACKAGEABLE_EXTENSIONS) {
    if (sourcePath.endsWith(ext)) return true;
  }
  for (const fragment of PACKAGEABLE_PATH_FRAGMENTS) {
    if (sourcePath.includes(fragment)) return true;
  }
  return false;
}

/**
 * Collects engine-relative paths changed since the baseline's HEAD SHA.
 * Always includes modified + untracked workdir paths. When the baseline is
 * missing or the engine has no HEAD yet, falls back to workdir-only diffs.
 */
async function collectChangedFiles(
  engineDir: string,
  baseline: BuildBaseline | undefined
): Promise<string[]> {
  const collected = new Set<string>();

  if (baseline?.engineHeadSha) {
    try {
      const output = await git(
        ['diff', '--name-only', `${baseline.engineHeadSha}..HEAD`],
        engineDir
      );
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
    } catch (error: unknown) {
      if (!isMissingHeadError(error)) {
        verbose(`Audit: could not diff against baseline SHA — ${toError(error).message}`);
      }
    }
  }

  try {
    if (await hasChanges(engineDir)) {
      const worktreeDiff = await git(['diff', '--name-only', 'HEAD'], engineDir);
      for (const line of worktreeDiff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
      const untracked = await getUntrackedFiles(engineDir);
      for (const file of untracked) {
        collected.add(file);
      }
    }
  } catch (error: unknown) {
    verbose(`Audit: could not enumerate workdir changes — ${toError(error).message}`);
  }

  return [...collected].sort();
}

/*
 * Finds the unique obj-star directory with a dist subtree, or undefined
 * when zero or multiple match. The ambiguous case is already rejected
 * by pre-flight in build.ts, so the auditor only has to handle
 * one-or-none.
 */
async function resolveDistRoot(engineDir: string): Promise<string | undefined> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(engineDir);
  } catch {
    return undefined;
  }
  const objDirs = entries.filter((e) => e.startsWith('obj-'));
  for (const objDir of objDirs) {
    const distPath = join(engineDir, objDir, 'dist');
    if (await pathExists(distPath)) {
      return distPath;
    }
  }
  return undefined;
}

/**
 * Resolves the `_tests/` tree under the active obj-* directory, used as
 * a secondary search root for sources that look like packaged tests.
 * Returns undefined when no obj dir exists yet.
 */
async function resolveTestsRoot(engineDir: string): Promise<string | undefined> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(engineDir);
  } catch {
    return undefined;
  }
  const objDirs = entries.filter((e) => e.startsWith('obj-'));
  for (const objDir of objDirs) {
    const testsPath = join(engineDir, objDir, '_tests');
    if (await pathExists(testsPath)) {
      return testsPath;
    }
  }
  return undefined;
}

/**
 * Marker file the `package-tests` make target writes after copying the
 * full test-source tree under `_tests/`. Its presence is the most reliable
 * signal that test packaging has actually run for the current obj-dir —
 * plain `mach build` populates a partial `_tests/` subtree and then stops,
 * so registered tests are absent even when registration is correct.
 */
const PACKAGED_TESTS_MARKER = 'all-tests.json';

/**
 * Returns true when the full test-package step has actually run for the
 * active obj-dir. Without this marker the `_tests/` walk produces false
 * positives for every correctly-registered mochitest / xpcshell source
 * on the common "built but tests not packaged" path.
 *
 * @param testsRoot Absolute path to the obj-*`/_tests/` tree, or undefined.
 */
async function hasPackagedTestsMarker(testsRoot: string | undefined): Promise<boolean> {
  if (!testsRoot) return false;
  return pathExists(join(testsRoot, PACKAGED_TESTS_MARKER));
}

/**
 * Resolves the search roots an individual source path should be looked
 * up under. Test-shaped paths get `_tests/`; everything else gets `dist/`.
 */
function searchRootsFor(source: string, distRoot: string, testsRoot: string | undefined): string[] {
  if (isTestPath(source)) {
    return testsRoot ? [testsRoot] : [];
  }
  return [distRoot];
}

interface AuditEvalContext {
  engineDir: string;
  distRoot: string;
  testsRoot: string | undefined;
  /** True when `_tests/all-tests.json` exists for the active obj dir. */
  testsPackaged: boolean;
}

/**
 * Minimum trailing-segment overlap required for a same-basename dist/
 * candidate to count as "the packaged artifact" of a source. The
 * basename always trail-matches (count 1), so a threshold of 2 requires
 * the immediate parent directory to also agree. Candidates that only
 * share the basename are classified as missing — warning the operator
 * to check registration — rather than emitting a misleading stale
 * comparison against an unrelated file of the same name.
 *
 * Cross-tree re-rooting cases (e.g. `branding/<name>/content/foo.css`
 * landing at `chrome/<area>/content/branding/foo.css`) bypass this
 * floor because `scoreCandidate` awards a non-generic-segment bonus
 * that lifts the confidence regardless of trailing overlap; those are
 * detected below in `isConfidentMatch`.
 */
const MIN_TRAILING_SEGMENT_OVERLAP = 2;

/**
 * Returns true when the chosen artifact is structurally related to the
 * source path — either its immediate parent directory trail-matches, or
 * a non-generic intermediate source segment appears in the candidate
 * path (the branding-re-root signal already used by the scorer).
 *
 * Used to avoid emitting `stale` warnings that point at an unrelated
 * same-basename file picked up by the basename walker — a class of
 * warning that is worse than `missing` because it reads as "your build
 * dropped this file" when in fact the match is spurious.
 */
function isConfidentMatch(source: string, candidate: string): boolean {
  if (countTrailingSegmentMatches(source, candidate) >= MIN_TRAILING_SEGMENT_OVERLAP) {
    return true;
  }
  const sourceSegs = source.split('/').filter(Boolean);
  const candSegs = candidate.split('/').filter(Boolean);
  const generic = new Set([
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
  // Skip the basename itself (which trail-matches by definition).
  for (let i = 0; i < sourceSegs.length - 1; i += 1) {
    const seg = sourceSegs[i];
    if (!seg || seg.length <= 2 || generic.has(seg)) continue;
    if (candSegs.includes(seg)) return true;
  }
  return false;
}

/**
 * Audits one engine source path and returns its entry. Pure orchestration
 * helper kept separate so `auditBuildArtifacts` stays under the per-function
 * line budget.
 */
async function auditSinglePath(
  source: string,
  ctx: AuditEvalContext
): Promise<AuditEntry & { warning?: string }> {
  if (!isPackageablePath(source)) {
    return { source, artifact: undefined, status: 'skipped' };
  }

  const gate = await detectPlatformGate(ctx.engineDir, source);
  if (gate.gatedOff) {
    verbose(`Audit: skipping engine/${source} — gated off by "${gate.gateExpression ?? '?'}".`);
    return { source, artifact: undefined, status: 'skipped' };
  }

  // Tests only end up under `_tests/` after `mach package-tests` (or a
  // test-run that invokes the target) has executed. A plain `mach build`
  // populates a partial subtree and stops, so every correctly-registered
  // mochitest / xpcshell source appears "missing" on that common path.
  // Skip audit for test sources when no packaged-tests marker is present.
  if (isTestPath(source) && !ctx.testsPackaged) {
    verbose(
      `Audit: skipping engine/${source} — _tests/${PACKAGED_TESTS_MARKER} not present; full test packaging has not run for this build.`
    );
    return { source, artifact: undefined, status: 'skipped' };
  }

  const sourcePath = join(ctx.engineDir, source);
  let sourceMtime: number;
  try {
    const sourceStat = await stat(sourcePath);
    sourceMtime = sourceStat.mtimeMs;
  } catch {
    // Deletion that didn't propagate — distinct class of bug, not audited yet.
    return { source, artifact: undefined, status: 'skipped' };
  }

  const roots = searchRootsFor(source, ctx.distRoot, ctx.testsRoot);
  const artifact = await resolveBestArtifact(source, roots);
  if (!artifact) {
    const where = isTestPath(source) ? '_tests/' : 'dist/';
    return {
      source,
      artifact: undefined,
      status: 'missing',
      warning: `Audit: engine/${source} was touched but no packaged artifact with basename "${basename(source)}" was found under ${where}. Missing moz.build / jar.mn / package-manifest.in registration?`,
    };
  }

  let artifactMtime: number;
  try {
    const artifactStat = await stat(artifact);
    artifactMtime = artifactStat.mtimeMs;
  } catch {
    return {
      source,
      artifact,
      status: 'missing',
      warning: `Audit: engine/${source} has no readable packaged artifact at ${artifact} (disappeared during audit).`,
    };
  }

  if (artifactMtime + 1 < sourceMtime) {
    // Before claiming "stale", verify the match is structurally related.
    // A same-basename hit in an unrelated subtree (e.g. `head.js` in a
    // completely different upstream test helper) should be reported as
    // missing — the operator needs to check registration, not puzzle
    // over why an unrelated file appears "older than the source".
    if (!isConfidentMatch(source, artifact)) {
      const where = isTestPath(source) ? '_tests/' : 'dist/';
      return {
        source,
        artifact: undefined,
        status: 'missing',
        warning: `Audit: engine/${source} was touched but no related packaged artifact with basename "${basename(source)}" was found under ${where} (nearest same-basename file ${artifact} lives in an unrelated subtree). Missing moz.build / jar.mn / package-manifest.in registration?`,
      };
    }
    return {
      source,
      artifact,
      status: 'stale',
      warning: `Audit: engine/${source} is newer than its packaged artifact ${artifact}. Build reported success but the file's path may not flow through packaging — check moz.build / jar.mn entries.`,
    };
  }

  return { source, artifact, status: 'updated' };
}

/**
 * Runs the post-build audit. Emits per-file warnings for missing or
 * stale artifacts and a summary info line at the end. Always returns
 * the summary; never throws on audit failure (the audit itself must
 * never fail a successful build).
 * @param projectRoot Root of the project (reserved for future fork-specific rules).
 * @param engineDir Path to the engine directory.
 * @param baseline Optional previous-build baseline marker.
 * @returns Summary of artifact status counts.
 */
export async function auditBuildArtifacts(
  projectRoot: string,
  engineDir: string,
  baseline: BuildBaseline | undefined
): Promise<AuditSummary> {
  void projectRoot;
  const summary: AuditSummary = {
    updated: 0,
    stale: 0,
    missing: 0,
    skipped: 0,
    entries: [],
  };

  const distRoot = await resolveDistRoot(engineDir);
  if (!distRoot) {
    verbose('Audit skipped: no dist tree found under obj-*/dist/.');
    return summary;
  }
  const testsRoot = await resolveTestsRoot(engineDir);
  const testsPackaged = await hasPackagedTestsMarker(testsRoot);

  const changed = await collectChangedFiles(engineDir, baseline);
  if (changed.length === 0) {
    return summary;
  }

  const ctx: AuditEvalContext = { engineDir, distRoot, testsRoot, testsPackaged };
  for (const source of changed) {
    const result = await auditSinglePath(source, ctx);
    summary[result.status] += 1;
    summary.entries.push({
      source: result.source,
      artifact: result.artifact,
      status: result.status,
    });
    if (result.warning) warn(result.warning);
  }

  info(
    `Packaged: ${summary.updated} updated, ${summary.stale} stale, ${summary.missing} missing, ${summary.skipped} skipped`
  );

  return summary;
}
