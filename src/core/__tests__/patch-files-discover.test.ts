// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPatches } from '../patch-files.js';

describe('discoverPatches', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-discover-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists a symlinked patch file in apply order', async () => {
    const real = join(root, 'real');
    const queue = join(root, 'queue');
    await mkdir(real);
    await mkdir(queue);
    await writeFile(join(real, '002-ui-b.patch'), 'diff\n');
    await writeFile(join(queue, '001-ui-a.patch'), 'diff\n');
    await symlink(join(real, '002-ui-b.patch'), join(queue, '002-ui-b.patch'));

    const patches = await discoverPatches(queue);

    expect(patches.map((patch) => patch.filename)).toEqual(['001-ui-a.patch', '002-ui-b.patch']);
  });

  it('skips a symlink to a directory and a dangling symlink', async () => {
    const queue = join(root, 'queue');
    await mkdir(queue);
    await mkdir(join(root, 'dir.patch'));
    await symlink(join(root, 'dir.patch'), join(queue, '003-ui-dir.patch'));
    await symlink(join(root, 'missing.patch'), join(queue, '004-ui-gone.patch'));

    await expect(discoverPatches(queue)).resolves.toEqual([]);
  });
});
