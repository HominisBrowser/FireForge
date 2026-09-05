// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

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

vi.mock('../../utils/logger.js', () => createLoggerMock());

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

function rangedPatch(
  filename: string,
  category: string,
  order: number,
  file: string
): PatchesManifest['patches'][number] {
  return {
    filename,
    name: filename.replace(/\.patch$/, ''),
    description: filename,
    category,
    order,
    filesAffected: [file],
    sourceEsrVersion: '140.0',
    createdAt: '2026-01-01T00:00:00.000Z',
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

  it('renumbers gaps from the lock-time manifest and writes history', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue(manifest([2, 4]));

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

  it('refuses when the queue changed between confirmation and the lock', async () => {
    // Confirmed plan: 3→2, 7→3. Under the lock a concurrent export has
    // landed patch 10, whose rename (10→4) the operator never saw.
    vi.mocked(loadPatchesManifest)
      .mockResolvedValueOnce(manifest([1, 3, 7]))
      .mockResolvedValueOnce(manifest([1, 3, 7, 10]));

    await expect(patchCompactCommand('/project', { yes: true })).rejects.toThrow(
      'Patch queue changed while waiting for confirmation'
    );
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
    expect(appendHistory).not.toHaveBeenCalled();
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

  it('treats a range-compliant queue as already compact under patchPolicy ranges', async () => {
    // Renumbering the whole queue from 1 projects the ui patch into the
    // branding range and refuses. Range-aware compaction recognises this
    // layout as gapless per range.
    vi.mocked(loadConfig).mockResolvedValue(policyConfig());
    vi.mocked(loadPatchesManifest).mockResolvedValue(policyManifest());

    await patchCompactCommand('/project', { yes: true });

    expect(info).toHaveBeenCalledWith('Patch queue is already compact. Nothing to do.');
    expect(confirmDestructive).not.toHaveBeenCalled();
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('compacts each category range independently and preserves inter-range numbering', async () => {
    vi.mocked(loadConfig).mockResolvedValue(policyConfig());
    const queue: PatchesManifest = {
      version: 1,
      patches: [
        rangedPatch('001-branding-logo.patch', 'branding', 1, 'browser/branding/test/logo.svg'),
        rangedPatch('003-branding-icons.patch', 'branding', 3, 'browser/branding/test/icon.svg'),
        rangedPatch('100-infra-build.patch', 'infra', 100, 'build/moz.build'),
        rangedPatch('105-infra-prefs.patch', 'infra', 105, 'modules/libpref/init/all.js'),
        rangedPatch('201-ui-shell.patch', 'ui', 201, 'browser/base/content/shell.js'),
        rangedPatch('204-ui-panel.patch', 'ui', 204, 'browser/base/content/panel.js'),
        rangedPatch('207-ui-menu.patch', 'ui', 207, 'browser/base/content/menu.js'),
      ],
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(queue);

    await patchCompactCommand('/project', { yes: true });

    const renameMap = vi.mocked(renumberPatchesInManifest).mock.calls[0]?.[1];
    expect(renameMap?.size).toBe(4);
    expect(renameMap?.get('003-branding-icons.patch')).toMatchObject({ newOrder: 2 });
    expect(renameMap?.get('105-infra-prefs.patch')).toMatchObject({ newOrder: 101 });
    expect(renameMap?.get('204-ui-panel.patch')).toMatchObject({ newOrder: 202 });
    expect(renameMap?.get('207-ui-menu.patch')).toMatchObject({ newOrder: 203 });
    // Anchors stay put — no patch crosses into another category's range.
    expect(renameMap?.has('001-branding-logo.patch')).toBe(false);
    expect(renameMap?.has('100-infra-build.patch')).toBe(false);
    expect(renameMap?.has('201-ui-shell.patch')).toBe(false);
  });

  it('closes mid-range gaps under allowGaps:false without policy refusal', async () => {
    // The field-reported scenario: deleting 244/245/246 left a ui-range
    // gap that no single reorder could close. enforcePatchPolicy runs for
    // real here, so a wrong projection would throw numeric-gap.
    const config: FireForgeConfig = {
      ...baseConfig,
      patchPolicy: {
        allowGaps: false,
        ranges: [
          { from: 1, to: 99, category: 'branding' },
          { from: 200, to: 299, category: 'ui' },
        ],
      },
    };
    vi.mocked(loadConfig).mockResolvedValue(config);
    const queue: PatchesManifest = {
      version: 1,
      patches: [
        rangedPatch('243-ui-a.patch', 'ui', 243, 'browser/a.js'),
        rangedPatch('247-ui-b.patch', 'ui', 247, 'browser/b.js'),
        rangedPatch('248-ui-c.patch', 'ui', 248, 'browser/c.js'),
      ],
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(queue);

    await patchCompactCommand('/project', { yes: true });

    const renameMap = vi.mocked(renumberPatchesInManifest).mock.calls[0]?.[1];
    expect(renameMap?.get('247-ui-b.patch')).toMatchObject({ newOrder: 244 });
    expect(renameMap?.get('248-ui-c.patch')).toMatchObject({ newOrder: 245 });
  });

  it('treats reserved orders as non-gaps when compacting a range', async () => {
    const config: FireForgeConfig = {
      ...baseConfig,
      patchPolicy: {
        ranges: [{ from: 100, to: 199, category: 'infra' }],
        reservedRanges: [{ from: 105, to: 106, allowed: [] }],
      },
    };
    vi.mocked(loadConfig).mockResolvedValue(config);
    const queue: PatchesManifest = {
      version: 1,
      patches: [
        rangedPatch('103-infra-a.patch', 'infra', 103, 'a.js'),
        rangedPatch('104-infra-b.patch', 'infra', 104, 'b.js'),
        rangedPatch('107-infra-c.patch', 'infra', 107, 'c.js'),
      ],
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(queue);

    await patchCompactCommand('/project', { yes: true });

    // 105/106 are reserved, so 103-104-(reserved)-107 is already gapless.
    expect(info).toHaveBeenCalledWith('Patch queue is already compact. Nothing to do.');
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('warns about out-of-range strays and leaves them in place', async () => {
    const config = policyConfig('warn');
    vi.mocked(loadConfig).mockResolvedValue(config);
    const queue: PatchesManifest = {
      version: 1,
      patches: [
        rangedPatch('001-branding-logo.patch', 'branding', 1, 'logo.svg'),
        rangedPatch('004-branding-icons.patch', 'branding', 4, 'icon.svg'),
        // ui patch parked in the branding range — already a policy
        // violation; compact must not move it silently.
        rangedPatch('050-ui-stray.patch', 'ui', 50, 'stray.js'),
      ],
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(queue);

    await patchCompactCommand('/project', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('050-ui-stray.patch (order 50, category ui) sits outside')
    );
    const renameMap = vi.mocked(renumberPatchesInManifest).mock.calls[0]?.[1];
    expect(renameMap?.has('050-ui-stray.patch')).toBe(false);
    expect(renameMap?.get('004-branding-icons.patch')).toMatchObject({ newOrder: 2 });
  });

  it('still refuses range-compact plans whose projection violates policy in error mode', async () => {
    // A stray in error mode keeps its pre-existing category-range error in
    // the projected manifest, so enforcePatchPolicy refuses even though
    // compact itself never moves the stray.
    vi.mocked(loadConfig).mockResolvedValue(policyConfig('error'));
    const queue: PatchesManifest = {
      version: 1,
      patches: [
        rangedPatch('001-branding-logo.patch', 'branding', 1, 'logo.svg'),
        rangedPatch('004-branding-icons.patch', 'branding', 4, 'icon.svg'),
        rangedPatch('050-ui-stray.patch', 'ui', 50, 'stray.js'),
      ],
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(queue);

    await expect(patchCompactCommand('/project', { yes: true })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    expect(renumberPatchesInManifest).not.toHaveBeenCalled();
  });

  it('allows --force-unsafe to bypass compact policy violations in force mode', async () => {
    vi.mocked(loadConfig).mockResolvedValue(policyConfig('force'));
    const queue: PatchesManifest = {
      version: 1,
      patches: [
        rangedPatch('001-branding-logo.patch', 'branding', 1, 'logo.svg'),
        rangedPatch('004-branding-icons.patch', 'branding', 4, 'icon.svg'),
        rangedPatch('050-ui-stray.patch', 'ui', 50, 'stray.js'),
      ],
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(queue);

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
