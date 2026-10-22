// SPDX-License-Identifier: EUPL-1.2
/**
 * What a pre-test build did with Furnace components. `prepareBuildEnvironment`
 * runs `furnace apply` over the whole `components/` tree, so a
 * `fireforge test --build` meant to capture the committed behaviour could
 * silently ship component edits nobody had deployed yet (another session's
 * included). The applied names therefore ride the verdict line, and `--no-furnace-apply` packages `engine/` as it
 * stands, naming the undeployed edits it left out.
 */

import type { BuildPreparation } from '../core/build-prepare.js';
import { listStaleFurnaceComponents } from '../core/furnace-staleness.js';
import { toError } from '../utils/errors.js';
import { notice, verbose } from '../utils/logger.js';
import { setVerdictRunAttribute } from './test-verdict.js';

/**
 * Reports the pre-test build's Furnace step: the components it deployed
 * (notice plus `furnace-applied=<names>` on the verdict line), or, when the
 * apply was skipped, the components whose undeployed edits this build
 * leaves out (`furnace-apply=skipped`).
 *
 * @param projectRoot - Root directory of the project
 * @param preparation - Result of `prepareBuildEnvironment`
 * @param skipped - True under `--no-furnace-apply` / `--furnace-apply none`
 * @param unreached - Components `--furnace-apply reached` left out
 */
export async function reportPreTestFurnace(
  projectRoot: string,
  preparation: BuildPreparation,
  skipped: boolean,
  unreached?: readonly string[]
): Promise<void> {
  if (skipped) {
    setVerdictRunAttribute('furnace-apply', 'skipped');
    let pending: string[] = [];
    try {
      pending = await listStaleFurnaceComponents(projectRoot);
    } catch (error: unknown) {
      verbose(`Furnace pending-edit probe failed: ${toError(error).message}`);
    }
    notice(
      pending.length > 0
        ? `Furnace apply skipped (--no-furnace-apply): engine/ is packaged as it stands. ${pending.length} component(s) with undeployed components/ edits are NOT in this build: ${pending.join(', ')}.`
        : 'Furnace apply skipped (--no-furnace-apply): engine/ is packaged as it stands.'
    );
    return;
  }
  if (unreached !== undefined && unreached.length > 0) {
    setVerdictRunAttribute('furnace-skipped', unreached.join(','));
    notice(
      `--furnace-apply reached: ${unreached.length} component(s) with undeployed components/ ` +
        `edits that no requested test reaches are NOT in this build: ${unreached.join(', ')}.`
    );
  }
  const applied = preparation.furnaceAppliedNames ?? [];
  if (applied.length === 0) return;
  setVerdictRunAttribute('furnace-applied', applied.join(','));
  notice(
    `This pre-test build deployed ${applied.length} Furnace component(s) whose components/ source ` +
      `changed since their last deploy: ${applied.join(', ')}. Those edits (another session's ` +
      'undeployed edits included) are in the runtime under test. Pass --no-furnace-apply to ' +
      'package engine/ as it stands, for example for a before-capture.'
  );
}
