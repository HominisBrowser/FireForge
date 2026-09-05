// SPDX-License-Identifier: EUPL-1.2
import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  loadFurnaceConfig,
} from '../../core/furnace-config.js';
import type { FurnaceConfig } from '../../types/index.js';

/**
 * Loads `furnace.json` for an authoring command, defaulting to an empty
 * configuration when the project has none yet.
 *
 * `furnace create` and `furnace override` both need this: they are the two
 * commands that may run before any furnace configuration exists, and both must
 * treat "no file" as "nothing registered yet" rather than an error. They had a
 * byte-identical private copy each.
 * @param projectRoot - Project root to load from.
 * @returns The parsed configuration, or a fresh default.
 */
export async function loadAuthoringFurnaceConfig(projectRoot: string): Promise<FurnaceConfig> {
  if (await furnaceConfigExists(projectRoot)) {
    return loadFurnaceConfig(projectRoot);
  }

  return createDefaultFurnaceConfig();
}
