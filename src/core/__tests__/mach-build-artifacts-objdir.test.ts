// SPDX-License-Identifier: EUPL-1.2
/**
 * The `obj-*` glob against a real filesystem: a second objdir makes it
 * ambiguous, and an active mozconfig that NAMES one settles it. Real dirs
 * rather than mocks, because the whole behaviour is a directory scan.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AmbiguousBuildArtifactsError } from '../../errors/build.js';
import { assertBuildArtifacts, hasBuildArtifacts } from '../mach-build-artifacts.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeEngine(objDirs: string[], mozconfig?: string): Promise<string> {
  const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-objdir-'));
  cleanupPaths.push(engineDir);
  for (const objDir of objDirs) {
    await mkdir(join(engineDir, objDir, 'dist'), { recursive: true });
  }
  if (mozconfig !== undefined) {
    await writeFile(join(engineDir, 'mozconfig'), mozconfig, 'utf-8');
  }
  return engineDir;
}

describe('objdir resolution', () => {
  it('selects the only candidate without consulting the mozconfig', async () => {
    const engineDir = await makeEngine(['obj-dev']);
    await expect(hasBuildArtifacts(engineDir)).resolves.toMatchObject({
      exists: true,
      objDir: 'obj-dev',
    });
  });

  it('prefers the objdir the mozconfig declares when the glob is ambiguous', async () => {
    // The mozconfig is what actually steers configure; refusing when it has
    // already answered the question sends the operator to rename a
    // directory to satisfy a scan.
    const engineDir = await makeEngine(
      ['obj-dev', 'obj-hominis-release'],
      'mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-hominis-release\n'
    );

    const check = await hasBuildArtifacts(engineDir);

    expect(check).toMatchObject({ exists: true, objDir: 'obj-hominis-release' });
    expect(check.ambiguous).toBeUndefined();
  });

  it('keeps refusing when no mozconfig declares an objdir', async () => {
    const engineDir = await makeEngine(['obj-dev', 'obj-release']);
    const check = await hasBuildArtifacts(engineDir);

    expect(check.ambiguous).toBe(true);
    expect(check.declaredObjDir).toBeUndefined();
    expect(() => {
      assertBuildArtifacts(engineDir, check, {
        requireExisting: true,
        requirement: 'x',
        remediation: 'y',
        label: 'test',
      });
    }).toThrow(AmbiguousBuildArtifactsError);
  });

  it('refuses, and says so, when the declaration names something the scan cannot see', async () => {
    const engineDir = await makeEngine(
      ['obj-dev', 'obj-release'],
      'mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-somewhere-else\n'
    );

    const check = await hasBuildArtifacts(engineDir);

    expect(check.ambiguous).toBe(true);
    expect(check.declaredObjDir).toBe('obj-somewhere-else');
    try {
      assertBuildArtifacts(engineDir, check, {
        requireExisting: true,
        requirement: 'x',
        remediation: 'y',
        label: 'test',
      });
      expect.unreachable('should have refused');
    } catch (error: unknown) {
      expect((error as AmbiguousBuildArtifactsError).userMessage).toContain(
        'MOZ_OBJDIR=obj-somewhere-else'
      );
    }
  });
});
