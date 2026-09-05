// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-base.js', () => ({
  ensureGit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../git-file-ops.js', () => ({
  getFileContentAtRef: vi.fn((_repo: string, _path: string, ref: string) =>
    Promise.resolve(ref === 'HEAD' ? 'theirs\n' : 'base\n')
  ),
}));

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(() =>
    Promise.resolve({
      stdout: '',
      stderr: 'fatal: refusing to merge unrelated binary input\n',
      exitCode: 255,
    })
  ),
}));

import { FurnaceError } from '../../errors/furnace.js';
import { refreshOverrideFile } from '../furnace-refresh.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('refreshOverrideFile fatal merge-file handling', () => {
  it('throws instead of reporting shell-exposed fatal exits as conflicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fireforge-refresh-fatal-'));
    cleanupPaths.push(dir);
    const overridePath = join(dir, 'widget.css');
    await writeFile(overridePath, 'ours\n');

    await expect(
      refreshOverrideFile({
        engineDir: '/engine',
        overridePath,
        engineRelPath: 'widget.css',
        baseCommit: 'base-sha',
        fileName: 'widget.css',
      })
    ).rejects.toThrow(FurnaceError);
    await expect(
      refreshOverrideFile({
        engineDir: '/engine',
        overridePath,
        engineRelPath: 'widget.css',
        baseCommit: 'base-sha',
        fileName: 'widget.css',
      })
    ).rejects.toThrow(/git merge-file failed/);
  });
});
