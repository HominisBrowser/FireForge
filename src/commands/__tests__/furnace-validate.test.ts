// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      stock: ['moz-button'],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    })
  ),
}));

vi.mock('../../core/furnace-validate.js', () => ({
  validateAllComponents: vi.fn(),
  validateComponent: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  error: vi.fn(),
  info: vi.fn(),
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, note, outro, success, warn } from '../../utils/logger.js';
import { furnaceValidateCommand } from '../furnace/validate.js';

describe('furnaceValidateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('fails when furnace is not configured', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);

    await expect(furnaceValidateCommand('/project')).rejects.toThrow(/No furnace\.json found/i);

    expect(intro).toHaveBeenCalledWith('Furnace Validate');
    expect(validateAllComponents).not.toHaveBeenCalled();
  });

  it('returns early for stock-only component validation requests', async () => {
    await furnaceValidateCommand('/project', 'moz-button');

    expect(info).toHaveBeenCalledWith(
      '"moz-button" is a stock component. Stock components are not validated locally.'
    );
    expect(outro).toHaveBeenCalledWith('Validation complete');
    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('reports a successful single-component validation run', async () => {
    vi.mocked(validateComponent).mockResolvedValue([]);

    await furnaceValidateCommand('/project', 'moz-card');

    expect(validateComponent).toHaveBeenCalledWith(
      '/project/components/overrides/moz-card',
      'moz-card',
      'override',
      expect.any(Object),
      '/project'
    );
    expect(success).toHaveBeenCalledWith('moz-card — all checks passed');
    expect(note).toHaveBeenCalledWith(
      '0 error(s), 0 warning(s) across 1 component(s)',
      'Validation Summary'
    );
    expect(outro).toHaveBeenCalledWith('Validation passed');
  });

  it('validates custom components from the custom directory', async () => {
    vi.mocked(validateComponent).mockResolvedValue([]);

    await furnaceValidateCommand('/project', 'moz-sidebar');

    expect(validateComponent).toHaveBeenCalledWith(
      '/project/components/custom/moz-sidebar',
      'moz-sidebar',
      'custom',
      expect.any(Object),
      '/project'
    );
    expect(success).toHaveBeenCalledWith('moz-sidebar — all checks passed');
  });

  it('throws when a named component is not present in furnace.json', async () => {
    await expect(furnaceValidateCommand('/project', 'moz-missing')).rejects.toThrow(
      /Component "moz-missing" not found in furnace\.json/i
    );

    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('throws when a named component directory does not exist on disk', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(furnaceValidateCommand('/project', 'moz-card')).rejects.toThrow(
      /Component directory not found/i
    );

    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('returns early when there are no override or custom components to validate', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });

    await furnaceValidateCommand('/project');

    expect(info).toHaveBeenCalledWith('No components to validate.');
    expect(outro).toHaveBeenCalledWith('Done');
    expect(validateAllComponents).not.toHaveBeenCalled();
  });

  it('reports successful all-component validation without stock-component skip messaging', async () => {
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
      custom: {
        'moz-sidebar': {
          description: 'Custom sidebar',
          targetPath: 'browser/components/sidebar',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(validateAllComponents).mockResolvedValue(
      new Map([
        ['moz-card', []],
        [
          'moz-sidebar',
          [
            {
              component: 'moz-sidebar',
              check: 'a11y',
              severity: 'warning',
              message: 'Missing keyboard handler',
            },
          ],
        ],
      ])
    );

    await furnaceValidateCommand('/project');

    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('stock component(s)'));
    expect(success).toHaveBeenCalledWith('moz-card — all checks passed');
    expect(warn).toHaveBeenCalledWith('moz-sidebar: [a11y] Missing keyboard handler');
    expect(note).toHaveBeenCalledWith(
      '0 error(s), 1 warning(s) across 2 component(s)',
      'Validation Summary'
    );
    expect(outro).toHaveBeenCalledWith('Validation passed');
  });

  it('reports mixed validation results and throws when any errors are present', async () => {
    vi.mocked(validateAllComponents).mockResolvedValue(
      new Map([
        [
          'moz-card',
          [
            {
              component: 'moz-card',
              check: 'registration',
              severity: 'error',
              message: 'Missing customElements registration',
            },
          ],
        ],
        [
          'moz-sidebar',
          [
            {
              component: 'moz-sidebar',
              check: 'a11y',
              severity: 'warning',
              message: 'Missing keyboard handler',
            },
          ],
        ],
      ])
    );

    await expect(furnaceValidateCommand('/project')).rejects.toThrow(
      /Validation failed with 1 error/i
    );

    expect(info).toHaveBeenCalledWith(
      'Skipping 1 stock component(s) (no local files to validate).'
    );
    expect(error).toHaveBeenCalledWith(
      'moz-card: [registration] Missing customElements registration'
    );
    expect(warn).toHaveBeenCalledWith('moz-sidebar: [a11y] Missing keyboard handler');
    expect(note).toHaveBeenCalledWith(
      '1 error(s), 1 warning(s) across 2 component(s)',
      'Validation Summary'
    );
    expect(info).toHaveBeenCalledWith(
      'Fix the errors above and run "fireforge furnace validate" again.'
    );
    expect(outro).not.toHaveBeenCalled();
  });
});
