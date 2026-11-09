// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keptProfile } from '../../../commands/job-run.js';
import { InvalidArgumentError } from '../../../errors/base.js';
import {
  assertKeptProfileOutside,
  assertKeptProfileShape,
  physicalPath,
  within,
} from '../kept-profile.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fireforge-kept-profile-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('a kept profile’s shape', () => {
  it('is an absolute, normalized path and nothing else', () => {
    assertKeptProfileShape('/home/a/profiles/dev');
    for (const bad of ['', 'rel/dev', '/a/../b', '/a/./b', '/a/', '/a\0b', 3, undefined])
      expect(() => {
        assertKeptProfileShape(bad);
      }).toThrow(/absolute, normalized/);
  });
});

describe('where a kept profile may live', () => {
  it('reads containment through links, so an alias cannot hide a slot', async () => {
    const slot = join(directory, 'slot');
    await mkdir(slot);
    await symlink(slot, join(directory, 'alias'));
    expect(await physicalPath(join(directory, 'alias', 'not', 'yet'))).toBe(
      join(await physicalPath(slot), 'not', 'yet')
    );
    await expect(
      assertKeptProfileOutside(join(directory, 'alias', 'profile'), { 'slot a': slot })
    ).rejects.toThrow(/inside slot a/);
    await expect(
      assertKeptProfileOutside(join(directory, 'elsewhere'), { 'slot a': slot })
    ).resolves.toBeUndefined();
    expect(within('/a/b', '/a/b')).toBe(true);
    expect(within('/a/b', '/a/bc')).toBe(false);
    expect(within('/a/b', '/a')).toBe(false);
  });
});

describe('job run --profile', () => {
  let project: string;
  let namespace: string;
  beforeEach(async () => {
    project = join(directory, 'project');
    namespace = join(directory, 'jobs');
    await mkdir(join(project, 'src'), { recursive: true });
    execFileSync('git', ['-C', project, 'init', '-q']);
    await writeFile(join(project, '.gitignore'), '.fireforge/\n');
  });

  const refusal = async (given: string): Promise<string> =>
    keptProfile(given, namespace, project).then(
      () => '',
      (error: unknown) => {
        expect(error).toBeInstanceOf(InvalidArgumentError);
        return (error as Error).message;
      }
    );

  it('creates a directory outside the checkout, or one its Git ignores', async () => {
    const outside = join(directory, 'profiles', 'dev');
    expect(await keptProfile(outside, namespace, project)).toBe(outside);
    expect(await readdir(outside)).toEqual([]);
    const ignored = join(project, '.fireforge', 'profiles', 'dev');
    expect(await keptProfile(ignored, namespace, project)).toBe(ignored);
  });

  it('refuses a relative, unnormal, tracked or namespaced one', async () => {
    expect(await refusal('profiles/dev')).toContain('absolute directory');
    expect(await refusal(`${directory}/a/../b`)).toContain('--profile must be an absolute');
    expect(await refusal(join(project, 'src', 'profile'))).toContain('tracked source');
    expect(await refusal(project)).toContain('tracked source');
    await expect(keptProfile(join(namespace, 'p'), namespace, project)).rejects.toThrow(
      /inside the coordinator namespace/
    );
  });
});
