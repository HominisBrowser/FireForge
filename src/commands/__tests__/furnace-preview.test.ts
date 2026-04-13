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

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    })
  ),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-apply.js', () => ({
  applyAllComponents: vi.fn(() =>
    Promise.resolve({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['a.css'] }],
      skipped: [],
      errors: [],
      rollbackJournal: { files: new Map(), createdDirs: new Set(), skippedSymlinks: new Set() },
    })
  ),
}));

vi.mock('../../core/furnace-rollback.js', () => ({
  restoreRollbackJournal: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (
      _root: string,
      _kind: string,
      body: (ctx: { registerJournal: () => void; registerCleanup: () => void }) => Promise<unknown>
    ) =>
      body({
        registerJournal: () => undefined,
        registerCleanup: () => undefined,
      })
  ),
  recordFurnaceRollbackFailure: vi.fn(),
}));

vi.mock('../../core/furnace-stories.js', () => ({
  syncStories: vi.fn(() =>
    Promise.resolve({ created: ['moz-card.stories.mjs'], updated: [], removed: [] })
  ),
  cleanStories: vi.fn(() => Promise.resolve(1)),
}));

vi.mock('../../core/mach.js', () => ({
  runMach: vi.fn(),
  runMachCapture: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

import { applyAllComponents } from '../../core/furnace-apply.js';
import { updateFurnaceState } from '../../core/furnace-config.js';
import { restoreRollbackJournal } from '../../core/furnace-rollback.js';
import { cleanStories, syncStories } from '../../core/furnace-stories.js';
import { runMach, runMachCapture } from '../../core/mach.js';
import type { FurnaceState } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { furnacePreviewCommand } from '../furnace/preview.js';

describe('furnacePreviewCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/project/engine' || path === '/project/engine/browser/components/storybook'
      )
    );
    vi.mocked(runMachCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('fails early when the Firefox checkout lacks Storybook support', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(
      /does not contain browser\/components\/storybook/i
    );

    expect(syncStories).not.toHaveBeenCalled();
  });

  it('treats Ctrl+C as a normal preview shutdown', async () => {
    vi.mocked(runMachCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 130 });

    await expect(furnacePreviewCommand('/project')).resolves.toBeUndefined();
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
  });

  it('rewrites missing backend/storybook paths into a focused error', async () => {
    vi.mocked(runMachCapture).mockResolvedValue({
      stdout: '',
      stderr: 'Error: ENOENT: no such file or directory, open backend/storybook/package.json',
      exitCode: 1,
    });

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(
      /missing Storybook workspace files or backend dependencies/i
    );
  });

  it('cleans synced stories when dependency installation fails', async () => {
    vi.mocked(runMach).mockResolvedValue(1);

    await expect(furnacePreviewCommand('/project', { install: true })).rejects.toThrow(
      /dependency reinstallation failed/i
    );

    expect(syncStories).toHaveBeenCalled();
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
  });

  it('stages workspace components and restores them on teardown', async () => {
    await furnacePreviewCommand('/project');

    /* eslint-disable @typescript-eslint/no-unsafe-assignment --
     * vitest's `expect.objectContaining` returns `any`. */
    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      false,
      expect.objectContaining({
        persistState: false,
        operationContext: expect.objectContaining({
          registerJournal: expect.any(Function),
          registerCleanup: expect.any(Function),
        }),
      })
    );
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    expect(syncStories).toHaveBeenCalled();
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
    expect(restoreRollbackJournal).toHaveBeenCalled();
  });

  it('throws and still restores staged files when staging fails mid-way', async () => {
    vi.mocked(applyAllComponents).mockResolvedValueOnce({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['a.css'],
          stepErrors: [{ step: 'register', error: 'customElements.js missing' }],
        },
      ],
      skipped: [],
      errors: [],
      rollbackJournal: { files: new Map(), createdDirs: new Set(), skippedSymlinks: new Set() },
    });

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(/failed to stage for preview/i);

    expect(restoreRollbackJournal).toHaveBeenCalled();
    expect(syncStories).not.toHaveBeenCalled();
  });

  it('cleans synced stories when syncStories fails mid-sync', async () => {
    // Regression guard for non-atomic cleanup: syncStories writes files
    // incrementally, so a mid-sync failure can leave partial files behind.
    // The fix sets the cleanup flag BEFORE awaiting syncStories, so the
    // finally block still runs cleanStories on partial state.
    vi.mocked(syncStories).mockRejectedValueOnce(new Error('ENOSPC: disk full mid-write'));

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(/disk full mid-write/i);

    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
    // Staging rollback must still run too.
    expect(restoreRollbackJournal).toHaveBeenCalled();
  });

  it('skips staging when the project has no components to preview', async () => {
    // Mock config with no overrides or custom (just stock, which still requires sync)
    const { loadFurnaceConfig } = await import('../../core/furnace-config.js');
    vi.mocked(loadFurnaceConfig).mockResolvedValueOnce({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    });

    await furnacePreviewCommand('/project');

    expect(applyAllComponents).not.toHaveBeenCalled();
    expect(restoreRollbackJournal).not.toHaveBeenCalled();
    expect(syncStories).toHaveBeenCalled();
  });

  it('records a pendingRepair marker and points at doctor when the journal restore fails', async () => {
    // Regression guard for B1: if `restoreRollbackJournal` throws during
    // teardown, the engine is left with staged workspace files and there
    // was no recovery path. The fix persists a `pendingRepair` marker so
    // the next `fireforge doctor --repair-furnace` can reconcile.
    vi.mocked(restoreRollbackJournal).mockRejectedValueOnce(
      new Error('EACCES: cannot write /project/engine/...')
    );

    let caught: unknown;
    try {
      await furnacePreviewCommand('/project');
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/Preview teardown could not restore the engine cleanly/i);
    expect(message).toMatch(/fireforge doctor --repair-furnace/i);

    expect(updateFurnaceState).toHaveBeenCalledWith('/project', expect.any(Function));
    const updater = vi.mocked(updateFurnaceState).mock.calls[0]?.[1];
    if (typeof updater !== 'function') throw new Error('expected updater function');
    const next = updater({} as FurnaceState);
    expect(next.pendingRepair?.operation).toBe('preview-teardown');
    expect(next.pendingRepair?.reason).toContain('EACCES');
    // cleanStories must still have run even though the journal restore
    // is the failing step — both teardown steps are independent.
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
  });

  it('records a pendingRepair marker when cleanStories fails but still attempts journal restore', async () => {
    // Symmetric to the above: a cleanStories failure must not prevent
    // the journal restore from running. The previous implementation used
    // a finally block where an early throw skipped the second teardown
    // step entirely.
    vi.mocked(cleanStories).mockRejectedValueOnce(new Error('ENOSPC: out of space'));

    await expect(furnacePreviewCommand('/project')).rejects.toThrow(
      /Preview teardown could not restore the engine cleanly/i
    );

    expect(restoreRollbackJournal).toHaveBeenCalled();
    expect(updateFurnaceState).toHaveBeenCalled();
  });

  it('surfaces both the primary error and the teardown failure when both occur', async () => {
    vi.mocked(syncStories).mockRejectedValueOnce(new Error('disk full mid-write'));
    vi.mocked(restoreRollbackJournal).mockRejectedValueOnce(new Error('EACCES: engine locked'));

    let caught: unknown;
    try {
      await furnacePreviewCommand('/project');
    } catch (err: unknown) {
      caught = err;
    }

    // Both errors must be surfaced so the operator sees what triggered
    // the failure AND what was left behind.
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/EACCES: engine locked/);
    expect(message).toMatch(/disk full mid-write/);
    expect(updateFurnaceState).toHaveBeenCalled();
  });
});
