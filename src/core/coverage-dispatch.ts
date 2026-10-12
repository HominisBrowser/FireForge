// SPDX-License-Identifier: EUPL-1.2
/**
 * Dispatch-time half of per-path coverage. A scoped build that followed a
 * full build carries the full build's anchor forward instead of collapsing
 * the claim to its own paths. A requested path outside the scoped list is
 * then still covered while its own staging inputs are unchanged against
 * that anchor, and a refusal names the inputs that did change.
 */

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import type { BuildBaseline } from './build-baseline-types.js';
import {
  collectStagingInputs,
  type EngineContentState,
  findChangedInputs,
  hashEngineFile,
  readEngineContentState,
} from './coverage-records.js';

/** A requested path no recorded claim covers, with the inputs that explain it. */
export interface UncoveredRequest {
  path: string;
  /** Staging inputs changed since the carried full build. Empty when unknown. */
  changed: string[];
}

/**
 * Re-checks the paths the scoped list does not cover against the carried
 * full-build anchor. Returns the paths that stay uncovered.
 *
 * @param engineDir - Path to the engine directory
 * @param baseline - Last successful build's baseline
 * @param uncovered - Request paths outside the scoped list
 * @param fullSuite - The sentinel standing for a path-less (full-suite) request
 */
export async function filterByCarriedFullCoverage(
  engineDir: string,
  baseline: BuildBaseline | undefined,
  uncovered: readonly string[],
  fullSuite: string
): Promise<UncoveredRequest[]> {
  const unresolved = uncovered.map((path) => ({ path, changed: [] as string[] }));
  const anchor = baseline?.fullCoverageAnchor;
  if (anchor === undefined || uncovered.length === 0) return unresolved;
  if ((await hashEngineFile(engineDir, 'mozconfig')) !== anchor.mozconfigHash) return unresolved;
  let state: EngineContentState;
  try {
    state = await readEngineContentState(engineDir);
  } catch (error: unknown) {
    verbose(`Coverage check: engine state unreadable — ${toError(error).message}`);
    return unresolved;
  }
  const remaining: UncoveredRequest[] = [];
  for (const path of uncovered) {
    const inputs = path === fullSuite ? undefined : await collectStagingInputs(engineDir, path);
    const changed = await findChangedInputs(state, anchor, inputs);
    if (changed === undefined || changed.length > 0)
      remaining.push({ path, changed: changed ?? [] });
  }
  return remaining;
}
