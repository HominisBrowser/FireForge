// SPDX-License-Identifier: EUPL-1.2
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';

/**
 * A checkout's project identity: its Git common directory, shared by every
 * worktree of a repository, or the plain root outside Git.
 */
export async function projectIdentity(root: string): Promise<string> {
  const dotGit = join(root, '.git');
  try {
    const text = await readFile(dotGit, 'utf8');
    const gitDirectory = resolve(root, text.replace(/^gitdir:\s*/, '').trim());
    try {
      const common = (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim();
      return await realpath(resolve(gitDirectory, common));
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      return await realpath(gitDirectory);
    }
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === 'EISDIR') return realpath(dotGit);
    if (code === 'ENOENT') return realpath(root).catch(() => resolve(root));
    throw error;
  }
}
