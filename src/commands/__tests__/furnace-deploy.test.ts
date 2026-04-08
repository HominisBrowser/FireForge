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
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(() => Promise.resolve()),
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

import {
  applyAllComponents,
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  prefixChecksums,
} from '../../core/furnace-apply.js';
import { loadFurnaceConfig, updateFurnaceState } from '../../core/furnace-config.js';
import { restoreRollbackJournalOrThrow } from '../../core/furnace-rollback.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { pathExists } from '../../utils/fs.js';
import { info, success, warn } from '../../utils/logger.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';

describe('furnaceDeployCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('skips validation noise when the selected component fails apply', async () => {
    vi.mocked(applyOverrideComponent).mockRejectedValue(new Error('apply state mismatch'));

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

    expect(applyAllComponents).toHaveBeenCalledWith('/project', false);
    expect(validateAllComponents).toHaveBeenCalledWith('/project');
    expect(vi.mocked(success)).toHaveBeenCalled();
  });

  it('deploys a single override component', async () => {
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.css'],
      actions: [],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'a.css': 'abc' });
    vi.mocked(prefixChecksums).mockReturnValue({ 'override:moz-card:a.css': 'abc' });

    await expect(furnaceDeployCommand('/project', 'moz-card')).resolves.toBeUndefined();

    expect(applyOverrideComponent).toHaveBeenCalled();
    expect(updateFurnaceState).toHaveBeenCalled();
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
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['sidebar.mjs'],
      stepErrors: [],
      actions: [],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);
    vi.mocked(computeComponentChecksums).mockResolvedValue({});
    vi.mocked(prefixChecksums).mockReturnValue({});

    await expect(furnaceDeployCommand('/project', 'moz-sidebar')).resolves.toBeUndefined();

    expect(applyCustomComponent).toHaveBeenCalled();
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
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['sidebar.mjs'],
      stepErrors: [{ step: 'register', error: 'customElements.js missing' }],
      actions: [],
    });

    await expect(furnaceDeployCommand('/project', 'moz-sidebar')).rejects.toThrow(
      /apply error\(s\)/i
    );

    expect(restoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      expect.any(Object),
      'Furnace deploy failed for "moz-sidebar"'
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
    vi.mocked(applyOverrideComponent).mockRejectedValue(new Error('copy failed'));

    await expect(furnaceDeployCommand('/project', 'moz-card')).rejects.toThrow(/apply error\(s\)/i);

    expect(restoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      expect.any(Object),
      'Furnace deploy failed for "moz-card"'
    );
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

    expect(applyOverrideComponent).not.toHaveBeenCalled();
    expect(applyCustomComponent).not.toHaveBeenCalled();
    expect(validateComponent).not.toHaveBeenCalled();
    expect(vi.mocked(info)).toHaveBeenCalledWith(
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
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['a.css'],
      actions: [{ action: 'copy', component: 'moz-card', description: 'Copy CSS' }],
    });
    vi.mocked(validateComponent).mockResolvedValue([]);

    await expect(
      furnaceDeployCommand('/project', 'moz-card', { dryRun: true })
    ).resolves.toBeUndefined();

    expect(updateFurnaceState).not.toHaveBeenCalled();
  });
});
