// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nativePath } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: nativePath('/project/engine'),
    config: nativePath('/project/fireforge.json'),
    fireforgeDir: nativePath('/project/.fireforge'),
    state: nativePath('/project/.fireforge/state.json'),
    patches: nativePath('/project/patches'),
    configs: nativePath('/project/configs'),
    src: nativePath('/project/src'),
    componentsDir: nativePath('/project/components'),
  })),
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '140.9.0', product: 'firefox' },
    })
  ),
  loadState: vi.fn(() =>
    Promise.resolve({
      baseCommit: 'abc123def456',
    })
  ),
}));

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: nativePath('/project/furnace.json'),
    componentsDir: nativePath('/project/components'),
    overridesDir: nativePath('/project/components/overrides'),
    customDir: nativePath('/project/components/custom'),
    furnaceState: nativePath('/project/.fireforge/furnace-state.json'),
  })),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
        },
      },
      custom: {},
    })
  ),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-apply-helpers.js', () => ({
  getOverrideEngineTargetPath: vi.fn(
    (_engineDir: string, config: { basePath: string }, fileName: string) => {
      if (fileName.endsWith('.ftl')) return `/project/engine/browser/locales/${fileName}`;
      return `/project/engine/${config.basePath}/${fileName}`;
    }
  ),
}));

vi.mock('../../core/furnace-refresh.js', () => ({
  refreshOverrideFile: vi.fn(),
}));

vi.mock('../../core/furnace-operation.js', async (importOriginal) => ({
  // `completeJournalRollback` is pure orchestration over the journal and
  // the pending-repair marker (the behaviour these suites assert), so it
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
  recordCreatedDir: vi.fn(),
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(),
  snapshotDir: vi.fn(),
  snapshotFile: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  // Engine-precondition ladder (assertEngineGitReady). Stubbed to the
  // healthy-engine answers so these suites test their own subject.
  isGitRepository: vi.fn(() => Promise.resolve(true)),
  isMissingHeadError: vi.fn(() => false),

  getHead: vi.fn(() => Promise.resolve('engine-head-sha999')),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  note: vi.fn(),
  warn: vi.fn(),
  formatSuccessText: vi.fn((s: string) => s),
  formatErrorText: vi.fn((s: string) => s),
}));

// Mock readdir
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() =>
    Promise.resolve([
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
    ])
  ),
}));

