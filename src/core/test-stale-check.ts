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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { isPackageablePath } from './build-audit.js';
import { readBuildBaseline } from './build-baseline.js';
import type { BuildBaseline, TestPackagingCoverage } from './build-baseline-types.js';
import { collectChangedEnginePaths } from './engine-changes.js';

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
 * Reads a file under the engine directory and returns a hex-encoded
 * SHA-256 of its contents, matching the hash the baseline writer
 * produces. Returns `undefined` on any IO error (missing file,
 * permission denied, etc.) so the caller can treat the path as still
 * stale rather than crashing the preflight.
 */
async function hashEngineFile(engineDir: string, relPath: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(join(engineDir, relPath));
    return createHash('sha256').update(buffer).digest('hex');
  } catch (error: unknown) {
    verbose(
      `Stale-build preflight: could not hash ${relPath} for baseline comparison — ${toError(error).message}`
    );
    return undefined;
  }
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
 * covered entry or sits beneath a covered directory entry. Both sides are
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
    return !covered.some((c) => path === c || path.startsWith(`${c}/`));
  });
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
