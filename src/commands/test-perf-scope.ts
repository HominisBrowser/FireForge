// SPDX-License-Identifier: EUPL-1.2
/**
 * Scope of the evidence a `--perf-samples` run reports and invalidates on.
 *
 * - A stale-build refusal on a perf run says which stale packaged files are
 *   staging inputs of the sampled test and which lie elsewhere, so a sample
 *   whose fixture is unaffected can proceed knowingly under
 *   `--allow-stale-build`.
 * - An engine edit that lands while a sample runs makes the verdict
 *   `inconclusive` only when the edited path is something the running build
 *   packages (an install-manifest source, or a test file). An edit to a
 *   compiled source, a build file or anything else no manifest installs
 *   cannot reach the running binary, so the sample stands with a warning.
 */

import { isTestPath } from '../core/build-audit-resolve.js';
import { collectStagingInputs, isUnderPath } from '../core/coverage-records.js';
import { generationDeltaPaths } from '../core/engine-session-lock.js';
import {
  classifyRuntimeDelivery,
  installsFromDirectory,
} from '../core/objdir-install-manifests.js';
import { loadEngineInstallIndex } from '../core/test-stale-exempt.js';
import { warn } from '../utils/logger.js';

/** How many paths an impact line names per group. */
const IMPACT_LIST_LIMIT = 5;

function capList(paths: readonly string[]): string {
  const head = paths.slice(0, IMPACT_LIST_LIMIT).join(', ');
  const extra = paths.length - Math.min(paths.length, IMPACT_LIST_LIMIT);
  return extra > 0 ? `${head}, … (+${extra} more)` : head;
}

/**
 * The perf-impact line of a stale-build refusal.
 *
 * @param engineDir - Absolute engine directory
 * @param stalePaths - Stale packaged paths the refusal names
 * @param requested - Normalized request paths of the run
 */
export async function describePerfStaleImpact(
  engineDir: string,
  stalePaths: readonly string[],
  requested: readonly string[]
): Promise<string> {
  const inputs: string[] = [];
  for (const path of requested) inputs.push(...(await collectStagingInputs(engineDir, path)));
  const fixture = stalePaths.filter((path) => inputs.some((input) => isUnderPath(path, input)));
  const elsewhere = stalePaths.filter((path) => !fixture.includes(path));
  const fixturePart =
    fixture.length > 0
      ? `${fixture.length} stale file(s) are staging inputs of the sampled test (${capList(fixture)}), so the sample would measure the old content`
      : requested.length > 0
        ? "the sampled test's own staging inputs are unaffected"
        : 'no test paths were named, so every stale file may be measured';
  const elsewherePart =
    elsewhere.length > 0 && requested.length > 0
      ? `; ${elsewhere.length} stale packaged file(s) lie outside them (${capList(elsewhere)}) and affect the sample only if the measured path loads them`
      : '';
  return (
    `Perf sample impact: ${fixturePart}${elsewherePart}. Repackage first, or pass ` +
    '--allow-stale-build to take the sample knowingly.'
  );
}

/**
 * Tolerance for `assertEngineGenerationUnchanged` on a `--perf-samples` run:
 * true (with a warning naming the edits) when HEAD did not move and no
 * changed path is packaged by the running build.
 *
 * @param engineDir - Absolute engine directory
 */
export function perfGenerationTolerance(
  engineDir: string
): (before: string, after: string) => Promise<boolean> {
  return async (before, after) => {
    const delta = generationDeltaPaths(before, after);
    if (delta.headMoved || delta.paths.length === 0) return false;
    const index = await loadEngineInstallIndex(engineDir);
    if (index === undefined) return false;
    for (const path of delta.paths) {
      if (isTestPath(path)) return false;
      if (path.endsWith('/')) {
        if (installsFromDirectory(index, path)) return false;
      } else if ((await classifyRuntimeDelivery(index, engineDir, path)) !== 'unlisted') {
        return false;
      }
    }
    warn(
      `engine/ changed while this perf sample ran, but only in files the running build does not ` +
        `package (${capList(delta.paths)}); the sample stands. Rebuild before the next sample if ` +
        'they belong in it.'
    );
    return true;
  };
}

/**
 * Tolerance for `assertEngineGenerationUnchanged` on an ordinary run: true
 * (with a warning, and `drift-tolerated=<n>` on the verdict) when HEAD did
 * not move and every changed path is one the running browser cannot see.
 *
 * A peer deleting an unrelated chrome script used to make a whole run
 * inconclusive. What a running browser can see mid-run is narrower than
 * "anything under engine/": a file the objdir links to its source (`live`),
 * one the harness stages at dispatch (`at-dispatch`), and the run's own
 * test files and the staging inputs their manifests name. A compiled
 * source, or a file the build copied into the package, is already fixed in
 * the running binary or package; the next run's stale-build gate judges it.
 *
 * Perf runs keep {@link perfGenerationTolerance}: a sample is also void
 * when a packaged path changes.
 *
 * @param engineDir - Absolute engine directory
 * @param requested - Normalized request paths of the run
 * @param onTolerated - Receives the tolerated path count
 */
export function runGenerationTolerance(
  engineDir: string,
  requested: readonly string[],
  onTolerated: (count: number) => void
): (before: string, after: string) => Promise<boolean> {
  return async (before, after) => {
    const delta = generationDeltaPaths(before, after);
    if (delta.headMoved || delta.paths.length === 0) return false;
    const index = await loadEngineInstallIndex(engineDir);
    if (index === undefined) return false;
    const inputs: string[] = [...requested];
    for (const path of requested) inputs.push(...(await collectStagingInputs(engineDir, path)));
    for (const path of delta.paths) {
      const bare = path.endsWith('/') ? path.slice(0, -1) : path;
      if (inputs.some((input) => isUnderPath(bare, input) || isUnderPath(input, bare))) {
        return false;
      }
      // A path-less run requests every test, so any test file is its own.
      if (requested.length === 0 && isTestPath(path)) return false;
      if (path.endsWith('/')) {
        if (installsFromDirectory(index, path)) return false;
        continue;
      }
      const delivery = await classifyRuntimeDelivery(index, engineDir, path);
      if (delivery === 'live' || delivery === 'at-dispatch') return false;
    }
    warn(
      `engine/ changed while this run was in flight, but only in files the running browser ` +
        `cannot see (${capList(delta.paths)}); the verdict stands. The next run's stale-build ` +
        'gate judges whether they need a rebuild.'
    );
    onTolerated(delta.paths.length);
    return true;
  };
}