import { loadState } from '../../core/config.js';
import {
  loadFurnaceConfig,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { recordFurnaceRollbackFailure } from '../../core/furnace-operation.js';
import { refreshOverrideFile } from '../../core/furnace-refresh.js';
import { restoreRollbackJournalOrThrow } from '../../core/furnace-rollback.js';
import { getHead } from '../../core/git.js';
import { pathExists } from '../../utils/fs.js';
import { info, note, warn } from '../../utils/logger.js';
import { furnaceRefreshCommand } from '../furnace/refresh.js';

describe('furnace refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default pathExists mock (clearAllMocks does not reset
    // mockImplementation, so tests that override it leak into later tests).
    vi.mocked(pathExists).mockImplementation(() => Promise.resolve(true));
  });

  it('throws when engine directory is missing', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes(nativePath('/project/engine')))
        return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await expect(furnaceRefreshCommand('/project', 'moz-button')).rejects.toThrow(
      'Engine directory not found'
    );
  });

  it('throws if component is not an override', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-widget': { description: '', targetPath: 'x', register: true, localized: false },
      },
    });

    await expect(furnaceRefreshCommand('/project', 'moz-widget')).rejects.toThrow(
      'not an override component'
    );
  });

  it('exits early when baseVersion matches current version', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.9.0', // Matches current version
        },
      },
      custom: {},
    });

    await furnaceRefreshCommand('/project', 'moz-button');
    expect(refreshOverrideFile).not.toHaveBeenCalled();
  });

  it('throws when baseCommit is missing', async () => {
    vi.mocked(loadState).mockResolvedValueOnce({});

    await expect(furnaceRefreshCommand('/project', 'moz-button')).rejects.toThrow(
      'baseCommit not found'
    );
  });

  it('calls refreshOverrideFile for each source file', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(refreshOverrideFile).toHaveBeenCalledTimes(2);
  });

  it('updates baseVersion on clean merge', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'file.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(writeFurnaceConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFurnaceConfig).mock.calls[0] as unknown as [
      string,
      { overrides: Record<string, { baseVersion: string }> },
    ];
    expect(call[0]).toBe('/project');
    expect(call[1].overrides['moz-button']).toHaveProperty('baseVersion', '140.9.0');
  });

  it('does not update baseVersion when conflicts exist', async () => {
    vi.mocked(refreshOverrideFile)
      .mockResolvedValueOnce({ fileName: 'moz-button.mjs', status: 'conflict', conflictMarkers: 2 })
      .mockResolvedValueOnce({ fileName: 'moz-button.css', status: 'merged' });

    await furnaceRefreshCommand('/project', 'moz-button');

    // writeFurnaceConfig should not be called when conflicts exist
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Conflict markers'));
  });

  it('does not modify files in dry-run mode', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button', { dryRun: true });

    // refreshOverrideFile should receive the dryRun flag so it skips writes
    expect(refreshOverrideFile).toHaveBeenCalled();
    const calls = vi.mocked(refreshOverrideFile).mock.calls;
    for (const call of calls) {
      expect(call[0].dryRun).toBe(true);
    }

    // Config should not be written during dry-run
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('uses per-override baseCommit when available', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
          baseCommit: 'override-specific-sha',
        },
      },
      custom: {},
    });
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    // Should use the per-override baseCommit, not the global state one
    const calls = vi.mocked(refreshOverrideFile).mock.calls;
    for (const call of calls) {
      expect(call[0].baseCommit).toBe('override-specific-sha');
    }
  });

  it('persists baseCommit after successful refresh', async () => {
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'file.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(writeFurnaceConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFurnaceConfig).mock.calls[0] as unknown as [
      string,
      { overrides: Record<string, { baseVersion: string; baseCommit?: string }> },
    ];
    expect(call[1].overrides['moz-button']).toHaveProperty('baseCommit', 'engine-head-sha999');
  });

  it('advances baseCommit to engine HEAD even when state.baseCommit is absent', async () => {
    vi.mocked(loadState).mockResolvedValueOnce({
      baseCommit: 'old-commit-for-lookup',
    });
    vi.mocked(loadFurnaceConfig)
      .mockResolvedValueOnce({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-button': {
            type: 'full',
            description: 'Button override',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '145.0',
            baseCommit: 'old-commit-for-lookup',
          },
        },
        custom: {},
      })
      .mockResolvedValueOnce({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-button': {
            type: 'full',
            description: 'Button override',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '145.0',
            baseCommit: 'old-commit-for-lookup',
          },
        },
        custom: {},
      });
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'file.mjs',
      status: 'merged',
    });

    await furnaceRefreshCommand('/project', 'moz-button');

    expect(writeFurnaceConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeFurnaceConfig).mock.calls[0] as unknown as [
      string,
      { overrides: Record<string, { baseVersion: string; baseCommit?: string }> },
    ];
    // baseCommit must advance to engine HEAD, not stay at the old value
    expect(call[1].overrides['moz-button']).toHaveProperty('baseCommit', 'engine-head-sha999');
    expect(call[1].overrides['moz-button']).toHaveProperty('baseVersion', '140.9.0');
  });

  it('throws when override directory is missing', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes(nativePath('overrides/moz-button')))
        return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await expect(furnaceRefreshCommand('/project', 'moz-button')).rejects.toThrow(
      'Override directory not found'
    );
  });

  it('refreshes later overrides in --all mode, then throws a hard-failure summary', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-button': {
          type: 'full',
          description: 'Button override',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
        },
        'moz-card': {
          type: 'full',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(refreshOverrideFile)
      .mockRejectedValueOnce(new Error('merge helper exploded'))
      .mockResolvedValue({ fileName: 'moz-card.mjs', status: 'merged' });

    await expect(furnaceRefreshCommand('/project', undefined, { all: true })).rejects.toThrow(
      /Failed to refresh 1 override\(s\): moz-button: merge helper exploded/
    );

    expect(refreshOverrideFile).toHaveBeenCalledWith({
      engineDir: nativePath('/project/engine'),
      overridePath: expect.stringContaining(
        nativePath('/components/overrides/moz-button/')
      ) as string,
      engineRelPath: expect.any(String) as string,
      baseCommit: expect.any(String) as string,
      fileName: expect.any(String) as string,
      dryRun: false,
      strategy: undefined,
    });
    expect(refreshOverrideFile).toHaveBeenCalledWith({
      engineDir: nativePath('/project/engine'),
      overridePath: expect.stringContaining(
        nativePath('/components/overrides/moz-card/')
      ) as string,
      engineRelPath: expect.any(String) as string,
      baseCommit: expect.any(String) as string,
      fileName: expect.any(String) as string,
      dryRun: false,
      strategy: undefined,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moz-button: merge helper exploded'));
  });
});

