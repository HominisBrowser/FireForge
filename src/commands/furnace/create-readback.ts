// SPDX-License-Identifier: EUPL-1.2
/**
 * Defensive read-back helper for `furnace create`. Extracted from
 * `create.ts` so the authoring command stays under the per-file LOC
 * budget.
 */

import { loadFurnaceConfig } from '../../core/furnace-config.js';
import { FurnaceError } from '../../errors/furnace.js';

/**
 * Asserts that the just-written furnace.json contains the expected custom
 * component entry.
 *
 * A `furnace create` that reports success and writes the component files
 * while the next `furnace status` finds `custom: {}` is an invariant
 * violation with no obvious smoking gun in the code path. This defensive
 * readback is the recovery contract: if the new entry is not visible on the
 * next load, throw a `FurnaceError` so the rollback journal restores the
 * pre-command state and the operator sees the failure instead of a phantom
 * success.
 *
 * @param projectRoot - Root of the FireForge project
 * @param componentName - Custom-element tag name that must be present in
 *   `config.custom` after the write. Throws when absent.
 */
export async function assertCustomEntryPersisted(
  projectRoot: string,
  componentName: string
): Promise<void> {
  const persisted = await loadFurnaceConfig(projectRoot);
  if (!(componentName in persisted.custom)) {
    throw new FurnaceError(
      `Wrote furnace.json but "${componentName}" is missing from config.custom on read-back. ` +
        'This should not happen — please report the issue. As a workaround, ' +
        're-run the command, or add the entry to furnace.json by hand.',
      componentName
    );
  }
}
