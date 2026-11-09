// SPDX-License-Identifier: EUPL-1.2
/**
 * Furnace staleness advisory, shared between `fireforge run` and
 * `fireforge watch`. Both commands launch the built browser without
 * first running `furnace apply`, so this helper surfaces a warning when
 * component files have drifted from the last-applied checksums and the
 * user is about to run with stale engine state.
 *
 * The check is advisory only: errors (broken furnace config, partial
 * state, transient filesystem failure) must never block the caller.
 */

import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';
import { getProjectPaths } from './config.js';
import {
  extractComponentChecksums,
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
} from './furnace-apply-helpers.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from './furnace-config.js';
import { resolveFtlDir } from './furnace-constants.js';

/** Why a component's engine copy does not hold its current source. */
export type FurnaceStaleReason = 'source-edited' | 'never-deployed' | 'engine-differs';

/** One component whose engine copy is behind its source, with the reason. */
export interface StaleFurnaceEntry {
  name: string;
  reason: FurnaceStaleReason;
}

/** Operator wording for each {@link FurnaceStaleReason}. */
export const FURNACE_STALE_REASON_TEXT: Record<FurnaceStaleReason, string> = {
  'source-edited': 'components/ source changed since its last recorded deploy',
  'never-deployed': 'no recorded deploy',
  'engine-differs': 'engine copy is missing or differs from the source',
};

/**
 * The tracked override and custom components whose engine copy does not hold
 * their current `components/` source, each with the reason: the source changed
 * since the last recorded apply, the component was never applied, or the
 * engine files were erased or edited behind the record (reset, download, a
 * manual edit). The drift test is the one `furnace apply` uses to decide a
 * component is already current, so this list is exactly what an apply would
 * deploy. Throws on a broken config or state; {@link warnIfFurnaceStale}
 * downgrades that.
 */
export async function describeStaleFurnaceComponents(
  projectRoot: string
): Promise<StaleFurnaceEntry[]> {
  if (!(await furnaceConfigExists(projectRoot))) return [];

  const config = await loadFurnaceConfig(projectRoot);
  const state = await loadFurnaceState(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const { engine: engineDir } = getProjectPaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  const stale: StaleFurnaceEntry[] = [];
  const classify = async (
    name: string,
    componentDir: string,
    previous: Record<string, string>,
    drifted: () => Promise<boolean>
  ): Promise<void> => {
    if (!(await pathExists(componentDir))) return;
    if (await hasComponentChanged(componentDir, previous)) {
      stale.push({
        name,
        reason: Object.keys(previous).length === 0 ? 'never-deployed' : 'source-edited',
      });
    } else if (await probeDrift(drifted)) {
      stale.push({ name, reason: 'engine-differs' });
    }
  };
  for (const [name, override] of Object.entries(config.overrides)) {
    const componentDir = `${furnacePaths.overridesDir}/${name}`;
    await classify(
      name,
      componentDir,
      extractComponentChecksums(state.appliedChecksums, 'override', name),
      () =>
        hasOverrideEngineDrift(
          { engineDir, componentDir, ftlDir },
          override,
          extractComponentChecksums(state.engineChecksums, 'override', name)
        )
    );
  }
  for (const [name, custom] of Object.entries(config.custom)) {
    const componentDir = `${furnacePaths.customDir}/${name}`;
    await classify(
      name,
      componentDir,
      extractComponentChecksums(state.appliedChecksums, 'custom', name),
      () => hasCustomEngineDrift({ root: projectRoot, name, componentDir, ftlDir }, custom)
    );
  }
  return stale;
}

/** Names of {@link describeStaleFurnaceComponents}, in config order. */
export async function listStaleFurnaceComponents(projectRoot: string): Promise<string[]> {
  return (await describeStaleFurnaceComponents(projectRoot)).map((entry) => entry.name);
}

/** An engine that cannot be probed is not reported as drifted: the probe is advisory and a deploy would fail on the same engine anyway. */
async function probeDrift(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch (error: unknown) {
    verbose(`Furnace engine drift probe failed: ${toError(error).message}`);
    return false;
  }
}

/**
 * Emits a warning when any tracked override or custom component is not
 * deployed as it stands (see {@link listStaleFurnaceComponents}). Safe to call from any build-time
 * command that does not auto-apply. A failure inside the probe is
 * downgraded to a verbose log and the caller continues.
 */
export async function warnIfFurnaceStale(projectRoot: string): Promise<void> {
  try {
    const stale = await listStaleFurnaceComponents(projectRoot);
    if (stale.length > 0) {
      warn(
        `Furnace component${stale.length === 1 ? '' : 's'} not up to date in engine/ (edited, never deployed, or erased since the last apply): ${stale.join(', ')}. ` +
          'Run "fireforge furnace apply" (or "fireforge build" which auto-applies) to update the engine.'
      );
    }
  } catch {
    // Non-fatal: a broken furnace config should not block the caller.
    verbose('Furnace staleness check skipped due to an error.');
  }
}
