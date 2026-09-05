// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativePath } from '../../test-utils/index.js';
import { createFsMock } from '../../test-utils/module-mocks.js';

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

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
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

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

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
    // Start the command with watch: true in the background. runWatchLoop
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

  it('stays running and retries on poll when no component dirs exist at startup', async () => {
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

    // pathExists sequence:
    //   1. engine dir check in furnaceApplyCommand: true
    //   2. first refreshWatchers → overridesDir: false
    //   3. first refreshWatchers → customDir: false
    //   4+ subsequent refreshWatchers calls on poll tick: still false
    vi.mocked(pathExists).mockImplementation((targetPath: string) => {
      if (targetPath === nativePath('/project/engine')) return Promise.resolve(true);
      return Promise.resolve(false);
    });

    const commandPromise = furnaceApplyCommand('/project', undefined, { watch: true });
    // Let the initial apply and refreshWatchers settle.
    await vi.advanceTimersByTimeAsync(0);

    // No fs.watch should be installed while neither candidate dir exists.
    expect(mockWatchers).toHaveLength(0);
    // The loop stays running and logs the retry hint rather than exiting,
    // so a later `furnace create` / `furnace override` in another terminal
    // is picked up on the next 30 s poll tick.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('No component directories exist yet')
    );

    process.emit('SIGINT', 'SIGINT');
    commandPromise.catch(() => {});
  });

  it('picks up a component dir that appears after watch started', async () => {
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

    // Initially neither override nor custom dir exists. After the first
    // poll tick, the override dir appears (simulating a concurrent
    // `furnace override` command in another terminal).
    let overrideExists = false;
    vi.mocked(pathExists).mockImplementation((targetPath: string) => {
      if (targetPath === nativePath('/project/engine')) return Promise.resolve(true);
      if (targetPath === nativePath('/project/components/overrides'))
        return Promise.resolve(overrideExists);
      return Promise.resolve(false);
    });

    const commandPromise = furnaceApplyCommand('/project', undefined, { watch: true });
    await vi.advanceTimersByTimeAsync(0);

    // No watcher at startup. The dir does not exist yet.
    expect(mockWatchers).toHaveLength(0);

    // Simulate the override dir being created.
    overrideExists = true;

    // Advance past the 30s poll interval.
    await vi.advanceTimersByTimeAsync(31_000);
    // Flush the poll body's promise chain and the triggered apply debounce.
    await vi.advanceTimersByTimeAsync(500);

    // The newly-appeared dir should now have a watcher.
    expect(mockWatchers.length).toBeGreaterThan(0);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Now watching'));

    process.emit('SIGINT', 'SIGINT');
    commandPromise.catch(() => {});
  });
});
