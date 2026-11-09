// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge furnace types`: writes the Furnace-generated typecheck files
 * (`typecheckJsconfig` paths and the `typecheckTagMap` declaration) from the
 * component workspace, or with `--check` fails when a committed copy differs.
 * In source mode an `engine/` path is written to its tracked copy under the
 * source root, so the editing checkout keeps them current without a slot.
 */
import { loadConfig } from '../../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import {
  findGeneratedTypesDrift,
  GENERATED_TYPES_REMEDY,
  reportJsconfigPathsSync,
  typecheckJsconfigList,
} from '../../core/furnace-jsconfig.js';
import { GeneralError } from '../../errors/base.js';
import { info, intro, outro, success, warn } from '../../utils/logger.js';

/** Options accepted by {@link furnaceTypesCommand}. */
export interface FurnaceTypesOptions {
  /** Compare only, failing when a file is out of date. */
  check?: boolean;
  /** Seconds to wait for the Furnace lock. */
  waitLockSeconds?: number;
}

/**
 * Runs `furnace types`.
 *
 * @param projectRoot - Root directory of the project
 * @param options - `--check` and the lock budget
 */
export async function furnaceTypesCommand(
  projectRoot: string,
  options: FurnaceTypesOptions = {}
): Promise<void> {
  intro('Furnace Types');
  if (!(await furnaceConfigExists(projectRoot))) {
    throw new GeneralError('No furnace.json found. Run "fireforge furnace init" first.');
  }
  const config = await loadFurnaceConfig(projectRoot);
  if (typecheckJsconfigList(config).length === 0 && config.typecheckTagMap === undefined) {
    info('furnace.json sets neither typecheckJsconfig nor typecheckTagMap; nothing to generate.');
    outro('Nothing to do');
    return;
  }
  const sourceRoot = (await loadConfig(projectRoot)).sources?.root;
  const drift = await findGeneratedTypesDrift(projectRoot, config, sourceRoot);
  if (drift.length === 0) {
    success('Generated typecheck files are up to date');
    outro(options.check === true ? 'Check passed' : 'Nothing to write');
    return;
  }
  if (options.check === true) {
    for (const entry of drift) warn(`${entry.file} [${entry.check}] ${entry.detail}`);
    outro('Generated typecheck files are out of date');
    throw new GeneralError(
      `${String(drift.length)} generated typecheck file(s) are out of date. ${GENERATED_TYPES_REMEDY}`
    );
  }
  await reportJsconfigPathsSync(projectRoot, config, false, options.waitLockSeconds, sourceRoot);
  outro('Generated typecheck files written');
}
