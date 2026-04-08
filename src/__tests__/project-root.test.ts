// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProjectRoot } from '../cli.js';

describe('getProjectRoot', () => {
  const cwdSpy = vi.spyOn(process, 'cwd');
  const tempDirs: string[] = [];

  afterEach(async () => {
    cwdSpy.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns the nearest ancestor containing fireforge.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-root-'));
    tempDirs.push(root);
    const nested = join(root, 'engine', 'browser', 'modules');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'fireforge.json'), '{}\n', 'utf8');
    cwdSpy.mockReturnValue(nested);

    expect(getProjectRoot()).toBe(root);
  });

  it('falls back to cwd when no fireforge.json exists in any ancestor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fireforge-nonroot-'));
    tempDirs.push(cwd);
    cwdSpy.mockReturnValue(cwd);

    expect(getProjectRoot()).toBe(cwd);
  });
});
