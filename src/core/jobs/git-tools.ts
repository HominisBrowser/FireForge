// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getNodeErrorCode } from '../../utils/errors.js';
import { hermeticGitEnvironment } from '../git-hermetic.js';
import { fileDigest, toolTreeDigest } from './tool-files.js';

/** A child's environment for Git on slot metadata: the hermetic configuration, no inherited repository selection. */
export function slotGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    ...hermeticGitEnvironment(),
    // These repositories are private to a slot lock holder, and a refreshed index is what keeps audits cheap.
    GIT_OPTIONAL_LOCKS: '1',
  };
}

/** Runs Git on slot metadata, repository selection left to the arguments. */
export async function slotGit(args: readonly string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('git', [...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: slotGitEnvironment(),
  });
  return stdout;
}

/** Hash the selected launcher before its read-only query, then bind the actual Git and helper assets. */
export async function gitToolIdentity(): Promise<{
  executable: string;
  execPath: string;
  digest: string;
}> {
  let launcher: string | undefined;
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    try {
      const candidate = join(directory, 'git');
      await access(candidate, constants.X_OK);
      launcher = await realpath(candidate);
      break;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) throw error;
    }
  }
  if (!launcher) throw new Error('Qualified Git executable is unavailable on PATH');
  const launcherHash = await fileDigest(launcher);
  const environment = slotGitEnvironment();
  const result = await promisify(execFile)(launcher, ['--exec-path'], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  const execPath = await realpath(result.stdout.trim());
  const executable = await realpath(join(execPath, 'git'));
  const helpers = await toolTreeDigest(execPath, {
    aliases: [dirname(launcher), dirname(executable)],
  });
  return {
    executable,
    execPath,
    digest: createHash('sha256')
      .update(JSON.stringify({ launcherHash, helpers, config: hermeticGitEnvironment() }))
      .digest('hex'),
  };
}
