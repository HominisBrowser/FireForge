// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../../core/furnace-apply.js', () => ({
  applyAllComponents: vi.fn(),
  computeComponentChecksums: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../core/furnace-apply-output.js', () => ({
  logApplyResult: vi.fn(),
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

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
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
}));

vi.mock('../../core/furnace-version-drift.js', () => ({
  findOverrideBaseVersionDrift: vi.fn(() => []),
  formatOverrideBaseVersionDriftError: vi.fn(() => ''),
  formatOverrideBaseVersionDriftWarning: vi.fn(() => ''),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
  })),
}));

// Capture watchers created by fs.watch so tests can simulate file events
type WatchCallback = (event: string, filename: string | null) => void;
const mockWatchers: Array<{ close: ReturnType<typeof vi.fn>; callback: WatchCallback }> = [];

vi.mock('node:fs', () => ({
  watch: vi.fn((_dir: string, _opts: unknown, callback: WatchCallback) => {
    const watcher = { close: vi.fn(), callback, on: vi.fn().mockReturnThis() };
    mockWatchers.push(watcher);
    return watcher;
  }),
}));

import { applyAllComponents } from '../../core/furnace-apply.js';
import { loadFurnaceConfig } from '../../core/furnace-config.js';
import { pathExists } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import { furnaceApplyCommand } from '../furnace/apply.js';

describe('furnaceApplyCommand — watch mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatchers.length = 0;
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['moz-card.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies components and starts watching directories', async () => {
    // Start the command with watch: true in the background — runWatchLoop
    // blocks indefinitely, so we don't await it to completion.
    const commandPromise = furnaceApplyCommand('/project', undefined, { watch: true });

    // Let the initial apply settle (microtask queue).
    await vi.advanceTimersByTimeAsync(0);

    // The initial apply should have run.
    expect(applyAllComponents).toHaveBeenCalledTimes(1);

    // fs.watch should have been called for the override and/or custom dirs.
    expect(mockWatchers.length).toBeGreaterThan(0);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Watching'));

    // Simulate a file change on a source file.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by assertion above
    mockWatchers[0]!.callback('change', 'moz-card.css');

    // Advance past the 300ms debounce.
    await vi.advanceTimersByTimeAsync(350);

    // The re-apply should have fired.
    expect(applyAllComponents).toHaveBeenCalledTimes(2);

    // Tear down: send SIGINT to unblock the promise and close watchers.
    process.emit('SIGINT', 'SIGINT');
    // Suppress unhandled rejection from the never-resolving promise.
    commandPromise.catch(() => {});
  });

  it('filters non-source file changes', async () => {
    const commandPromise = furnaceApplyCommand('/project', undefined, { watch: true });
    await vi.advanceTimersByTimeAsync(0);

    // Reset the call count after initial apply.
    vi.mocked(applyAllComponents).mockClear();

    // Simulate a change on a non-source file (e.g. .json, .md).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect(mockWatchers).toHaveLength assertion
    mockWatchers[0]!.callback('change', 'readme.md');
    await vi.advanceTimersByTimeAsync(350);

    // No re-apply should have been triggered.
    expect(applyAllComponents).not.toHaveBeenCalled();

    // Simulate a change on another non-source file.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- same watcher as above
    mockWatchers[0]!.callback('change', 'override.json');
    await vi.advanceTimersByTimeAsync(350);
    expect(applyAllComponents).not.toHaveBeenCalled();

    process.emit('SIGINT', 'SIGINT');
    commandPromise.catch(() => {});
  });

  it('does not start watch when there are no override or custom components', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
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
    });

    // Make pathExists return true for the engine dir check, but false for
    // the override and custom directories so runWatchLoop finds nothing.
    vi.mocked(pathExists)
      .mockResolvedValueOnce(true) // engine dir
      .mockResolvedValueOnce(false) // overridesDir
      .mockResolvedValueOnce(false); // customDir

    await furnaceApplyCommand('/project', undefined, { watch: true });

    expect(info).toHaveBeenCalledWith('No component directories to watch.');
    expect(mockWatchers).toHaveLength(0);
  });
});
