// SPDX-License-Identifier: EUPL-1.2
/*
 * Stale-build preflight for `fireforge test`.
 *
 * Without this preflight, an operator who edits engine chrome / packaged
 * resources (`jar.mn` entries, `.xhtml`/`.mjs`/`.css` under chrome trees,
 * pref files) and then runs `fireforge test <path>` only discovers the
 * build is stale AFTER xpcshell / mach test starts and errors out with
 * `NS_ERROR_FILE_NOT_FOUND` against a `chrome://browser/content/…` URI
 * — which reads as a test bug, not a rebuild prompt. The motivating case
 * was scaffolding a new top-level chrome document + BrowserGlue-style
 * xpcshell test: the test file existed, the manifests were registered,
 * but `dist/` still held the pre-edit bundle and chrome URIs resolved
 * to nothing.
 *
 * This preflight diffs engine HEAD (or workdir) against the last-build
 * baseline (`.fireforge/last-build.json`), filters to paths that imply
 * packaging, and returns a compact summary. `fireforge test` prints a
 * warning up-front so the operator sees "you edited X, Y, Z since the
 * last build — rerun with `--build` to refresh" BEFORE mach test
 * launches. Detection stays advisory (warn-only) because a fork that
 * rebuilds out-of-band (a separate `./mach build` invocation, an IDE
 * plugin, etc.) can legitimately have a fresh `dist/` with no
 * FireForge-recorded baseline update.
 */

import { toError } from '../utils/errors.js';
import { verbose, warn } from '../utils/logger.js';
import { isPackageablePath, isXpcomManifestPath } from './build-audit.js';
import { readBuildBaseline } from './build-baseline.js';
import type { BuildBaseline, TestPackagingCoverage } from './build-baseline-types.js';
import { hashEngineFile } from './coverage-extend.js';
import { collectChangedEnginePaths } from './engine-changes.js';

export { isXpcomManifestPath };

/** Result of the stale-build preflight probe. */
export interface StaleBuildResult {
  /** True when at least one packageable engine file changed since the baseline. */
  stale: boolean;
  /**
   * Engine-relative paths that would have been packaged but appear to have
   * changed since the baseline. Sorted and deduplicated. Truncated at
   * {@link STALE_PATHS_LIMIT} entries for rendering; consult
   * {@link StaleBuildResult.truncated} to know when to append a `(+N more)`
   * tail to the warning.
   */
  changedPaths: string[];
  /**
   * How many paths were dropped from `changedPaths` due to the render cap.
   * Callers render this as `(+N more)` in the warning body.
   */
  truncated: number;
  /**
   * The baseline that anchored the diff, or undefined when no previous
   * successful build exists. A missing baseline is treated as "not stale"
   * — we have nothing to compare against and a warning would mislead.
   */
  baseline: BuildBaseline | undefined;
}

/** Cap on the number of changed paths rendered inline. */
const STALE_PATHS_LIMIT = 10;

/**
 * Probes the engine tree for packageable changes since the last successful
 * `fireforge build`. Returns a summary the `fireforge test` handler renders
 * as an up-front warning when `--build` was NOT passed. The probe never
 * throws; git failures and a missing baseline both degrade to `stale: false`
 * so a broken probe cannot block a test run.
 *
 * @param projectRoot Root directory of the project.
 * @param engineDir Path to the engine directory.
 */
export async function checkStaleBuildForTest(
  projectRoot: string,
  engineDir: string
): Promise<StaleBuildResult> {
  const baseline = await readBuildBaseline(projectRoot);
  if (!baseline) {
    return { stale: false, changedPaths: [], truncated: 0, baseline: undefined };
  }

  const changed = await collectChangedEnginePaths(engineDir, baseline, 'Stale-build preflight');
  let packageable = changed.filter((path) => isPackageablePath(path)).sort();

  // Content-hash comparison: when the baseline carries a fingerprint set,
  // fold each candidate path through a live re-hash and drop paths whose
  // current content matches the baseline. Pre-0.16.0 baselines have no
  // `packageableFingerprints` field; those fall through and the
  // path-only comparison behaves as before (every workdir-dirty
  // packageable path is reported as stale). The concrete motivating
  // case: a project with imported patches + Furnace-applied components
  // always has a persistent workdir diff against HEAD. Before the
  // fingerprint layer, `git diff --name-only HEAD` returned that diff
  // on every build, so the stale check fired immediately after a
  // successful build even though nothing had actually changed. The
  // fingerprints capture "these files had this content when the build
  // ran"; a path stays stale only when its live hash diverges.
  const fingerprints = baseline.packageableFingerprints;
  if (fingerprints) {
    const staleAfterHashCheck: string[] = [];
    for (const path of packageable) {
      const recorded = fingerprints[path];
      const live = await hashEngineFile(engineDir, path);
      if (recorded === undefined || live === undefined || recorded !== live) {
        staleAfterHashCheck.push(path);
      }
    }
    packageable = staleAfterHashCheck;
  }

  if (packageable.length === 0) {
    return { stale: false, changedPaths: [], truncated: 0, baseline };
  }

  const head = packageable.slice(0, STALE_PATHS_LIMIT);
  const truncated = Math.max(0, packageable.length - head.length);
  return { stale: true, changedPaths: head, truncated, baseline };
}

