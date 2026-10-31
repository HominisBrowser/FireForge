// SPDX-License-Identifier: EUPL-1.2
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { cleanDevProfile } from '../dev-profile.js';

describe('cleanDevProfile', () => {
  let engineDir: string;

  beforeEach(async () => {
    engineDir = await createTempProject('ff-dev-profile-');
  });

  afterEach(async () => {
    await removeTempProject(engineDir);
  });

  async function seedProfile(objDir: string): Promise<string> {
    const profileDir = join(engineDir, objDir, 'tmp', 'profile-default');
    await mkdir(join(profileDir, 'startupCache'), { recursive: true });
    await writeFile(join(profileDir, 'startupCache', 'startupCache.8.little'), 'stale');
    await writeFile(join(profileDir, '.parentlock'), '');
    await writeFile(join(profileDir, 'prefs.js'), '');
    return profileDir;
  }

  it('removes every objdir startup cache and leftover parent lock before a launch', async () => {
    const debug = await seedProfile('obj-debug');
    const opt = await seedProfile('obj-opt');

    await expect(cleanDevProfile(engineDir, { removeParentLock: true })).resolves.toBe(2);

    for (const profileDir of [debug, opt]) {
      expect(await pathExists(join(profileDir, 'startupCache'))).toBe(false);
      expect(await pathExists(join(profileDir, '.parentlock'))).toBe(false);
      expect(await pathExists(join(profileDir, 'prefs.js'))).toBe(true);
    }
  });

  it('keeps the parent lock when only the startup cache goes', async () => {
    const profileDir = await seedProfile('obj-debug');

    await expect(cleanDevProfile(engineDir, { removeParentLock: false })).resolves.toBe(1);

    expect(await pathExists(join(profileDir, 'startupCache'))).toBe(false);
    expect(await pathExists(join(profileDir, '.parentlock'))).toBe(true);
  });

  it('counts nothing when no profile has a startup cache', async () => {
    await mkdir(join(engineDir, 'obj-debug', 'tmp', 'profile-default'), { recursive: true });
    await mkdir(join(engineDir, 'browser'), { recursive: true });

    await expect(cleanDevProfile(engineDir, { removeParentLock: true })).resolves.toBe(0);
  });

  it('treats an unreadable engine directory as nothing to clean', async () => {
    await expect(
      cleanDevProfile(join(engineDir, 'missing'), { removeParentLock: true })
    ).resolves.toBe(0);
  });
});