/**
 * `vi.clearAllMocks()` clears call records but not implementations, so a
 * `mockResolvedValue` set in one describe leaks into every later one. The
 * blocks below each start from a known baseline instead.
 */
function resetRefreshMocks(): void {
  vi.clearAllMocks();
  vi.mocked(pathExists).mockImplementation(() => Promise.resolve(true));
  vi.mocked(getHead).mockResolvedValue('engine-head-sha999');
  vi.mocked(restoreRollbackJournalOrThrow).mockResolvedValue(undefined);
  vi.mocked(writeFurnaceConfig).mockResolvedValue(undefined);
  vi.mocked(refreshOverrideFile).mockResolvedValue({
    fileName: 'moz-button.mjs',
    status: 'merged',
  } as never);
  vi.mocked(loadFurnaceConfig).mockResolvedValue({
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {
      'moz-button': {
        type: 'full',
        description: 'Button override',
        basePath: 'toolkit/content/widgets/moz-button',
        baseVersion: '145.0',
      },
    },
    custom: {},
  } as never);
}

describe('furnace refresh — argument validation', () => {
  beforeEach(() => {
    resetRefreshMocks();
  });

  it('refuses when neither a name nor --all is given', async () => {
    await expect(furnaceRefreshCommand('/project', undefined, {})).rejects.toThrow(
      /Specify a component name or use --all to refresh every override/
    );
  });

  it('refuses when both a name and --all are given', async () => {
    await expect(furnaceRefreshCommand('/project', 'moz-button', { all: true })).rejects.toThrow(
      /Cannot specify both a component name and --all/
    );
  });
});

describe('furnace refresh --reset-base', () => {
  beforeEach(() => {
    resetRefreshMocks();
  });

  it('re-snapshots the baseline to engine HEAD without merging', async () => {
    await furnaceRefreshCommand('/project', 'moz-button', { resetBase: true });

    // No three-way merge runs.
    expect(refreshOverrideFile).not.toHaveBeenCalled();
    expect(getHead).toHaveBeenCalledWith(nativePath('/project/engine'));
    const written = vi.mocked(writeFurnaceConfig).mock.calls[0]?.[1];
    expect(written?.overrides['moz-button']).toEqual({
      type: 'full',
      description: 'Button override',
      // The rest of the override entry survives the rewrite.
      basePath: 'toolkit/content/widgets/moz-button',
      baseVersion: '140.9.0',
      baseCommit: 'engine-head-sha999',
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Resetting "moz-button" baseline to Firefox 140.9.0 (engine-h)')
    );
  });

  it('writes nothing under --dry-run', async () => {
    await furnaceRefreshCommand('/project', 'moz-button', { resetBase: true, dryRun: true });

    expect(writeFurnaceConfig).not.toHaveBeenCalled();
    expect(refreshOverrideFile).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Three-way merge skipped'));
  });
});

describe('furnace refresh — no source files', () => {
  beforeEach(() => {
    resetRefreshMocks();
  });

  it('returns early when the override directory holds no component sources', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValueOnce([
      { name: 'README.md', isFile: () => true },
      { name: 'nested', isFile: () => false },
    ] as never);

    await furnaceRefreshCommand('/project', 'moz-button', {});

    expect(info).toHaveBeenCalledWith('No source files to refresh.');
    expect(refreshOverrideFile).not.toHaveBeenCalled();
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });
});