/**
 * Formats a human-readable warning body from a {@link StaleBuildResult}.
 * Kept separate from the probe so test code can assert on the structured
 * result without matching the rendered copy.
 */
export function formatStaleBuildWarning(result: StaleBuildResult): string {
  const tail = result.truncated > 0 ? `, … (+${result.truncated} more)` : '';
  const list = result.changedPaths.join(', ') + tail;
  return (
    `Engine tree has changed since the last successful fireforge build (${list}).\n` +
    'The current obj-*/dist/ bundle may not reflect those edits. If your test reads ' +
    'packaged chrome / jar.mn resources, rerun with "fireforge test --build" (or ' +
    '"fireforge build --ui") first. Passing --build skips this check.'
  );
}

/**
 * Sentinel returned by {@link findUncoveredRequestPaths} when a full-suite
 * request (no paths) is checked against a scoped coverage record.
 */
export const FULL_SUITE_REQUEST = '(entire suite)';

/**
 * Compares the requested test paths against the packaged runtime's coverage
 * claim recorded in the baseline. Returns the requested paths the recorded
 * packaging does NOT cover — the runs that would dispatch against missing
 * `_tests/` support fixtures and hang rather than fail.
 *
 * Coverage semantics: `undefined` (pre-0.37.0 baseline) and `'full'` cover
 * everything. A scoped list covers a request path when the request equals a
 * covered entry, sits beneath a covered directory entry, or shares a
 * manifest granule with a covered entry ({@link toManifestGranule} — a
 * scoped `test --build` packages the whole manifest directory, so a
 * same-manifest sibling of a covered file is packaged too). Both sides are
 * normalized to forward slashes so Windows-style CLI input cannot defeat
 * the prefix rule (baseline paths are POSIX by convention). A request with
 * no paths is a full-suite run and is never covered by a scoped list — the
 * {@link FULL_SUITE_REQUEST} sentinel is returned so the refusal can name it.
 */
export function findUncoveredRequestPaths(
  coverage: TestPackagingCoverage | undefined,
  requestedPaths: readonly string[]
): string[] {
  if (coverage === undefined || coverage === 'full') {
    return [];
  }
  const covered = coverage.map(normalizeCoveragePath).filter((p) => p.length > 0);
  if (requestedPaths.length === 0) {
    return [FULL_SUITE_REQUEST];
  }
  return requestedPaths.filter((requested) => {
    const path = normalizeCoveragePath(requested);
    const granule = toManifestGranule(path);
    return !covered.some(
      (c) => path === c || path.startsWith(`${c}/`) || granule === toManifestGranule(c)
    );
  });
}

/**
 * Maps a normalized request/coverage path to the "manifest granule" the
 * packaged runtime actually staged: an extension-bearing basename (a test
 * FILE) maps to its containing directory, a directory (no dot in the
 * basename) maps to itself. Purely lexical — the directory-as-manifest
 * approximation holds because xpcshell/mochitest manifests live next to
 * their test files and a scoped `test --build` stages the whole manifest
 * directory into `obj-*`/`_tests/`, not single files. Caveat: a DIRECTORY
 * whose basename contains a dot is misread as a file and mapped to its
 * parent, which widens (never narrows) the covered granule.
 */
