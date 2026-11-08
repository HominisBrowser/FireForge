// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { coordinatorNamespace } from '../jobs/guard.js';
import { readTemplate } from '../jobs/slot-template.js';
import { pristineRepositoryFor } from './git.js';

/**
 * The donor a command that reads no engine finds without being told: an explicit
 * path or `FIREFORGE_PRISTINE_REPOSITORY`, then the template this host keeps for the
 * project's pin, then the checkout's own `engine/`. A template holds exactly what
 * capture reads and never moves, and it is what is left once `engine/` is deleted.
 *
 * @param projectRoot - Project root
 * @param explicit - A `--pristine-repository` value
 */
export async function resolveStaticDonor(projectRoot: string, explicit?: string): Promise<string> {
  if (explicit !== undefined || process.env['FIREFORGE_PRISTINE_REPOSITORY'] !== undefined)
    return pristineRepositoryFor(projectRoot, explicit);
  let pin: string | undefined;
  try {
    const raw = await readFile(join(projectRoot, 'fireforge.json'), 'utf8');
    pin = (JSON.parse(raw) as { sources?: { pristineCommit?: string } }).sources?.pristineCommit;
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const template =
    pin === undefined
      ? undefined
      : await readTemplate(coordinatorNamespace(), pin).catch(() => undefined);
  return template?.repository ?? pristineRepositoryFor(projectRoot);
}