describe('furnace refresh — rollback failure', () => {
  beforeEach(() => {
    resetRefreshMocks();
  });

  it('records a repair breadcrumb and surfaces the rollback error', async () => {
    // A merge fails, and the rollback that should undo it also fails. The
    // operator debugging with `doctor --repair-furnace` needs the breadcrumb,
    // and the rollback error must win. The engine is in an unknown state.
    vi.mocked(refreshOverrideFile).mockRejectedValue(new Error('merge exploded'));
    vi.mocked(restoreRollbackJournalOrThrow).mockRejectedValue(
      new Error('could not restore moz-button.mjs')
    );

    await expect(furnaceRefreshCommand('/project', 'moz-button', {})).rejects.toThrow(
      /could not restore moz-button\.mjs/
    );

    // Asserts the outcome (a pending-repair marker persisted to furnace
    // state) rather than the internal call. The rollback sequence now lives
    // in `completeJournalRollback`, whose call to the recorder is
    // intra-module and so invisible to a module-level spy.
    const updater = vi.mocked(updateFurnaceState).mock.calls.at(-1)?.[1] as
      | ((state: Record<string, unknown>) => {
          pendingRepair?: { operation: string; reason: string };
        })
      | undefined;
    expect(updater).toBeTypeOf('function');
    const pendingRepair = updater?.({}).pendingRepair;
    expect(pendingRepair?.operation).toBe('refresh-rollback');
    expect(pendingRepair?.reason).toContain(
      'override "moz-button": could not restore moz-button.mjs'
    );
  });

  it('does not attempt rollback under --dry-run', async () => {
    vi.mocked(refreshOverrideFile).mockRejectedValue(new Error('merge exploded'));

    await expect(furnaceRefreshCommand('/project', 'moz-button', { dryRun: true })).rejects.toThrow(
      /merge exploded/
    );

    expect(restoreRollbackJournalOrThrow).not.toHaveBeenCalled();
    expect(recordFurnaceRollbackFailure).not.toHaveBeenCalled();
  });
});

describe('furnace refresh --all tallies', () => {
  beforeEach(() => {
    resetRefreshMocks();
  });

  it('reports when there is nothing to refresh', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    } as never);

    await furnaceRefreshCommand('/project', undefined, { all: true });

    expect(info).toHaveBeenCalledWith('No overrides to refresh.');
    expect(refreshOverrideFile).not.toHaveBeenCalled();
  });

  it('counts unchanged files in the batch summary', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([{ name: 'moz-button.mjs', isFile: () => true }] as never);
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'unchanged',
    } as never);

    await furnaceRefreshCommand('/project', undefined, { all: true });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('0 file(s) merged, 1 unchanged, 0 conflict(s)'),
      'Refresh Summary'
    );
  });

  it('counts an override that yields no results as already up-to-date', async () => {
    // A component whose refresh returns zero results is "skipped", a distinct
    // tally arm from a component whose files all came back unchanged.
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([{ name: 'README.md', isFile: () => true }] as never);

    await furnaceRefreshCommand('/project', undefined, { all: true });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('1 override(s) processed, 1 already up-to-date'),
      'Refresh Summary'
    );
    expect(refreshOverrideFile).not.toHaveBeenCalled();
  });

  it('warns naming every component that produced a conflict', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-button.mjs', isFile: () => true },
      { name: 'moz-button.css', isFile: () => true },
    ] as never);
    // Two conflicting files in one component must list that component once.
    vi.mocked(refreshOverrideFile).mockResolvedValue({
      fileName: 'moz-button.mjs',
      status: 'conflict',
      conflictCount: 1,
    } as never);

    await furnaceRefreshCommand('/project', undefined, { all: true });

    const conflictWarn = vi
      .mocked(warn)
      .mock.calls.map((c) => c[0])
      .find((m) => m.includes('moz-button'));
    expect(conflictWarn).toBeDefined();
    expect(conflictWarn?.match(/moz-button/g)).toHaveLength(1);
  });
});
