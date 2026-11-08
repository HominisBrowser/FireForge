// SPDX-License-Identifier: EUPL-1.2
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { dependencyGraphIdentity } from './dependency-identity.js';

/**
 * Project scripts run the FireForge the project installed. What a job needs from
 * it is that it honors a job's guards, whichever version it is, and its bytes are
 * bound so they cannot change partway.
 */
export async function assertProjectToolCompatibility(root: string): Promise<string> {
  const packageRoot = join(root, 'node_modules', '@hominis', 'fireforge');
  try {
    await readFile(join(packageRoot, 'package.json'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return 'no-project-fireforge';
    throw error;
  }
  const guard = join(packageRoot, 'dist', 'src', 'core', 'jobs', 'guard.js');
  try {
    await access(guard);
  } catch (error) {
    throw new Error(
      'Project FireForge lacks coordinated source/slot guards; legacy child executables are refused',
      { cause: error }
    );
  }
  return dependencyGraphIdentity(packageRoot, { includeRootFiles: true });
}
