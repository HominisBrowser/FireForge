// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../../core/destructive.js', () => ({
  appendHistory: vi.fn(() => Promise.resolve()),
  confirmDestructive: vi.fn(() => Promise.resolve('proceed')),
}));

vi.mock('../../core/patch-lock.js', () => ({
  withPatchDirectoryLock: vi.fn((_patchesDir: string, body: () => Promise<unknown>) => body()),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(),
  renumberPatchesInManifest: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  warn: vi.fn(),
}));

import { appendHistory, confirmDestructive } from '../../core/destructive.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { loadPatchesManifest, renumberPatchesInManifest } from '../../core/patch-manifest.js';
import type { PatchesManifest } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { patchCompactCommand } from '../patch/compact.js';

function manifest(orders: number[]): PatchesManifest {
  return {
    version: 1 as const,
    patches: orders.map((order) => ({
      filename: `${String(order).padStart(4, '0')}-patch-${order}.patch`,
      name: `patch ${order}`,
      description: `Patch ${order}`,
      category: 'infra' as const,
      order,
      filesAffected: [`file-${order}.js`],
      sourceEsrVersion: '140.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  };
}

describe('patchCompactCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(confirmDestructive).mockResolvedValue('proceed');
    vi.mocked(loadPatchesManifest).mockResolvedValue(manifest([1, 3, 7]));
  });

  it('prints a no-op result when the patch queue is already compact', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue(manifest([1, 2, 3]));

    await patchCompactCommand('/project', { yes: true });

    expect(info).toHaveBeenCalledWith('Patch queue is already compact. Nothing to do.');
    expect(confirmDestructive).not.toHaveBeenCalled();
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('shows planned renames without taking the lock in dry-run mode', async () => {
    vi.mocked(confirmDestructive).mockResolvedValue('dry-run');

    await patchCompactCommand('/project', { dryRun: true });

    const confirmArgs = vi.mocked(confirmDestructive).mock.calls[0]?.[0];
    expect(confirmArgs?.dryRun).toBe(true);
    expect(confirmArgs?.summary).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0003-patch-3.patch'),
        expect.stringContaining('0007-patch-7.patch'),
      ])
    );
    expect(withPatchDirectoryLock).not.toHaveBeenCalled();
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('renumbers gaps in lock-time manifest order and writes history', async () => {
    vi.mocked(loadPatchesManifest)
      .mockResolvedValueOnce(manifest([1, 3, 7]))
      .mockResolvedValueOnce(manifest([2, 4]));

    await patchCompactCommand('/project', { yes: true });

    const renameMap = vi.mocked(renumberPatchesInManifest).mock.calls[0]?.[1];
    expect(renameMap?.get('0002-patch-2.patch')).toMatchObject({
      newOrder: 1,
      newFilename: '0001-patch-2.patch',
    });
    expect(renameMap?.get('0004-patch-4.patch')).toMatchObject({
      newOrder: 2,
      newFilename: '0002-patch-4.patch',
    });
    expect(appendHistory).toHaveBeenCalledWith(
      '/project/patches',
      expect.objectContaining({
        operation: 'patch-compact',
        result: 'ok',
        yes: true,
      })
    );
  });

  it('skips renumbering when another process compacts before the lock', async () => {
    vi.mocked(loadPatchesManifest)
      .mockResolvedValueOnce(manifest([1, 3]))
      .mockResolvedValueOnce(manifest([1, 2]));

    await patchCompactCommand('/project', { yes: true });

    expect(info).toHaveBeenCalledWith(
      'Patch queue was compacted by another process. Nothing to do.'
    );
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('warns but keeps the committed compact when history append fails', async () => {
    vi.mocked(appendHistory).mockRejectedValueOnce(new Error('history is locked'));

    await patchCompactCommand('/project', { yes: true });

    expect(renumberPatchesInManifest).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('History log append failed after patch compact committed')
    );
  });
});