function toManifestGranule(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  if (!base.includes('.')) {
    return path;
  }
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Normalizes a path for coverage comparison: forward slashes, no trailing slash. */
function normalizeCoveragePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Formats the refusal shown when a non-`--build` run requests paths the
 * packaged runtime's scoped `test --build` coverage does not include —
 * enforced on every such run, with or without `--allow-stale-build`. Kept
 * separate from the matcher so tests can pin structure and copy
 * independently (same split as {@link formatStaleBuildWarning}).
 */
export function formatTestCoverageRefusal(uncovered: string[], coverage: string[]): string {
  const cap = (paths: string[]): string => {
    const head = paths.slice(0, STALE_PATHS_LIMIT);
    const truncated = paths.length - head.length;
    return head.join(', ') + (truncated > 0 ? `, … (+${truncated} more)` : '');
  };
  const rebuildTargets = uncovered.filter((p) => p !== FULL_SUITE_REQUEST);
  const rebuildHint =
    rebuildTargets.length > 0
      ? `Rerun "fireforge test --build ${rebuildTargets.slice(0, STALE_PATHS_LIMIT).join(' ')}" to package them, or run "fireforge build" for full coverage.`
      : 'Run "fireforge build" (or a path-less "fireforge test --build") for full coverage first.';
  return (
    `The packaged test runtime was produced by a scoped "fireforge test --build" covering only: ${cap(coverage)}.\n` +
    `The requested run needs ${cap(uncovered)}, which that packaging does not cover — support ` +
    'fixtures for those manifests may be missing from obj-*/_tests/, and the run can hang ' +
    `rather than fail. ${rebuildHint} ` +
    '(--allow-stale-build does not bypass this check — it accepts stale content, not missing coverage.)'
  );
}

/** Result of the compiled-StaticComponents staleness probe. */
export interface StaticComponentsStaleResult {
  /** True when at least one `components.conf` genuinely diverged from the anchor. */
  stale: boolean;
  /**
   * Engine-relative `components.conf` paths changed since the last FULL
   * build. Sorted; NOT capped — {@link formatStaticComponentsRefusal}
   * applies the render cap.
   */
  changedManifests: string[];
}

/**
 * Probes whether any `components.conf` changed since the last FULL
 * `fireforge build` — i.e. since the compiled StaticComponents table was
 * last regenerated. `components.conf` entries bake into compiled code; a
 * scoped `test --build` packages the file but the child process resolves
 * the OLD table and fails with `NS_ERROR_MALFORMED_URI` that reads as a
 * test bug.
 *
 * The diff anchors to the baseline's `staticComponentsBaseline` (the last
 * full build's engine HEAD SHA), NOT the baseline's own `engineHeadSha`
 * which a scoped `test --build` advances. Dirty candidates are hash-checked
 * against the anchor's fingerprints so only genuine content divergence
 * counts. No baseline / no anchor (pre-0.38.0 marker) → fresh. Never
 * throws — the probes it composes degrade to verbose lines and empty
 * results on git failure, matching {@link checkStaleBuildForTest}.
 */
export async function checkStaticComponentsStale(
  engineDir: string,
  baseline: BuildBaseline | undefined
): Promise<StaticComponentsStaleResult> {
  const anchor = baseline?.staticComponentsBaseline;
  if (baseline === undefined || anchor === undefined) {
    return { stale: false, changedManifests: [] };
  }

  const changed = await collectChangedEnginePaths(
    engineDir,
    { ...baseline, engineHeadSha: anchor.engineHeadSha },
    'Static-components preflight'
  );
  const changedManifests: string[] = [];
  for (const path of changed.filter((p) => isXpcomManifestPath(p))) {
    const recorded = anchor.fingerprints[path];
    const live = await hashEngineFile(engineDir, path);
    if (recorded === undefined || live === undefined || recorded !== live) {
      changedManifests.push(path);
    }
  }
  return { stale: changedManifests.length > 0, changedManifests };
}

/**
 * Formats the refusal shown when a run would dispatch against a stale
 * compiled StaticComponents table. Same probe/copy split as
 * {@link formatStaleBuildWarning} so tests can pin structure and wording
 * independently.
 */
export function formatStaticComponentsRefusal(changedManifests: string[]): string {
  const head = changedManifests.slice(0, STALE_PATHS_LIMIT);
  const truncated = changedManifests.length - head.length;
  const list = head.join(', ') + (truncated > 0 ? `, … (+${truncated} more)` : '');
  return (
    `The compiled StaticComponents table is stale: ${list} changed since the last full "fireforge build".\n` +
    'components.conf registrations are baked into compiled code that only a FULL build ' +
    'regenerates — a scoped "fireforge test --build" repackages files but the child process ' +
    'resolves the old component table and fails with NS_ERROR_MALFORMED_URI that reads as a ' +
    'test bug. Run "fireforge build" first. (--allow-stale-build does not bypass this check — ' +
    'it accepts stale packaged content, not a stale compiled registration. Pass ' +
    '--allow-stale-components only if you rebuilt out-of-band and accept the risk.)'
  );
}

/**
 * Formats the post-mutation advisory printed by `fireforge reset` /
 * `fireforge import` when `components.conf` diverged from the last full
 * build (FORGE F13). Same probe as {@link formatStaticComponentsRefusal},
 * different moment: this fires at mutation time so the operator learns a
 * full build is needed BEFORE the next gate run refuses.
 */
export function formatPostMutationStaticComponentsWarning(changedManifests: string[]): string {
  const head = changedManifests.slice(0, STALE_PATHS_LIMIT);
  const truncated = changedManifests.length - head.length;
  const list = head.join(', ') + (truncated > 0 ? `, … (+${truncated} more)` : '');
  return (
    `components.conf changed relative to the last full "fireforge build": ${list}.\n` +
    'The compiled StaticComponents table in obj-* no longer matches the tree, so the next ' +
    '"fireforge test" will require a full "fireforge build" first — a scoped ' +
    '"fireforge test --build" cannot regenerate the compiled table.'
  );
}

/**
 * Post-mutation advisory used by `fireforge reset` / `fireforge import`:
 * warns (never throws, never blocks) when `components.conf` now differs
 * from the last full-build anchor. Silently skipped when no baseline or
 * anchor exists, or when any probe fails.
 */
export async function warnIfStaticComponentsStale(
  projectRoot: string,
  engineDir: string
): Promise<void> {
  try {
    const baseline = await readBuildBaseline(projectRoot);
    if (baseline === undefined) return;
    const result = await checkStaticComponentsStale(engineDir, baseline);
    if (!result.stale) return;
    warn(formatPostMutationStaticComponentsWarning(result.changedManifests));
  } catch (error: unknown) {
    verbose(`Static-components post-mutation check skipped: ${toError(error).message}`);
  }
}
