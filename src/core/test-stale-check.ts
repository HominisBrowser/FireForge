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
import { verbose } from '../utils/logger.js';
import { isPackageablePath } from './build-audit.js';
import type { BuildBaseline } from './build-baseline.js';
import { readBuildBaseline } from './build-baseline.js';
import { hasChanges, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

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
 * Collects engine paths that changed since the baseline SHA plus any
 * workdir modifications. Mirrors the helper inside `build-prepare.ts` but
 * is kept separate so the test-side preflight does not need to pull in
 * the full build-prepare dependency graph (mozconfig generation, furnace
 * apply hooks, …).
 */
async function collectChangedEnginePaths(
  engineDir: string,
  baseline: BuildBaseline
): Promise<string[]> {
  const collected = new Set<string>();

  if (baseline.engineHeadSha) {
    try {
      const diff = await git(['diff', '--name-only', `${baseline.engineHeadSha}..HEAD`], engineDir);
      for (const line of diff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
    } catch (error: unknown) {
      if (!isMissingHeadError(error)) {
        verbose(
          `Stale-build preflight: could not diff engine against baseline — ${toError(error).message}`
        );
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
      for (const untracked of await getUntrackedFiles(engineDir)) {
        collected.add(untracked);
      }
    }
  } catch (error: unknown) {
    verbose(
      `Stale-build preflight: could not enumerate workdir changes — ${toError(error).message}`
    );
  }

  return [...collected];
}

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

  const changed = await collectChangedEnginePaths(engineDir, baseline);
  const packageable = changed.filter((path) => isPackageablePath(path)).sort();
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
