// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

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
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    })
  ),
  loadState: vi.fn(() => Promise.resolve({ baseCommit: 'batch-base-sha' })),
}));

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  createDefaultFurnaceConfig: vi.fn(() => ({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  })),
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
  loadFurnaceConfig: vi.fn(),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-scanner.js', () => ({
  getComponentDetails: vi.fn((_engineDir: string, name: string) => {
    if (name === 'moz-missing') return Promise.resolve(null);
    return Promise.resolve({
      tagName: name,
      sourcePath: `toolkit/content/widgets/${name}`,
      hasCSS: true,
      hasFTL: false,
      isRegistered: true,
    });
  }),
  scanWidgetsDirectory: vi.fn(),
}));

vi.mock('../../core/furnace-operation.js', async (importOriginal) => ({
  // `completeJournalRollback` is pure orchestration over the journal and
  // the pending-repair marker — the behaviour these suites assert — so it
  // comes from the real module.
  ...(await importOriginal<typeof import('../../core/furnace-operation.js')>()),
  runFurnaceMutation: vi.fn(
    async (
      _root: string,
      _kind: string,
      body: (ctx: {
        registerJournal: () => void;
        registerCleanup: () => void;
        markRolledBack: () => void;
      }) => Promise<unknown>
    ) =>
      body({
        registerJournal: () => undefined,
        registerCleanup: () => undefined,
        markRolledBack: () => undefined,
      })
  ),
  recordFurnaceRollbackFailure: vi.fn(),
}));

vi.mock('../../core/furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  recordCreatedDir: vi.fn(),
  restoreRollbackJournalOrThrow: vi.fn(),
  snapshotFile: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
  copyFile: vi.fn(),
  ensureDir: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() =>
    Promise.resolve([
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
    ])
  ),
}));

import { select } from '@clack/prompts';

import { writeFurnaceConfig } from '../../core/furnace-config.js';
import { copyFile, pathExists } from '../../utils/fs.js';
import { info, isCancel, note, outro, warn } from '../../utils/logger.js';
import { furnaceBatchOverrideCommand } from '../furnace/override.js';

