// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nativePath } from '../../test-utils/index.js';
import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    config: nativePath('/project/fireforge.json'),
    fireforgeDir: nativePath('/project/.fireforge'),
    state: nativePath('/project/.fireforge/state.json'),
    engine: nativePath('/project/engine'),
    patches: nativePath('/project/patches'),
    configs: nativePath('/project/configs'),
    src: nativePath('/project/src'),
    componentsDir: nativePath('/project/components'),
  })),
}));

vi.mock('../../core/furnace-registration.js', () => ({
  addJarMnEntries: vi.fn(() => Promise.resolve()),
  addCustomElementRegistration: vi.fn(() => Promise.resolve()),
  pruneStaleJarMnEntries: vi.fn(() => Promise.resolve([])),
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

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { readdir } from 'node:fs/promises';

import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  pruneStaleJarMnEntries,
} from '../../core/furnace-registration.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import type { ValidationIssue } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, intro, note, outro, success, warn } from '../../utils/logger.js';
import { furnaceValidateCommand } from '../furnace/validate.js';

describe('furnaceValidateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to "all entries were new"; tests that simulate an idempotent
    // no-op (jar.mn already has the entries) override this to 0.
    vi.mocked(addJarMnEntries).mockImplementation((_engine, _name, files) =>
      Promise.resolve(files.length)
    );
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
      nativePath('/project/components/overrides/moz-card'),
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
      nativePath('/project/components/custom/moz-sidebar'),
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

  it('refuses when the engine checkout is missing (the rung validate lacked)', async () => {
    // `furnace validate` was the one command in the family that checked
    // furnace.json alone. Against a missing engine it produced downstream
    // noise instead of the family's shared precondition refusal.
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(furnaceValidateCommand('/project', 'moz-card')).rejects.toThrow(
      /Engine directory not found/i
    );

    expect(validateComponent).not.toHaveBeenCalled();
  });

  it('throws when a named component directory does not exist on disk', async () => {
    // Engine present (first pathExists call, from the shared furnace
    // precondition), component directory absent.
    vi.mocked(pathExists).mockResolvedValueOnce(true).mockResolvedValue(false);

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

    const staleJarIssue = (component: string): ValidationIssue => ({
      component,
      check: 'stale-jar-registration',
      severity: 'error',
      message: `jar.mn registers old-helper.mjs for ${component}, but the source file no longer exists`,
    });

    it('prunes stale jar.mn registrations with --fix', async () => {
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([staleJarIssue('moz-sidebar')])
        .mockResolvedValueOnce([]);
      vi.mocked(pruneStaleJarMnEntries).mockResolvedValueOnce([
        {
          tagName: 'moz-sidebar',
          fileName: 'old-helper.mjs',
          line: 'content/global/elements/old-helper.mjs  (widgets/moz-sidebar/old-helper.mjs)',
        },
      ]);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();

      expect(pruneStaleJarMnEntries).toHaveBeenCalledWith(
        nativePath('/project/engine'),
        nativePath('/project/components/custom'),
        ['moz-sidebar']
      );
      expect(info).toHaveBeenCalledWith(
        'Fixed: pruned stale jar.mn line for moz-sidebar/old-helper.mjs'
      );
    });

    it('warns when pruning stale jar.mn lines fails', async () => {
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([staleJarIssue('moz-sidebar')])
        .mockResolvedValueOnce([staleJarIssue('moz-sidebar')]);
      vi.mocked(pruneStaleJarMnEntries).mockRejectedValueOnce(new Error('jar.mn is read-only'));

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not prune stale jar.mn lines: jar.mn is read-only')
      );
    });

    it('stringifies a non-Error prune failure', async () => {
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([staleJarIssue('moz-sidebar')])
        .mockResolvedValueOnce([staleJarIssue('moz-sidebar')]);
      vi.mocked(pruneStaleJarMnEntries).mockRejectedValueOnce('disk detached');

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not prune stale jar.mn lines: disk detached')
      );
    });

    it('skips fixable issues for components not present in furnace.json custom', async () => {
      // A fixable check id whose component is unknown (e.g. removed from
      // furnace.json between validate and --fix) is skipped rather than
      // crashing the fix pass; re-validation also skips the unknown
      // component, so the run completes without a write.
      vi.mocked(validateComponent).mockResolvedValueOnce([mjsIssue('moz-ghost')]);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();

      expect(addJarMnEntries).not.toHaveBeenCalled();
    });

    it('auto-fixes jar.mn mjs issues and reports fixed count from a true re-validation', async () => {
      // Initial validation surfaces the fixable issue; re-validation after
      // the fix returns no issues, which is what justifies the "Auto-fixed"
      // count. The fix counter is now derived from the *real* drop in
      // fixable issues, not from autoFixIssues' return value.
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([mjsIssue('moz-sidebar')])
        .mockResolvedValueOnce([]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();

      expect(addJarMnEntries).toHaveBeenCalledWith(nativePath('/project/engine'), 'moz-sidebar', [
        'moz-sidebar.mjs',
      ]);
      expect(info).toHaveBeenCalledWith('Fixed: added moz-sidebar.mjs to jar.mn for moz-sidebar');
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 1 issue(s).');
      expect(outro).toHaveBeenCalledWith('Validation passed');
    });

    it('warns when an auto-fix attempt did not actually clear the fixable issue', async () => {
      // autoFixIssues returns a positive number, but the underlying issue
      // remains on re-validation. The user must learn that the reported
      // fix did not actually land — the previous behaviour silently
      // inflated the fixed count.
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([mjsIssue('moz-sidebar')])
        .mockResolvedValueOnce([mjsIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Auto-fixed'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('1 fixable issue(s) remain after auto-fix')
      );
    });

    it('auto-fixes jar.mn css issues', async () => {
      vi.mocked(validateComponent).mockResolvedValue([cssIssue('moz-sidebar')]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addJarMnEntries).toHaveBeenCalledWith(nativePath('/project/engine'), 'moz-sidebar', [
        'moz-sidebar.css',
      ]);
    });

    it('batches multiple jar.mn issues for the same component', async () => {
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([mjsIssue('moz-sidebar'), cssIssue('moz-sidebar')])
        .mockResolvedValueOnce([]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();

      expect(addJarMnEntries).toHaveBeenCalledWith(nativePath('/project/engine'), 'moz-sidebar', [
        'moz-sidebar.mjs',
        'moz-sidebar.css',
      ]);
      expect(info).toHaveBeenCalledWith(
        'Fixed: added moz-sidebar.mjs, moz-sidebar.css to jar.mn for moz-sidebar'
      );
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 2 issue(s).');
    });

    it('logs a no-op line when jar.mn entries were already present', async () => {
      // `addJarMnEntries` returns 0 when every requested entry was already
      // on disk. The caller must not claim "Fixed: …" — that would lie to
      // the user — but it must still report the honest outcome.
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([mjsIssue('moz-sidebar')])
        .mockResolvedValueOnce([]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);
      vi.mocked(addJarMnEntries).mockResolvedValueOnce(0);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(
        'No-op: jar.mn entries for moz-sidebar were already present'
      );
      expect(info).not.toHaveBeenCalledWith(
        expect.stringContaining('Fixed: added moz-sidebar.mjs')
      );
    });

    it('counts warning-severity issues separately from errors during re-validation', async () => {
      // Exercises the post-fix re-validation branch that classifies each
      // remaining issue by severity. A warning-only residue must NOT be
      // counted as an error and must NOT cause the command to reject.
      const warningIssue: ValidationIssue = {
        component: 'moz-sidebar',
        check: 'non-fixable-observation',
        message: 'residual warning',
        severity: 'warning',
      };
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([mjsIssue('moz-sidebar')])
        .mockResolvedValueOnce([warningIssue]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 1 issue(s).');
      expect(outro).toHaveBeenCalledWith('Validation passed');
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
        nativePath('/project/engine'),
        'moz-sidebar',
        'chrome://global/content/elements/moz-sidebar.mjs'
      );
    });

    it('does not register components absent from the issue list', async () => {
      // Iterating every entry in `config.custom` makes
      // `furnace validate <one> --fix` write customElements.js
      // registrations for EVERY custom component — outside the issue list it
      // was handed, and invisibly, since `fixed` is never incremented there.
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-sidebar': { description: 'a', targetPath: 'a', register: true, localized: false },
          'moz-untouched': { description: 'b', targetPath: 'b', register: true, localized: false },
        },
      } as never);
      vi.mocked(validateComponent).mockResolvedValue([mjsIssue('moz-sidebar')]);
      vi.mocked(readdir).mockImplementation(((dir: unknown) =>
        Promise.resolve([
          mockDirent(
            String(dir).includes('moz-untouched') ? 'moz-untouched.mjs' : 'moz-sidebar.mjs'
          ),
        ])) as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).rejects.toThrow(/Validation failed/i);

      expect(addCustomElementRegistration).toHaveBeenCalledWith(
        nativePath('/project/engine'),
        'moz-sidebar',
        expect.any(String)
      );
      expect(addCustomElementRegistration).not.toHaveBeenCalledWith(
        expect.any(String),
        'moz-untouched',
        expect.any(String)
      );
    });

    it('repairs a registration-only defect via missing-custom-element-registration', async () => {
      // The defect the scoped repair loop exists for: a component whose ONLY
      // issue is that customElements.js never mentions it. Scoping --fix to
      // the issue list removed the old (over-broad) path that repaired this;
      // the new validate check is what routes it back into FIXABLE_CHECKS.
      const missingRegIssue: ValidationIssue = {
        component: 'moz-sidebar',
        check: 'missing-custom-element-registration',
        severity: 'error',
        message: 'moz-sidebar has register: true but no registration in customElements.js',
      };
      vi.mocked(validateComponent)
        .mockResolvedValueOnce([missingRegIssue])
        .mockResolvedValueOnce([]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', 'moz-sidebar', { fix: true })
      ).resolves.toBeUndefined();

      expect(addCustomElementRegistration).toHaveBeenCalledWith(
        nativePath('/project/engine'),
        'moz-sidebar',
        'chrome://global/content/elements/moz-sidebar.mjs'
      );
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Auto-fixed 1 issue(s)'));
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
      // First call: engine check in the shared furnace precondition (true)
      // Second call: component dir check in main command (true)
      // Third call: component dir check in autoFixIssues (false)
      vi.mocked(pathExists)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

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
      // Re-validation pass uses validateComponent per component; return
      // empty so the actual fixed-count is honest.
      vi.mocked(validateComponent).mockResolvedValueOnce([]);
      vi.mocked(readdir).mockResolvedValue([mockDirent('moz-sidebar.mjs')] as never);

      await expect(
        furnaceValidateCommand('/project', undefined, { fix: true })
      ).resolves.toBeUndefined();

      expect(addJarMnEntries).toHaveBeenCalledWith(nativePath('/project/engine'), 'moz-sidebar', [
        'moz-sidebar.mjs',
      ]);
      expect(info).toHaveBeenCalledWith('\nAuto-fixed 1 issue(s).');
    });
  });
});
