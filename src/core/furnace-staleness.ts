// SPDX-License-Identifier: EUPL-1.2
/**
 * Furnace staleness advisory — shared between `fireforge run` and
 * `fireforge watch`. Both commands launch the built browser without
 * first running `furnace apply`, so this helper surfaces a warning when
 * component files have drifted from the last-applied checksums and the
 * user is about to run with stale engine state.
 *
 * The check is advisory only: errors (broken furnace config, partial
 * state, transient filesystem failure) must never block the caller.
 */

import { pathExists } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';
import { extractComponentChecksums, hasComponentChanged } from './furnace-apply-helpers.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';

/**
 * Emits a warning when any tracked override or custom component has
 * changed on disk since the last apply. Safe to call from any build-time
 * command that does not auto-apply — a failure inside the probe is
 * downgraded to a verbose log and the caller continues.
 */
export async function warnIfFurnaceStale(projectRoot: string): Promise<void> {
  try {
    if (!(await furnaceConfigExists(projectRoot))) return;

    const config = await loadFurnaceConfig(projectRoot);
    const state = await loadFurnaceState(projectRoot);
    const furnacePaths = getFurnacePaths(projectRoot);

    if (!state.appliedChecksums) return;

    const stale: string[] = [];
    for (const name of Object.keys(config.overrides)) {
      const dir = `${furnacePaths.overridesDir}/${name}`;
      if (!(await pathExists(dir))) continue;
      const prev = extractComponentChecksums(state.appliedChecksums, 'override', name);
      if (await hasComponentChanged(dir, prev)) stale.push(name);
    }
    for (const name of Object.keys(config.custom)) {
      const dir = `${furnacePaths.customDir}/${name}`;
      if (!(await pathExists(dir))) continue;
      const prev = extractComponentChecksums(state.appliedChecksums, 'custom', name);
      if (await hasComponentChanged(dir, prev)) stale.push(name);
    }

    if (stale.length > 0) {
      warn(
        `Furnace component${stale.length === 1 ? '' : 's'} modified since last apply: ${stale.join(', ')}. ` +
          'Run "fireforge furnace apply" (or "fireforge build" which auto-applies) to update the engine.'
      );
    }
  } catch {
    // Non-fatal: a broken furnace config should not block the caller.
    verbose('Furnace staleness check skipped due to an error.');
  }
}
