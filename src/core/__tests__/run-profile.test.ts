// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { InvalidArgumentError } from '../../errors/base.js';
import {
  removeActiveRunProfiles,
  resolveRunProfile,
  RUN_PROFILE_PREFIX,
  sweepAbandonedRunProfiles,
} from '../run-profile.js';

async function existsOnDisk(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A pid that belonged to a process which has certainly exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number.parseInt(child.stdout.toString(), 10);
}

describe('run profiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-run-profile-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('gives a plain run no profile arguments', async () => {
    const profile = await resolveRunProfile({ smoke: false, tempRoot: root });
    expect(profile.args).toEqual([]);
    expect(profile.temporary).toBe(false);
  });

  it('passes a named profile as an absolute -profile and never deletes it', async () => {
    const named = join(root, 'named');
    await mkdir(named);
    const profile = await resolveRunProfile({ profile: named, smoke: true, tempRoot: root });
    expect(profile.args).toEqual(['-profile', resolve(named)]);
    await profile.dispose();
    expect(await existsOnDisk(named)).toBe(true);
  });

  it('creates a seeded temporary profile for a smoke run and removes it on dispose', async () => {
    const profile = await resolveRunProfile({ smoke: true, tempRoot: root });
    const dir = profile.dir ?? '';
    expect(dir.startsWith(join(root, RUN_PROFILE_PREFIX))).toBe(true);
    expect(profile.args).toEqual(['-profile', dir]);
    expect(await readFile(join(dir, 'user.js'), 'utf8')).toContain(
      'browser.aboutConfig.showWarning'
    );
    await profile.dispose();
    expect(await existsOnDisk(dir)).toBe(false);
  });

  it('refuses --profile with --temp-profile', async () => {
    await expect(
      resolveRunProfile({ profile: '/p', tempProfile: true, smoke: false, tempRoot: root })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('lets the signal path remove a temporary profile the command never released', async () => {
    const profile = await resolveRunProfile({ tempProfile: true, smoke: false, tempRoot: root });
    await removeActiveRunProfiles();
    expect(await existsOnDisk(profile.dir ?? '')).toBe(false);
  });

  it('sweeps profiles whose owner died and keeps live and unmarked ones', async () => {
    const abandoned = join(root, `${RUN_PROFILE_PREFIX}dead`);
    const live = join(root, `${RUN_PROFILE_PREFIX}live`);
    const unmarked = join(root, `${RUN_PROFILE_PREFIX}unmarked`);
    const unrelated = join(root, 'someone-else');
    for (const dir of [abandoned, live, unmarked, unrelated]) await mkdir(dir);
    await writeFile(join(abandoned, '.fireforge-run-owner'), `${deadPid()}\n`);
    await writeFile(join(live, '.fireforge-run-owner'), `${process.ppid}\n`);
    await writeFile(join(unrelated, '.fireforge-run-owner'), `${deadPid()}\n`);

    expect(await sweepAbandonedRunProfiles(root)).toBe(1);

    expect(await existsOnDisk(abandoned)).toBe(false);
    expect(await existsOnDisk(live)).toBe(true);
    expect(await existsOnDisk(unmarked)).toBe(true);
    expect(await existsOnDisk(unrelated)).toBe(true);
  });

  it('treats an unreadable sweep root as nothing to do', async () => {
    expect(await sweepAbandonedRunProfiles(join(root, 'missing'))).toBe(0);
  });
});
