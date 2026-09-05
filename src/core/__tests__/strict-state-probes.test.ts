// SPDX-License-Identifier: EUPL-1.2
/**
 * Authoritative-state existence probes must surface permission errors
 * instead of treating EACCES/EPERM as "missing". A manifest or .git
 * directory that cannot be probed is an error condition, not an empty
 * project. Silently returning false makes commands proceed as if no state
 * existed ("0 patches", "not a git repository").
 *
 * chmod-based EACCES cannot be produced on Windows or as root, so the whole
 * suite skips there. The Ubuntu/macOS CI runs cover it.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { isGitRepository } from '../git.js';
import { loadPatchesManifestState, mutatePatchRowsInManifest } from '../patch-manifest-io.js';

const cannotDropPermissions = process.platform === 'win32' || process.getuid?.() === 0;

describe.skipIf(cannotDropPermissions)('strict state probes surface permission errors', () => {
  let projectRoot: string;
  let restrictedDirs: string[];

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-strict-probe-');
    restrictedDirs = [];
  });

  afterEach(async () => {
    for (const dir of restrictedDirs) {
      await chmod(dir, 0o755);
    }
    await removeTempProject(projectRoot);
  });

  async function restrict(dir: string): Promise<void> {
    await chmod(dir, 0o000);
    restrictedDirs.push(dir);
  }

  it('loadPatchesManifestState rejects when the patches dir is unsearchable', async () => {
    const patchesDir = join(projectRoot, 'patches');
    await mkdir(patchesDir);
    await writeFile(join(patchesDir, 'patches.json'), '{"version":1,"patches":[]}');
    await restrict(patchesDir);

    await expect(loadPatchesManifestState(patchesDir)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('mutatePatchRowsInManifest rejects when the patches dir is unsearchable', async () => {
    const patchesDir = join(projectRoot, 'patches');
    await mkdir(patchesDir);
    await writeFile(join(patchesDir, 'patches.json'), '{"version":1,"patches":[]}');
    await restrict(patchesDir);

    await expect(
      mutatePatchRowsInManifest(patchesDir, ['001-infra-a.patch'], () => null)
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('isGitRepository rejects instead of reporting "not a repository"', async () => {
    const engineDir = join(projectRoot, 'engine');
    await mkdir(engineDir);
    await mkdir(join(engineDir, '.git'));
    await restrict(engineDir);

    await expect(isGitRepository(engineDir)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
