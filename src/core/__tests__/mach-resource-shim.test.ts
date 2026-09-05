// SPDX-License-Identifier: EUPL-1.2
/**
 * The PYTHONPATH shim directory must be a private directory of the current
 * user: a fixed name under a shared `/tmp` would let any other local
 * account pre-create it and own the `sitecustomize.py` every mach dispatch
 * imports. These tests exercise the refusal paths against real temp paths.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BuildError } from '../../errors/build.js';
import { assertPrivateShimDir } from '../mach-resource-shim.js';

describe('assertPrivateShimDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-shim-dir-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a private directory owned by the current user', async () => {
    const dir = join(root, 'shim');
    await mkdir(dir, { mode: 0o700 });
    await expect(assertPrivateShimDir(dir)).resolves.toBeUndefined();
  });

  it('refuses a regular file at the shim path', async () => {
    const file = join(root, 'shim');
    await writeFile(file, 'not a directory');
    await expect(assertPrivateShimDir(file)).rejects.toThrow(BuildError);
    await expect(assertPrivateShimDir(file)).rejects.toThrow(/not a directory/);
  });

  it('refuses a missing path rather than treating it as safe', async () => {
    await expect(assertPrivateShimDir(join(root, 'absent'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink at the shim path even when it points at a private directory',
    async () => {
      const target = join(root, 'target');
      await mkdir(target, { mode: 0o700 });
      const link = join(root, 'shim');
      await symlink(target, link);
      await expect(assertPrivateShimDir(link)).rejects.toThrow(/not a directory \(symlink/);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a group- or world-writable directory',
    async () => {
      const dir = join(root, 'shim');
      await mkdir(dir);
      await chmod(dir, 0o777);
      await expect(assertPrivateShimDir(dir)).rejects.toThrow(/group\/world-writable/);
      await chmod(dir, 0o720);
      await expect(assertPrivateShimDir(dir)).rejects.toThrow(/group\/world-writable/);
    }
  );
});
