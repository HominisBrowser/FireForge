// SPDX-License-Identifier: EUPL-1.2
/**
 * Stale-furnace export gate: the export/re-export refusal when a component
 * source changed since the last furnace apply.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(),
  getFurnacePaths: vi.fn(),
  loadFurnaceConfig: vi.fn(),
  loadFurnaceState: vi.fn(),
}));

vi.mock('../furnace-apply-helpers.js', () => ({
  extractComponentChecksums: vi.fn(() => ({})),
  hasComponentChanged: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { GeneralError } from '../../errors/base.js';
import { verbose, warn } from '../../utils/logger.js';
import { hasComponentChanged } from '../furnace-apply-helpers.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from '../furnace-config.js';
import {
  enforceFreshFurnaceSources,
  findStaleFurnaceComponentsForFiles,
} from '../furnace-stale-export.js';

const FURNACE_PATHS = {
  configPath: '/project/furnace.json',
  componentsDir: '/project/components',
  customDir: '/project/components/custom',
  overridesDir: '/project/components/overrides',
} as never;

function seedFurnace(ftlBasePath?: string): void {
  vi.mocked(furnaceConfigExists).mockResolvedValue(true);
  vi.mocked(getFurnacePaths).mockReturnValue(FURNACE_PATHS);
  vi.mocked(loadFurnaceConfig).mockResolvedValue({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    ...(ftlBasePath === undefined ? {} : { ftlBasePath }),
    overrides: {
      'moz-card': {
        type: 'full',
        description: '',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
    },
    custom: {
      'moz-tiles': {
        description: '',
        targetPath: 'toolkit/content/widgets/moz-tiles',
        register: true,
        localized: false,
      },
      'moz-hominis-dock': {
        description: '',
        targetPath: 'browser/components/dock',
        register: true,
        localized: true,
      },
      'moz-hominis-badge': {
        description: '',
        targetPath: 'browser/components/badge',
        register: true,
        localized: true,
        sharedFtl: 'browser/hominis-dock.ftl',
      },
    },
  } as never);
  vi.mocked(loadFurnaceState).mockResolvedValue({
    appliedChecksums: {
      'custom:moz-tiles': 'abc',
      'custom:moz-hominis-dock': 'ghi',
      'custom:moz-hominis-badge': 'jkl',
      'override:moz-card': 'def',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(furnaceConfigExists).mockResolvedValue(false);
});

describe('findStaleFurnaceComponentsForFiles', () => {
  it('reports a stale custom component for a file under its targetPath', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/content/widgets/moz-tiles/moz-tiles.mjs',
    ]);

    expect(stale).toEqual([
      { name: 'moz-tiles', type: 'custom', prefix: 'toolkit/content/widgets/moz-tiles/' },
    ]);
    // Only the intersecting component is probed.
    expect(hasComponentChanged).toHaveBeenCalledTimes(1);
    expect(hasComponentChanged).toHaveBeenCalledWith(
      '/project/components/custom/moz-tiles',
      expect.anything()
    );
  });

  it('returns empty for files outside any furnace-managed prefix', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'browser/base/content/browser-main.js',
    ]);

    expect(stale).toEqual([]);
    expect(hasComponentChanged).not.toHaveBeenCalled();
  });

  it('returns empty when the covered component is unchanged since apply (deploy-then-export)', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(false);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/content/widgets/moz-tiles/moz-tiles.mjs',
    ]);

    expect(stale).toEqual([]);
  });

  it('returns empty when furnace was never applied (no appliedChecksums)', async () => {
    seedFurnace();
    vi.mocked(loadFurnaceState).mockResolvedValue({});

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/content/widgets/moz-tiles/moz-tiles.mjs',
    ]);

    expect(stale).toEqual([]);
  });

  it('returns empty when no furnace config exists', async () => {
    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/content/widgets/moz-tiles/moz-tiles.mjs',
    ]);
    expect(stale).toEqual([]);
  });

  it('degrades a broken furnace config to a verbose skip, never a throw', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockRejectedValue(new Error('corrupt furnace.json'));

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/content/widgets/moz-tiles/moz-tiles.mjs',
    ]);

    expect(stale).toEqual([]);
    expect(verbose).toHaveBeenCalledWith(expect.stringContaining('corrupt furnace.json'));
  });

  it('reports a stale override for a file under its basePath', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/content/widgets/moz-card/moz-card.css',
    ]);

    expect(stale).toEqual([
      { name: 'moz-card', type: 'override', prefix: 'toolkit/content/widgets/moz-card/' },
    ]);
  });

  // ── Localized FTL attribution: a localized component's deployed
  //    `<ftlDir>/<name>.ftl` lives in the SHARED locale dir, outside its
  //    targetPath — the gate attributes it by exact file name. ──

  it('reports a stale localized component when only its deployed FTL file is exported', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/locales/en-US/toolkit/global/moz-hominis-dock.ftl',
    ]);

    expect(stale).toEqual([
      { name: 'moz-hominis-dock', type: 'custom', prefix: 'browser/components/dock/' },
    ]);
    expect(hasComponentChanged).toHaveBeenCalledWith(
      '/project/components/custom/moz-hominis-dock',
      expect.anything()
    );
  });

  it('does not attribute unrelated files in the shared FTL dir (exact file, not prefix)', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/locales/en-US/toolkit/global/other.ftl',
    ]);

    expect(stale).toEqual([]);
    expect(hasComponentChanged).not.toHaveBeenCalled();
  });

  it('gives sharedFtl components no FTL candidate — their bundle is not furnace-deployed', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/locales/en-US/toolkit/global/moz-hominis-badge.ftl',
    ]);

    expect(stale).toEqual([]);
    expect(hasComponentChanged).not.toHaveBeenCalled();
  });

  it('respects a configured ftlBasePath when attributing the deployed FTL file', async () => {
    seedFurnace('browser/locales/en-US/browser/hominis');
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    const stale = await findStaleFurnaceComponentsForFiles('/project', [
      'browser/locales/en-US/browser/hominis/moz-hominis-dock.ftl',
    ]);

    expect(stale).toEqual([
      { name: 'moz-hominis-dock', type: 'custom', prefix: 'browser/components/dock/' },
    ]);

    // The default-dir path no longer matches under a configured base.
    vi.mocked(hasComponentChanged).mockClear();
    const noMatch = await findStaleFurnaceComponentsForFiles('/project', [
      'toolkit/locales/en-US/toolkit/global/moz-hominis-dock.ftl',
    ]);
    expect(noMatch).toEqual([]);
    expect(hasComponentChanged).not.toHaveBeenCalled();
  });
});

describe('enforceFreshFurnaceSources', () => {
  it('refuses with a message naming the component and the deploy remediation', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    await expect(
      enforceFreshFurnaceSources(
        '/project',
        ['toolkit/content/widgets/moz-tiles/moz-tiles.mjs'],
        false,
        're-export'
      )
    ).rejects.toThrow(GeneralError);

    await expect(
      enforceFreshFurnaceSources(
        '/project',
        ['toolkit/content/widgets/moz-tiles/moz-tiles.mjs'],
        false,
        're-export'
      )
    ).rejects.toThrow(/moz-tiles.*furnace deploy.*--allow-stale-furnace/s);
  });

  it('downgrades to a warning with --allow-stale-furnace', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(true);

    await expect(
      enforceFreshFurnaceSources(
        '/project',
        ['toolkit/content/widgets/moz-tiles/moz-tiles.mjs'],
        true,
        'export'
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moz-tiles'));
  });

  it('is silent when nothing is stale', async () => {
    seedFurnace();
    vi.mocked(hasComponentChanged).mockResolvedValue(false);

    await expect(
      enforceFreshFurnaceSources(
        '/project',
        ['toolkit/content/widgets/moz-tiles/moz-tiles.mjs'],
        false,
        'export'
      )
    ).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
  });
});