describe('furnace batch override', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(false);
    // Reset the per-test furnace-config implementations to their module-
    // level defaults. One of the promotion tests below installs stateful
    // mocks (shared sharedState + writeFurnaceConfig implementation) that
    // would otherwise leak across tests since `clearAllMocks` does not
    // reset implementations.
    const {
      createDefaultFurnaceConfig,
      furnaceConfigExists,
      loadFurnaceConfig,
      writeFurnaceConfig,
    } = await import('../../core/furnace-config.js');
    vi.mocked(createDefaultFurnaceConfig).mockReturnValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    vi.mocked(loadFurnaceConfig).mockReset();
    vi.mocked(writeFurnaceConfig).mockResolvedValue(undefined);
  });

  it('rejects batch without --type', async () => {
    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button', 'moz-card'], {})
    ).rejects.toThrow('Override type is required for batch override');
  });

  it('rejects invalid tag names', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(
      furnaceBatchOverrideCommand('/project', ['InvalidName', 'moz-card'], { type: 'full' })
    ).rejects.toThrow('Invalid component name');
  });

  it('rejects when the engine directory is missing', async () => {
    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button'], { type: 'full' })
    ).rejects.toThrow('Engine directory not found');
  });

  it('rejects duplicate components in furnace.json', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    const { createDefaultFurnaceConfig } = await import('../../core/furnace-config.js');
    vi.mocked(createDefaultFurnaceConfig).mockReturnValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': { type: 'full', description: '', basePath: 'x', baseVersion: '1' },
      },
      custom: {},
    });

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button', 'moz-card'], { type: 'full' })
    ).rejects.toThrow('already exists');
  });

  it('promotes stock components out of the stock bucket instead of rejecting', async () => {
    // Rejecting any name already present in the stock bucket forces
    // operators to hand-edit furnace.json before overriding a
    // stock-discovered widget. The contract matches single-override:
    // splice the name out of `stock` and let the mutation phase persist the
    // promotion alongside the new override entries via
    // `writeFurnaceConfig`.
    //
    // Path-routing on pathExists: the engine tree and source component
    // directories are "present" so the copy phase proceeds, but the override
    // destination directories must be absent so the command does not refuse
    // with "directory already exists".
    vi.mocked(pathExists).mockImplementation((probedPath: string) => {
      if (probedPath.includes('components/overrides/')) return Promise.resolve(false);
      return Promise.resolve(true);
    });
    // `saveOverrideConfig` re-reads fresh furnace state inside the
    // operation lock to survive concurrent-writer races, so the test has to
    // persist each write for the next re-read to see it instead of resetting
    // to the empty default. `sharedState` replays the mutations between
    // loader calls the way the filesystem would.
    const { createDefaultFurnaceConfig, furnaceConfigExists, loadFurnaceConfig } =
      await import('../../core/furnace-config.js');
    let sharedState = {
      version: 1 as const,
      componentPrefix: 'moz-',
      stock: ['moz-button', 'moz-card'],
      overrides: {},
      custom: {},
    };
    vi.mocked(createDefaultFurnaceConfig).mockImplementation(
      () => JSON.parse(JSON.stringify(sharedState)) as typeof sharedState
    );
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockImplementation(() =>
      Promise.resolve(JSON.parse(JSON.stringify(sharedState)) as typeof sharedState)
    );
    vi.mocked(writeFurnaceConfig).mockImplementation((_root: string, nextConfig: unknown) => {
      sharedState = JSON.parse(JSON.stringify(nextConfig)) as typeof sharedState;
      return Promise.resolve();
    });

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button', 'moz-card'], { type: 'full' })
    ).resolves.toBeUndefined();

    // The last writeFurnaceConfig call records the final config state; both
    // names must have left the stock bucket AND appear under overrides.
    const writeCalls = vi.mocked(writeFurnaceConfig).mock.calls;
    const finalConfig = writeCalls.at(-1)?.[1];
    expect(finalConfig?.stock).toEqual([]);
    expect(finalConfig?.overrides['moz-button']).toBeDefined();
    expect(finalConfig?.overrides['moz-card']).toBeDefined();
  });

  it('rejects components that collide with custom entries', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    const { createDefaultFurnaceConfig } = await import('../../core/furnace-config.js');
    vi.mocked(createDefaultFurnaceConfig).mockReturnValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-button': {
          description: '',
          register: true,
          localized: false,
          targetPath: 'toolkit/content/widgets/moz-button',
        },
      },
    });

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button', 'moz-card'], { type: 'full' })
    ).rejects.toThrow(/already registered as a custom component/);
  });

  it('reports missing components as failures without blocking others', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    // moz-missing won't be found by getComponentDetails
    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-missing'], { type: 'full' })
    ).rejects.toThrow('All 1 override(s) failed');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moz-missing'));
  });

  it('deduplicates names', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    // Both names resolve to the same component — should only process once
    // but 'moz-missing' is returned as null by scanner
    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-missing', 'moz-missing'], { type: 'full' })
    ).rejects.toThrow('All 1 override(s) failed');
  });

  it('reports css-only overrides with no css as failures', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    const { getComponentDetails } = await import('../../core/furnace-scanner.js');
    vi.mocked(getComponentDetails).mockResolvedValueOnce({
      tagName: 'moz-button',
      sourcePath: 'toolkit/content/widgets/moz-button',
      hasCSS: false,
      hasFTL: false,
      isRegistered: true,
    });

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button'], { type: 'css-only' })
    ).rejects.toThrow('All 1 override(s) failed');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no CSS files to override with --type css-only')
    );
  });

  it('reports pre-existing override directories as failures', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path !== 'string') return Promise.resolve(false);
      if (path.includes('/project/engine')) return Promise.resolve(true);
      if (path.includes('/project/components/overrides/moz-button')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button'], { type: 'full' })
    ).rejects.toThrow('All 1 override(s) failed');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('directory already exists'));
  });

  it('succeeds cleanly without description or baseCommit when every override succeeds', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    const { loadState } = await import('../../core/config.js');
    vi.mocked(loadState).mockResolvedValueOnce({});

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button'], { type: 'full' })
    ).resolves.toBeUndefined();

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('components/overrides/moz-button/'),
      'Batch Override'
    );
    expect(warn).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith('Batch override complete: 1 succeeded, 0 failed');
  });

  it('reports partial success when one batch mutation throws mid-copy', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(copyFile).mockImplementation((...args: [string, string]) => {
      const dest = args[1];
      if (typeof dest === 'string' && dest.includes('/moz-fail/')) {
        return Promise.reject(new Error('copy exploded'));
      }
      return Promise.resolve();
    });

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button', 'moz-fail'], {
        type: 'full',
        description: 'Batch override',
      })
    ).resolves.toBeUndefined();

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('components/overrides/moz-button/'),
      'Batch Override'
    );
    // copyOverrideFiles wraps filesystem failures with the filename context
    // ("Failed to copy \"<file>\" into the override: <cause>") so operators
    // see which file tripped the error.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moz-fail'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('copy exploded'));
    expect(outro).toHaveBeenCalledWith('Batch override complete: 1 succeeded, 1 failed');
  });

  it('stringifies non-Error failures from override mutations', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(copyFile).mockRejectedValueOnce('copy exploded');

    await expect(
      furnaceBatchOverrideCommand('/project', ['moz-button'], { type: 'full' })
    ).rejects.toThrow('All 1 override(s) failed');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moz-button'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('copy exploded'));
  });

  it('prompts for override type interactively when --type is omitted in TTY mode', async () => {
    const origStdinTTY = process.stdin.isTTY;
    const origStdoutTTY = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    try {
      vi.mocked(pathExists).mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
        return Promise.resolve(false);
      });
      vi.mocked(select).mockResolvedValueOnce('full');

      await expect(
        furnaceBatchOverrideCommand('/project', ['moz-button'], {})
      ).resolves.toBeUndefined();

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('moz-button') as string })
      );
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('components/overrides/moz-button/'),
        'Batch Override'
      );
      expect(outro).toHaveBeenCalledWith('Batch override complete: 1 succeeded, 0 failed');
    } finally {
      process.stdin.isTTY = origStdinTTY;
      process.stdout.isTTY = origStdoutTTY;
    }
  });

  it('skips a component when the interactive type select is cancelled', async () => {
    const origStdinTTY = process.stdin.isTTY;
    const origStdoutTTY = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    try {
      vi.mocked(pathExists).mockImplementation((path: string) => {
        if (typeof path === 'string' && path.includes('engine')) return Promise.resolve(true);
        return Promise.resolve(false);
      });

      const cancelSymbol = Symbol('cancel');
      vi.mocked(select).mockResolvedValueOnce(cancelSymbol);
      (isCancel as unknown as MockInstance).mockImplementation(
        (val: unknown) => val === cancelSymbol
      );

      await expect(furnaceBatchOverrideCommand('/project', ['moz-button'], {})).rejects.toThrow(
        'All 1 override(s) failed'
      );

      expect(info).toHaveBeenCalledWith(expect.stringContaining('Skipping moz-button'));
    } finally {
      (isCancel as unknown as MockInstance).mockImplementation(() => false);
      process.stdin.isTTY = origStdinTTY;
      process.stdout.isTTY = origStdoutTTY;
    }
  });
});
