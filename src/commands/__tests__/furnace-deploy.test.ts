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
  applyOverrideComponent: vi.fn(),
  applyCustomComponent: vi.fn(),
  computeComponentChecksums: vi.fn(),
  prefixChecksums: vi.fn(),
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
  loadFurnaceState: vi.fn(() => Promise.resolve({ appliedChecksums: {}, lastApply: null })),
  saveFurnaceState: vi.fn(),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-rollback.js', () => ({
  recordCreatedDir: vi.fn(),
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-operation.js', () => ({
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

vi.mock('../../core/furnace-validate.js', () => ({
  validateAllComponents: vi.fn(),
  validateComponent: vi.fn(),
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
  note: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

import { loadConfig } from '../../core/config.js';
import {
  applyAllComponents,
  computeComponentChecksums,
  prefixChecksums,
} from '../../core/furnace-apply.js';
import { loadFurnaceConfig, updateFurnaceState } from '../../core/furnace-config.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { pathExists } from '../../utils/fs.js';
import { success, warn } from '../../utils/logger.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';

describe('furnaceDeployCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('skips validation noise when the selected component fails apply', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [{ name: 'moz-card', error: 'apply state mismatch' }],
      actions: [],
    });

    await expect(
      furnaceDeployCommand('/project', 'moz-card', {
        dryRun: true,
      })
    ).rejects.toThrow(/Dry run completed with 1 apply error\(s\)/);

    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('deploys all components and validates successfully', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['a.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateAllComponents).mockResolvedValue(new Map());
    vi.mocked(computeComponentChecksums).mockResolvedValue({});
    vi.mocked(prefixChecksums).mockReturnValue({});

    await expect(furnaceDeployCommand('/project')).resolves.toBeUndefined();

    /* eslint-disable @typescript-eslint/no-unsafe-assignment --
     * vitest's `expect.objectContaining` returns `any`. */
    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      false,
      expect.objectContaining({
        operationContext: expect.objectContaining({
          registerJournal: expect.any(Function),
        }),
      })
    );
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    expect(validateAllComponents).toHaveBeenCalledWith('/project');
    expect(vi.mocked(success)).toHaveBeenCalled();
  });

  it('deploys a single override component through the batch pipeline', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['toolkit/content/widgets/moz-card/moz-card.css'],
        },
      ],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'a.css': 'abc' });
    vi.mocked(prefixChecksums).mockReturnValue({ 'override/moz-card/a.css': 'abc' });

    await expect(furnaceDeployCommand('/project', 'moz-card')).resolves.toBeUndefined();

    // Named deploys run the same pipeline as deploy-all (D1: deletion
    // detection + jar.mn re-sync), but must never let the batch persist
    // path wipe other components' checksums.
    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      false,
      expect.objectContaining({ componentName: 'moz-card', persistState: false })
    );
    expect(updateFurnaceState).toHaveBeenCalled();
  });

  it('replaces stale checksum entries for the selected component during named deploy', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['toolkit/content/widgets/moz-card/moz-card.css'],
        },
      ],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'new.css': 'abc' });
    vi.mocked(prefixChecksums).mockReturnValue({ 'override/moz-card/new.css': 'abc' });

    await furnaceDeployCommand('/project', 'moz-card');

    const updater = vi.mocked(updateFurnaceState).mock.calls[0]?.[1];
    expect(updater).toBeTypeOf('function');
    const next = (
      updater as (state: {
        appliedChecksums?: Record<string, string>;
        engineChecksums?: Record<string, string>;
      }) => {
        appliedChecksums?: Record<string, string>;
        engineChecksums?: Record<string, string>;
      }
    )({
      appliedChecksums: {
        'override/moz-card/old.css': 'stale',
        'custom/moz-sidebar/sidebar.css': 'keep',
      },
      engineChecksums: {
        'override/moz-card/old.css': 'stale',
        'custom/moz-sidebar/sidebar.css': 'keep',
      },
    });

    expect(next.appliedChecksums).toEqual({
      'custom/moz-sidebar/sidebar.css': 'keep',
      'override/moz-card/new.css': 'abc',
    });
    expect(next.engineChecksums).toEqual({
      'custom/moz-sidebar/sidebar.css': 'keep',
      'override/moz-card/new.css': 'abc',
    });
  });

  it('deploys a single custom component', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-sidebar', type: 'custom', filesAffected: ['sidebar.mjs'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);
    vi.mocked(computeComponentChecksums).mockResolvedValue({});
    vi.mocked(prefixChecksums).mockReturnValue({});

    await expect(furnaceDeployCommand('/project', 'moz-sidebar')).resolves.toBeUndefined();

    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      false,
      expect.objectContaining({ componentName: 'moz-sidebar', persistState: false })
    );
  });

  it('validates dry-run custom deploys against the projected jar.mn registration', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-sidebar', type: 'custom', filesAffected: [] }],
      skipped: [],
      errors: [],
      actions: [
        {
          component: 'moz-sidebar',
          action: 'register-jar',
          description: 'Add moz-sidebar.mjs, moz-sidebar.css to jar.mn',
        },
      ],
    });
    vi.mocked(validateComponent).mockResolvedValue([
      {
        component: 'moz-sidebar',
        severity: 'error',
        check: 'missing-jar-mn-mjs',
        message: 'moz-sidebar.mjs is not registered in jar.mn.',
      },
      {
        component: 'moz-sidebar',
        severity: 'warning',
        check: 'missing-jar-mn-css',
        message: 'moz-sidebar.css is not registered in jar.mn.',
      },
    ]);

    await expect(
      furnaceDeployCommand('/project', 'moz-sidebar', { dryRun: true })
    ).resolves.toBeUndefined();

    expect(success).toHaveBeenCalledWith('moz-sidebar — all checks passed');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('missing-jar-mn'));
    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('rolls back and skips validation when a single-component deploy has step errors', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    // Rollback itself now happens inside applyAllComponents (covered by
    // furnace-apply tests); deploy's contract is to refuse persisting and
    // skip validation when the result carries step errors.
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [
        {
          name: 'moz-sidebar',
          type: 'custom',
          filesAffected: ['sidebar.mjs'],
          stepErrors: [{ step: 'register', error: 'customElements.js missing' }],
        },
      ],
      skipped: [],
      errors: [],
      actions: [],
      rolledBack: true,
    });

    await expect(furnaceDeployCommand('/project', 'moz-sidebar')).rejects.toThrow(
      /apply error\(s\)/i
    );

    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('rolls back and skips validation when a single custom deploy throws during apply', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [{ name: 'moz-sidebar', error: 'copy failed' }],
      actions: [],
      rolledBack: true,
    });

    await expect(furnaceDeployCommand('/project', 'moz-sidebar')).rejects.toThrow(
      /apply error\(s\)/i
    );

    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('rolls back when a single override deploy throws during apply', async () => {
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
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [{ name: 'moz-card', error: 'copy failed' }],
      actions: [],
      rolledBack: true,
    });

    await expect(furnaceDeployCommand('/project', 'moz-card')).rejects.toThrow(/apply error\(s\)/i);

    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('throws when component is not found in furnace.json', async () => {
    await expect(furnaceDeployCommand('/project', 'moz-unknown')).rejects.toThrow(
      /not found in furnace\.json/
    );
  });

  it('returns early for stock components in named deploy mode', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-stock-card'],
      overrides: {},
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });

    await expect(furnaceDeployCommand('/project', 'moz-stock-card')).resolves.toBeUndefined();

    expect(applyAllComponents).not.toHaveBeenCalled();
    expect(validateComponent).not.toHaveBeenCalled();
    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      '"moz-stock-card" is a stock component. Stock components are not applied locally.'
    );
  });

  it('surfaces validation warnings without failing', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['a.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateAllComponents).mockResolvedValue(
      new Map([
        [
          'moz-card',
          [
            {
              component: 'moz-card',
              check: 'css-lint',
              severity: 'warning' as const,
              message: 'Unused variable',
            },
          ],
        ],
      ])
    );

    await expect(furnaceDeployCommand('/project')).resolves.toBeUndefined();

    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Unused variable'));
  });

  it('fails when validation reports errors after a successful apply', async () => {
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['a.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateAllComponents).mockResolvedValue(
      new Map([
        [
          'moz-card',
          [
            {
              component: 'moz-card',
              check: 'css-lint',
              severity: 'error' as const,
              message: 'Broken rule',
            },
          ],
        ],
      ])
    );

    await expect(furnaceDeployCommand('/project')).rejects.toThrow(
      /completed with 1 validation error\(s\)/i
    );
  });

  it('does not persist state in dry-run mode', async () => {
    // Re-set the config mock in case a prior test overrode it
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
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['a.css'] }],
      skipped: [],
      errors: [],
      actions: [{ action: 'copy', component: 'moz-card', description: 'Copy CSS' }],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);

    await expect(
      furnaceDeployCommand('/project', 'moz-card', { dryRun: true })
    ).resolves.toBeUndefined();

    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('refuses named deploy on baseVersion drift scoped to the selected component', async () => {
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
        'moz-panel': {
          type: 'full',
          description: 'Override panel',
          basePath: 'toolkit/content/widgets/moz-panel',
          baseVersion: '144.0',
        },
      },
      custom: {},
    });
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });
    vi.mocked(validateComponent).mockResolvedValue([]);
    vi.mocked(computeComponentChecksums).mockResolvedValue({});
    vi.mocked(prefixChecksums).mockReturnValue({});

    await expect(furnaceDeployCommand('/project', 'moz-card')).rejects.toThrow(
      /stale against the Firefox version/i
    );

    const driftWarnings = vi
      .mocked(warn)
      .mock.calls.map(([msg]) => msg)
      .filter(
        (msg): msg is string =>
          typeof msg === 'string' && msg.includes('was created against Firefox')
      );
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0]).toContain('moz-card');
    expect(driftWarnings[0]).not.toContain('moz-panel');
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('blocks deploy when the selected component has baseVersion drift without --force', async () => {
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
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });

    await expect(furnaceDeployCommand('/project', 'moz-card', { dryRun: true })).rejects.toThrow(
      /stale/i
    );

    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('allows deploy with --force despite baseVersion drift', async () => {
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
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['moz-card.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);

    await expect(
      furnaceDeployCommand('/project', 'moz-card', { dryRun: true, force: true })
    ).resolves.toBeUndefined();

    expect(applyAllComponents).toHaveBeenCalledWith(
      '/project',
      true,
      expect.objectContaining({ componentName: 'moz-card', persistState: false })
    );
  });

  it('refuses all-components deploy when overrides have baseVersion drift without --force', async () => {
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
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '147.0', product: 'firefox' },
    });

    await expect(furnaceDeployCommand('/project')).rejects.toThrow(/stale/i);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was created against Firefox'));
    expect(applyAllComponents).not.toHaveBeenCalled();
  });

  it('allows all-components deploy with --force despite baseVersion drift', async () => {
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
    vi.mocked(validateAllComponents).mockResolvedValue(new Map());
    vi.mocked(computeComponentChecksums).mockResolvedValue({});
    vi.mocked(prefixChecksums).mockReturnValue({});

    await expect(
      furnaceDeployCommand('/project', undefined, { force: true })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was created against Firefox'));
    expect(applyAllComponents).toHaveBeenCalled();
  });

  it('persists named-deploy state under the requested component name when apply succeeds', async () => {
    // Sanity-check the happy path that the new applied[0].name assertion
    // is designed to protect: when apply succeeds for the requested
    // component, persistence runs under that exact name. The negative
    // case (applied[0] for a *different* component) cannot be triggered
    // from outside the deploy module without monkey-patching its
    // internal accumulator — it is guarded by an `assert`-style throw in
    // getPersistableAppliedEntry that future refactors must not strip.
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
    // Pin Firefox version so baseVersion drift does not fire — earlier
    // tests in this file leave loadConfig set to 147.0, which would trip
    // the override-baseVersion preflight.
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test Browser',
      vendor: 'Test Vendor',
      appId: 'org.example.test',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    });
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [{ name: 'moz-card', type: 'override', filesAffected: ['moz-card.css'] }],
      skipped: [],
      errors: [],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'moz-card.css': 'hash' });
    vi.mocked(prefixChecksums).mockImplementation((_checks, type, name) => ({
      [`${type}/${name}/moz-card.css`]: 'hash',
    }));
    vi.mocked(validateComponent).mockResolvedValue([]);

    await expect(furnaceDeployCommand('/project', 'moz-card')).resolves.toBeUndefined();

    expect(updateFurnaceState).toHaveBeenCalledTimes(1);
    expect(prefixChecksums).toHaveBeenCalledWith(
      { 'moz-card.css': 'hash' },
      'override',
      'moz-card'
    );
  });
});
