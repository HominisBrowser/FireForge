// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
  select: vi.fn(),
}));

vi.mock('../furnace/override.js', () => ({
  furnaceOverrideCommand: vi.fn(() => Promise.resolve()),
}));

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
  ensureFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    })
  ),
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
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
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
}));

vi.mock('../../core/furnace-scanner.js', () => ({
  scanWidgetsDirectory: vi.fn(() => Promise.resolve([])),
}));

// Stub the lifecycle wrapper so tests do not need to spin up the real
// furnace-wide file lock. The body is invoked synchronously so command
// behavior is unchanged from the test's perspective.
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

vi.mock('../../core/furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  snapshotFile: vi.fn(),
  restoreRollbackJournalOrThrow: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  cancel: vi.fn(),
  info: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn() })),
  success: vi.fn(),
}));

import * as prompts from '@clack/prompts';

import {
  ensureFurnaceConfig,
  furnaceConfigExists,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import { restoreRollbackJournalOrThrow, snapshotFile } from '../../core/furnace-rollback.js';
import { scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, spinner, success } from '../../utils/logger.js';
import { furnaceScanCommand } from '../furnace/scan.js';

const stdinTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTTY(stdinIsTTY: boolean, stdoutIsTTY: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTTY, configurable: true });
}

describe('furnaceScanCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    setTTY(false, false);
  });

  afterAll(() => {
    if (stdinTTYDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinTTYDescriptor);
    }
    if (stdoutTTYDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutTTYDescriptor);
    }
  });

  it('fails when the Firefox source tree is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(furnaceScanCommand('/project')).rejects.toBeInstanceOf(FurnaceError);
    await expect(furnaceScanCommand('/project')).rejects.toThrow(
      'Engine directory not found. Run "fireforge download" first.'
    );

    expect(intro).toHaveBeenCalledWith('Furnace Scan');
    expect(scanWidgetsDirectory).not.toHaveBeenCalled();
  });

  it('lists tracked and untracked components in non-interactive mode', async () => {
    const stop = vi.fn();
    vi.mocked(spinner).mockReturnValue({ message: vi.fn(), stop, error: vi.fn() });
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-button',
        sourcePath: 'toolkit/content/widgets/moz-button',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: false,
        hasFTL: true,
        isRegistered: false,
      },
      {
        tagName: 'moz-card',
        sourcePath: 'toolkit/content/widgets/moz-card',
        hasCSS: true,
        hasFTL: true,
        isRegistered: true,
      },
    ]);

    await furnaceScanCommand('/project');

    expect(stop).toHaveBeenCalledWith('Found 3 components');
    expect(info).toHaveBeenCalledWith('moz-button — CSS, registered [stock]');
    expect(info).toHaveBeenCalledWith('moz-panel — FTL');
    expect(info).toHaveBeenCalledWith('moz-card — CSS, FTL, registered [override]');
    expect(note).toHaveBeenCalledWith('Total: 3  Tracked: 2  Untracked: 1', 'Summary');
    expect(outro).toHaveBeenCalledWith('Scan complete');
  });

  it('adds selected untracked components in interactive mode', async () => {
    setTTY(true, true);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
      {
        tagName: 'moz-dialog',
        sourcePath: 'toolkit/content/widgets/moz-dialog',
        hasCSS: false,
        hasFTL: true,
        isRegistered: false,
      },
    ]);
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true) // Add to furnace.json?
      .mockResolvedValueOnce(false); // Override any?
    vi.mocked(prompts.multiselect).mockResolvedValue(['moz-panel']);
    vi.mocked(ensureFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-existing'],
      overrides: {},
      custom: {},
    });

    await furnaceScanCommand('/project');

    expect(prompts.confirm).toHaveBeenCalledWith({ message: 'Add components to furnace.json?' });
    expect(prompts.multiselect).toHaveBeenCalledWith({
      message: 'Select components to add as stock',
      options: [
        { value: 'moz-panel', label: 'moz-panel — CSS, registered' },
        { value: 'moz-dialog', label: 'moz-dialog — FTL' },
      ],
    });
    expect(writeFurnaceConfig).toHaveBeenCalledWith('/project', {
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-existing', 'moz-panel'],
      overrides: {},
      custom: {},
    });
    expect(success).toHaveBeenCalledWith('Added 1 component to furnace.json');
    expect(outro).not.toHaveBeenCalledWith('Scan complete');
  });

  it('runs the add-to-stock mutation through runFurnaceMutation with a journal', async () => {
    // Regression: scan used to write furnace.json directly, bypassing the
    // furnace-wide lock and SIGINT/SIGTERM rollback. The mutation must
    // now go through runFurnaceMutation, which acquires the lock and gives
    // the body a journal it registers for signal-driven cleanup.
    setTTY(true, true);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
    ]);
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true) // Add to furnace.json?
      .mockResolvedValueOnce(false); // Override any?
    vi.mocked(prompts.multiselect).mockResolvedValue(['moz-panel']);

    await furnaceScanCommand('/project');

    expect(runFurnaceMutation).toHaveBeenCalledWith(
      '/project',
      'scan-rollback',
      expect.any(Function)
    );
    // The body must snapshot furnace.json before the write so a failure
    // can roll back creation of a default file.
    expect(snapshotFile).toHaveBeenCalledWith(expect.any(Object), '/project/furnace.json');
  });

  it('rolls back when writeFurnaceConfig fails after ensureFurnaceConfig created a default', async () => {
    setTTY(true, true);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
    ]);
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    vi.mocked(prompts.multiselect).mockResolvedValue(['moz-panel']);
    vi.mocked(writeFurnaceConfig).mockRejectedValueOnce(new Error('disk full'));

    await expect(furnaceScanCommand('/project')).rejects.toThrow('disk full');

    // The catch block must invoke the journal restore, which (when the
    // pre-snapshot recorded the file as non-existent) deletes the
    // accidentally-created default config.
    expect(restoreRollbackJournalOrThrow).toHaveBeenCalled();
  });

  it('--track persists every untracked component into stock non-interactively (0.34.0)', async () => {
    setTTY(false, false);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      { tagName: 'moz-button', hasCSS: true, hasFTL: false, isRegistered: true },
      { tagName: 'moz-dialog', hasCSS: false, hasFTL: false, isRegistered: true },
      { tagName: 'moz-toggle', hasCSS: true, hasFTL: true, isRegistered: true },
    ] as never);
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    } as never);
    vi.mocked(ensureFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    } as never);

    await furnaceScanCommand('/project', { track: true });

    // Only untracked components are appended; existing entries are kept
    // and never duplicated.
    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ stock: ['moz-button', 'moz-dialog', 'moz-toggle'] })
    );
    expect(runFurnaceMutation).toHaveBeenCalledWith(
      '/project',
      'scan-rollback',
      expect.any(Function)
    );
    expect(success).toHaveBeenCalledWith(expect.stringContaining('Tracked 2 components'));
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('--track is a no-op when everything is already tracked (0.34.0)', async () => {
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      { tagName: 'moz-button', hasCSS: true, hasFTL: false, isRegistered: true },
    ] as never);
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    } as never);

    await furnaceScanCommand('/project', { track: true });

    expect(writeFurnaceConfig).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Nothing to track'));
  });

  it('non-interactive scan without --track points at --track (0.34.0)', async () => {
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      { tagName: 'moz-dialog', hasCSS: false, hasFTL: false, isRegistered: true },
    ] as never);

    await furnaceScanCommand('/project', {});

    expect(writeFurnaceConfig).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--track'));
  });

  it('exits when user cancels at the confirm prompt', async () => {
    setTTY(true, true);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
    ]);

    const cancelSymbol = Symbol('cancel');
    vi.mocked(prompts.confirm).mockResolvedValue(cancelSymbol);
    const { isCancel, cancel } = await import('../../utils/logger.js');
    vi.mocked(isCancel).mockImplementation((value) => value === cancelSymbol);

    await furnaceScanCommand('/project');

    expect(cancel).toHaveBeenCalledWith('Cancelled');
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('exits when user cancels at the multiselect prompt', async () => {
    setTTY(true, true);
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-panel',
        sourcePath: 'toolkit/content/widgets/moz-panel',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
    ]);
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    const cancelSymbol = Symbol('cancel');
    vi.mocked(prompts.multiselect).mockResolvedValue(cancelSymbol);
    const { isCancel, cancel } = await import('../../utils/logger.js');
    vi.mocked(isCancel).mockImplementation((value) => value === cancelSymbol);

    await furnaceScanCommand('/project');

    expect(cancel).toHaveBeenCalledWith('Cancelled');
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('does not prompt when all scanned components are already tracked', async () => {
    setTTY(true, true);
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    });
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-button',
        sourcePath: 'toolkit/content/widgets/moz-button',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
    ]);

    await furnaceScanCommand('/project');

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith('Scan complete');
  });

  it('shows zero untracked in summary when everything is tracked', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(scanWidgetsDirectory).mockResolvedValue([
      {
        tagName: 'moz-button',
        sourcePath: 'toolkit/content/widgets/moz-button',
        hasCSS: true,
        hasFTL: false,
        isRegistered: true,
      },
      {
        tagName: 'moz-card',
        sourcePath: 'toolkit/content/widgets/moz-card',
        hasCSS: true,
        hasFTL: true,
        isRegistered: true,
      },
    ]);

    await furnaceScanCommand('/project');

    expect(note).toHaveBeenCalledWith('Total: 2  Tracked: 2  Untracked: 0', 'Summary');
    expect(outro).toHaveBeenCalledWith('Scan complete');
  });
});
