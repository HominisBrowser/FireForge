// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    engine: '/project/engine',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../../core/furnace-registration.js', () => ({
  addJarMnEntries: vi.fn(() => Promise.resolve()),
  addCustomElementRegistration: vi.fn(() => Promise.resolve()),
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

import { readdir } from 'node:fs/promises';

import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { addCustomElementRegistration, addJarMnEntries } from '../../core/furnace-registration.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import type { ValidationIssue } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, note, outro, success, warn } from '../../utils/logger.js';
import { furnaceValidateCommand } from '../furnace/validate.js';

describe('furnaceValidateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addJarMnEntries).mockResolvedValue(undefined);
    vi.mocked(addCustomElementRegistration).mockResolvedValue(undefined);
    vi.mocked(readdir).mockResolvedValue([]);
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
      'Fix the errors above and run "fireforge furnace validate" again. Use --fix to auto-correct registration issues.'
    );
    expect(outro).not.toHaveBeenCalled();
  });

  describe('--fix option', () => {
    const mjsIssue = (component: string): ValidationIssue => ({
      component,
      check: 'missing-jar-mn-mjs',
      severity: 'error',
      message: `Missing ${component}.mjs in jar.mn`,
    });

    const cssIssue = (component: string): ValidationIssue => ({
      component,
      check: 'missing-jar-mn-css',
      severity: 'error',
      message: `Missing ${component}.css in jar.mn`,
    });

    const nonFixableIssue = (component: string): ValidationIssue => ({
      component,
      check: 'a11y',
      severity: 'error',
      message: 'Non-fixable issue',
    });

    const wrongRegIssue = (component: string): ValidationIssue => ({
      component,
      check: 'wrong-registration-pattern',
      severity: 'error',
      message: 'Wrong registration pattern',
    });

    const mockDirent = (name: string): import('node:fs').Dirent => ({
      isFile: () => true,
      isDirectory: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
      name,
      parentPath: '',
    });

    it('auto-fixes jar.mn mjs issues and reports fixed count', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-sidebar', [
        'moz-sidebar.mjs',
      ]);
      expect(info).toHaveBeenCalledWith('Fixed: added moz-sidebar.mjs to jar.mn for moz-sidebar');
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 1 issue(s). Re-run validate to confirm.');
      // With --fix, no fixHint appended
      expect(info).toHaveBeenCalledWith(
        'Fix the errors above and run "fireforge furnace validate" again.'
      );
    });

    it('auto-fixes jar.mn css issues', async () => {
      vi.mocked(validateComponent).mockResolvedValue([cssIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-sidebar', [
        'moz-sidebar.css',
      ]);
    });

    it('batches multiple jar.mn issues for the same component', async () => {
      vi.mocked(validateComponent).mockResolvedValue([
        mjsIssue('moz-sidebar'),
        cssIssue('moz-sidebar'),
      ]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-sidebar', [
        'moz-sidebar.mjs',
        'moz-sidebar.css',
      ]);
      expect(info).toHaveBeenCalledWith(
        'Fixed: added moz-sidebar.mjs, moz-sidebar.css to jar.mn for moz-sidebar'
      );
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 2 issue(s). Re-run validate to confirm.');
    });

    it('warns when addJarMnEntries throws and does not count as fixed', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      vi.mocked(addJarMnEntries).mockRejectedValue(new Error('Permission denied'));
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(warn).toHaveBeenCalledWith('Could not fix jar.mn for moz-sidebar: Permission denied');
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Auto-fixed'));
    });

    it('reports manual resolution when no fixable issues exist', async () => {
      vi.mocked(validateComponent).mockResolvedValue([nonFixableIssue('moz-sidebar')]);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(info).toHaveBeenCalledWith(
        '\nNo auto-fixable issues found. Remaining issues require manual resolution.'
      );
      expect(addJarMnEntries).not.toHaveBeenCalled();
    });

    it('skips jar.mn fix for components not in config.custom', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-card')]);

      await expect(furnaceValidateCommand('/project', 'moz-card', { fix: true })).rejects.toThrow(
        /Validation failed/i
      );

      // moz-card is in overrides, not custom — autoFixIssues skips it
      expect(addJarMnEntries).not.toHaveBeenCalled();
    });

    it('calls addCustomElementRegistration for components with register:true and .mjs', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addCustomElementRegistration).toHaveBeenCalledWith(
        '/project/engine',
        'moz-sidebar',
        'chrome://global/content/elements/moz-sidebar.mjs'
      );
    });

    it('skips customElements registration when register is false', async () => {
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
            register: false,
            localized: false,
          },
        },
      });
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addCustomElementRegistration).not.toHaveBeenCalled();
    });

    it('skips customElements registration when component directory does not exist', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      // First call: component dir check in main command (true)
      // Second call: component dir check in autoFixIssues (false)
      vi.mocked(pathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(readdir).not.toHaveBeenCalled();
      expect(addCustomElementRegistration).not.toHaveBeenCalled();
    });

    it('skips customElements registration when no .mjs file exists', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.css')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addCustomElementRegistration).not.toHaveBeenCalled();
    });

    it('silently ignores addCustomElementRegistration errors', async () => {
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);
      vi.mocked(addCustomElementRegistration).mockRejectedValue(new Error('registration error'));

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      // Should not warn about the registration error (silent catch)
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('registration error'));
    });

    it('does not trigger auto-fix when there are no issues', async () => {
      vi.mocked(validateComponent).mockResolvedValue([]);

      await furnaceValidateCommand('/project', 'moz-sidebar', { fix: true });

      expect(addJarMnEntries).not.toHaveBeenCalled();
      expect(addCustomElementRegistration).not.toHaveBeenCalled();
      expect(outro).toHaveBeenCalledWith('Validation passed');
    });

    it('handles wrong-registration-pattern issues as fixable but does not fix them', async () => {
      vi.mocked(validateComponent).mockResolvedValue([wrongRegIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      // wrong-registration-pattern is in FIXABLE_CHECKS so autoFixIssues is called,
      // but the actual loop is a no-op — no jar.mn entries added
      expect(addJarMnEntries).not.toHaveBeenCalled();
      // fixedCount stays 0, so no "Auto-fixed" message
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Auto-fixed'));
    });

    it('works with all-components mode and --fix', async () => {
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
      vi.mocked(validateAllComponents).mockResolvedValue(
        new Map([['moz-sidebar', [mjsIssue('moz-sidebar')]]])
      );
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(furnaceValidateCommand('/project', undefined, { fix: true })).rejects.toThrow(
        /Validation failed/i
      );

      expect(addJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-sidebar', [
        'moz-sidebar.mjs',
      ]);
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 1 issue(s). Re-run validate to confirm.');
    });
  });
});
