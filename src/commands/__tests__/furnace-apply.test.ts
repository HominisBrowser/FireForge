// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

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

vi.mock('../../core/furnace-state-persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/furnace-state-persist.js')>();
  return {
    ...actual,
    persistSingleComponentState: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
  getFurnacePaths: vi.fn(() => ({
    overridesDir: '/project/furnace/overrides',
    customDir: '/project/furnace/custom',
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

import { loadConfig } from '../../core/config.js';
import { applyAllComponents } from '../../core/furnace-apply.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, outro, spinner, success, warn } from '../../utils/logger.js';
import { furnaceApplyCommand } from '../furnace/apply.js';

describe('furnaceApplyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
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
  });

  it('fails when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/Engine directory not found/i);

    expect(intro).toHaveBeenCalledWith('Furnace Apply');
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('fails when furnace is not configured yet', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/No furnace\.json found/i);

    expect(loadFurnaceConfig).not.toHaveBeenCalled();
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('returns early when there are no components to apply', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await furnaceApplyCommand('/project');

    expect(info).toHaveBeenCalledWith('No components to apply.');
    expect(outro).toHaveBeenCalledWith('Done');
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('applies components successfully and reports counts', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['moz-card.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });

    await furnaceApplyCommand('/project', undefined, { force: true });

    expect(applyAllComponents).toHaveBeenCalled();
    expect(success).toHaveBeenCalled();
  });

  it('prints planned actions in dry-run mode', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: [],
        },
      ],
      skipped: [],
      errors: [],
      actions: [
        {
          component: 'moz-card',
          action: 'copy',
          source: '/project/components/overrides/moz-card/moz-card.css',
          target: '/project/engine/toolkit/content/widgets/moz-card/moz-card.css',
          description: 'Override moz-card.css in toolkit/content/widgets/moz-card',
        },
      ],
    });

    await furnaceApplyCommand('/project', undefined, { dryRun: true });

    /* eslint-disable @typescript-eslint/no-unsafe-assignment --
     * vitest's `expect.objectContaining` returns `any`; the matcher itself
     * is correctly typed but the inner object slot is not. */
    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      true,
      expect.objectContaining({
        operationContext: expect.objectContaining({
          registerJournal: expect.any(Function),
        }),
      })
    );
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    expect(info).toHaveBeenCalledWith('Planned actions:');
    expect(info).toHaveBeenCalledWith(
      '  [copy] moz-card: Override moz-card.css in toolkit/content/widgets/moz-card'
    );
    expect(outro).toHaveBeenCalledWith('Dry run complete — would apply 1, skip 0');
    expect(success).not.toHaveBeenCalled();
  });

  it('reports "No actions would be performed." when dry-run has no actions', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [],
      actions: [],
    });

    await furnaceApplyCommand('/project', undefined, { dryRun: true });

    expect(info).toHaveBeenCalledWith('No actions would be performed.');
    expect(outro).toHaveBeenCalledWith('Dry run complete — would apply 0, skip 0');
  });

  it('reports real apply errors and throws after logging them', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['a.css'],
          stepErrors: [],
        },
      ],
      skipped: [],
      errors: [{ name: 'moz-sidebar', error: 'copy failed' }],
      actions: [],
    });

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/1 component failed to apply/i);

    expect(spinner).toHaveBeenCalledWith('Applying components to engine...');
    expect(success).toHaveBeenCalledWith('moz-card (override) → 1 files');
    expect(error).toHaveBeenCalledWith('moz-sidebar — copy failed');
    expect(outro).not.toHaveBeenCalled();
  });

  it('treats step errors as apply failures after logging them', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
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
      actions: [],
    });

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(/failed to apply cleanly/i);

    expect(success).toHaveBeenCalledWith('moz-card (override) → 1 files');
    expect(warn).toHaveBeenCalledWith('moz-card: [register] customElements.js missing');
    expect(outro).not.toHaveBeenCalled();
  });

  it('refuses to apply when an override is stale against fireforge.json', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['a.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });

    await expect(furnaceApplyCommand('/project')).rejects.toThrow(
      /stale against the Firefox version/i
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Override "moz-card" was created against Firefox 145.0')
    );
    expect(applyAllComponents).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it('blocks apply when an override is stale against fireforge.json without --force', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });

    await expect(furnaceApplyCommand('/project', undefined, { dryRun: true })).rejects.toThrow(
      /stale/i
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Override "moz-card" was created against Firefox 145.0')
    );
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('allows apply with --force despite baseVersion drift', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: [] }],
      skipped: [],
      errors: [],
      actions: [],
    });

    await expect(
      furnaceApplyCommand('/project', undefined, { dryRun: true, force: true })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Override "moz-card" was created against Firefox 145.0')
    );
    expect(applyAllComponents).toHaveBeenCalled();
  });

  it('named apply disables the batch state persist and merges per-component state', async () => {
    // A named apply must not run the batch persist path, whose wholesale
    // appliedChecksums replace wipes every OTHER component's checksum state
    // — after which orphan detection and deleted-file undeploy, both keyed
    // on that state, go blind. Named apply mirrors `furnace deploy <name>`:
    // persistState: false plus a per-component merge.
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    });
    const { persistSingleComponentState } = await import('../../core/furnace-state-persist.js');
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: [] }],
      skipped: [],
      errors: [],
      actions: [],
    });

    await furnaceApplyCommand('/project', 'moz-card', {});

    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      false,
      expect.objectContaining({ componentName: 'moz-card', persistState: false })
    );
    expect(vi.mocked(persistSingleComponentState)).toHaveBeenCalledWith(
      '/project',
      { name: 'moz-card', type: 'override' },
      expect.anything()
    );
  });

  it('named apply does not persist state when the run reported errors', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    });
    const { persistSingleComponentState } = await import('../../core/furnace-state-persist.js');
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [{ name: 'moz-card', error: 'boom' }],
      actions: [],
    });

    await expect(furnaceApplyCommand('/project', 'moz-card', {})).rejects.toThrow(
      /failed to apply cleanly/
    );
    expect(vi.mocked(persistSingleComponentState)).not.toHaveBeenCalled();
  });

  it('batch apply keeps the wholesale persist path and no per-component merge', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    });
    const { persistSingleComponentState } = await import('../../core/furnace-state-persist.js');
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: [] }],
      skipped: [],
      errors: [],
      actions: [],
    });

    await furnaceApplyCommand('/project', undefined, {});

    const optionsArg = vi.mocked(applyAllComponents).mock.calls[0]?.[2];
    expect(optionsArg).not.toHaveProperty('persistState');
    expect(optionsArg).not.toHaveProperty('componentName');
    expect(vi.mocked(persistSingleComponentState)).not.toHaveBeenCalled();
  });
});
