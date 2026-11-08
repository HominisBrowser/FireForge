// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuthoredSnapshot } from '../../authored/types.js';
import {
  assertReleaseRecipe,
  clearReleaseObjdir,
  collectReleaseOutputs,
  composeReleaseMozconfig,
  readReleaseOverlay,
  releaseIdentity,
  releaseObjdir,
} from '../release-recipe.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fireforge-release-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OVERLAY = 'configs/release.mozconfig';
const snapshotWith = (
  release: unknown,
  inputs: Array<{ path: string; blob: string }> = [{ path: OVERLAY, blob: 'b' }]
): AuthoredSnapshot =>
  ({
    id: 'source',
    pin: { commit: 'pin' },
    repository: root,
    inputs,
    config: { build: { release } },
  }) as unknown as AuthoredSnapshot;

describe('a release recipe', () => {
  it('puts the overlay after the generated options and the object directory last', () => {
    expect(composeReleaseMozconfig('generated\n\n', 'overlay\n', '/slot/obj')).toBe(
      'generated\n\n# Release overlay\noverlay\n\nmk_add_options MOZ_OBJDIR="/slot/obj"\n'
    );
    expect(releaseObjdir('/slot')).toBe('/slot/.fireforge/release/obj');
  });

  it('refuses at submit until what it declares is there', async () => {
    await expect(assertReleaseRecipe(snapshotWith(undefined), {})).rejects.toThrow(
      /needs build\.release/
    );
    await expect(assertReleaseRecipe(snapshotWith({ overlay: 'other' }), {})).rejects.toThrow(
      /overlay other was not captured/
    );
    await expect(
      assertReleaseRecipe(snapshotWith({ overlay: OVERLAY }), {})
    ).resolves.toBeUndefined();
    const secret = { overlay: OVERLAY, secrets: { variable: 'KEYS', files: ['api.key'] } };
    await expect(assertReleaseRecipe(snapshotWith(secret), {})).rejects.toThrow(
      /--release-secrets/
    );
    await expect(
      assertReleaseRecipe(snapshotWith(secret), { releaseSecrets: root })
    ).rejects.toThrow(/Release secret api\.key is missing/);
    await writeFile(join(root, 'api.key'), 'secret\n');
    await expect(
      assertReleaseRecipe(snapshotWith(secret), { releaseSecrets: root })
    ).resolves.toBeUndefined();
  });

  it('builds from clean every time: no object of an earlier release survives', async () => {
    const object = join(releaseObjdir(root), 'dist', 'a.o');
    await mkdir(dirname(object), { recursive: true });
    await writeFile(object, 'object\n');
    await clearReleaseObjdir(root);
    await expect(lstat(releaseObjdir(root))).rejects.toThrow(/ENOENT/);
    await expect(clearReleaseObjdir(root)).resolves.toBeUndefined();
  });

  it('copies the declared outputs out at their relative paths, and refuses one that is missing', async () => {
    const objdir = releaseObjdir(root);
    const app = join(objdir, 'dist', 'Hominis.app', 'Contents', 'MacOS');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'hominis'), 'binary\n');
    await mkdir(join(objdir, 'dist', 'host', 'bin'), { recursive: true });
    await writeFile(join(objdir, 'dist', 'host', 'bin', 'mar'), 'mar\n');
    await writeFile(join(objdir, 'dist', 'hominis-1.0.en-US.mac.dmg'), 'dmg\n');
    await writeFile(join(objdir, 'dist', 'hominis-1.0.txt'), 'other\n');
    const output = join(root, 'output');
    const copied = await collectReleaseOutputs(
      objdir,
      ['dist/Hominis.app', 'dist/*.dmg', 'dist/host/bin/mar'],
      output
    );
    expect(copied).toEqual([
      'dist/Hominis.app',
      'dist/hominis-1.0.en-US.mac.dmg',
      'dist/host/bin/mar',
    ]);
    expect(
      await readFile(join(output, 'dist', 'Hominis.app', 'Contents', 'MacOS', 'hominis'), 'utf8')
    ).toBe('binary\n');
    expect(await readFile(join(output, 'dist', 'hominis-1.0.en-US.mac.dmg'), 'utf8')).toBe('dmg\n');
    await expect(lstat(join(output, 'dist', 'hominis-1.0.txt'))).rejects.toThrow(/ENOENT/);
    await expect(collectReleaseOutputs(objdir, ['dist/*.zip'], join(root, 'o2'))).rejects.toThrow(
      /Release output dist\/\*\.zip is not in the object directory/
    );
    await expect(collectReleaseOutputs(objdir, ['dist/gone'], join(root, 'o3'))).rejects.toThrow(
      /Release output dist\/gone/
    );
  });

  it('identifies a release by what decided it, and names no secret value', async () => {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const file = join(root, 'overlay');
    await writeFile(file, 'ac_add_options --enable-release\n');
    const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', file], {
      encoding: 'utf8',
    }).trim();
    const declared = { overlay: OVERLAY, secrets: { variable: 'KEYS', files: ['api.key'] } };
    const identity = await releaseIdentity({
      snapshot: snapshotWith(declared, [{ path: OVERLAY, blob }]),
      root,
      toolchain: 'tools',
      buildDate: '20260101000000',
    });
    expect(identity).toMatchObject({
      recipe: 'release',
      sourceId: 'source',
      pin: 'pin',
      toolchain: 'tools',
      objdir: releaseObjdir(root),
      buildDate: '20260101000000',
      secrets: ['api.key'],
    });
    expect(identity.overlay).toMatch(/^[a-f0-9]{64}$/);
    const bare = await releaseIdentity({
      snapshot: snapshotWith({ overlay: OVERLAY }, []),
      root,
      toolchain: 'tools',
      buildDate: 'd',
    });
    expect(bare).toMatchObject({ overlay: null, secrets: [] });
  });

  it('reads the overlay as it stands in the slot', async () => {
    await mkdir(join(root, 'configs'));
    await writeFile(join(root, OVERLAY), 'overlay\n');
    expect(await readReleaseOverlay(root, OVERLAY)).toBe('overlay\n');
  });
});
