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
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test',
      vendor: 'Test',
      appId: 'test',
      binaryName: 'test',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    })
  ),
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

import { loadConfig } from '../../core/config.js';
import { appendHistory, confirmDestructive } from '../../core/destructive.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { loadPatchesManifest, renumberPatchesInManifest } from '../../core/patch-manifest.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { PatchesManifest } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { patchCompactCommand } from '../patch/compact.js';

const baseConfig: FireForgeConfig = {
  name: 'Test',
  vendor: 'Test',
  appId: 'test',
  binaryName: 'test',
  firefox: { version: '140.9.0esr', product: 'firefox-esr' },
};

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

function policyManifest(): PatchesManifest {
  return {
    version: 1,
    patches: [
      {
        filename: '001-branding-logo.patch',
        name: 'logo',
        description: 'Branding logo',
        category: 'branding',
        order: 1,
        filesAffected: ['browser/branding/test/logo.svg'],
        sourceEsrVersion: '140.0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        filename: '200-ui-shell.patch',
        name: 'shell',
        description: 'Shell UI',
        category: 'ui',
        order: 200,
        filesAffected: ['browser/base/content/shell.js'],
        sourceEsrVersion: '140.0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        filename: '900-infra-bootstrap-workaround.patch',
        name: 'bootstrap-workaround',
        description: 'Bootstrap workaround',
        category: 'infra',
        order: 900,
        filesAffected: ['tools/profiler/rust-api/build.rs'],
        sourceEsrVersion: '140.0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function policyConfig(mutationMode?: 'error' | 'warn' | 'force'): FireForgeConfig {
  return {
    ...baseConfig,
    patchPolicy: {
      ...(mutationMode ? { mutationMode } : {}),
      ranges: [
        { from: 1, to: 99, category: 'branding' },
        { from: 100, to: 199, category: 'infra' },
        { from: 200, to: 299, category: 'ui' },
      ],
      reservedRanges: [
        {
          from: 900,
          to: 999,
          allowed: [
            {
              filename: '900-infra-bootstrap-workaround.patch',
              files: ['tools/profiler/rust-api/build.rs'],
              adr: 'docs/architecture/adr/0001-bootstrap-workaround.md',
            },
          ],
        },
      ],
    },
  };
}

describe('patchCompactCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(confirmDestructive).mockResolvedValue('proceed');
    vi.mocked(loadPatchesManifest).mockResolvedValue(manifest([1, 3, 7]));
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);
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

  it('refuses a global compact plan that violates patchPolicy ranges', async () => {
    vi.mocked(loadConfig).mockResolvedValue(policyConfig());
    vi.mocked(loadPatchesManifest).mockResolvedValue(policyManifest());

    await expect(patchCompactCommand('/project', { yes: true })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );

    expect(confirmDestructive).not.toHaveBeenCalled();
    expect(withPatchDirectoryLock).not.toHaveBeenCalled();
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('still refuses policy violations with --force-unsafe when mutationMode is error', async () => {
    vi.mocked(loadConfig).mockResolvedValue(policyConfig('error'));
    vi.mocked(loadPatchesManifest).mockResolvedValue(policyManifest());

    await expect(
      patchCompactCommand('/project', { yes: true, forceUnsafe: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('allows --force-unsafe to bypass compact policy violations in force mode', async () => {
    vi.mocked(loadConfig).mockResolvedValue(policyConfig('force'));
    vi.mocked(loadPatchesManifest).mockResolvedValue(policyManifest());

    await patchCompactCommand('/project', { yes: true, forceUnsafe: true });

    expect(renumberPatchesInManifest).toHaveBeenCalled();
    expect(appendHistory).toHaveBeenCalledWith(
      '/project/patches',
      expect.objectContaining({
        operation: 'patch-compact',
        result: 'ok',
        unsafeOverride: true,
      })
    );
  });
});
