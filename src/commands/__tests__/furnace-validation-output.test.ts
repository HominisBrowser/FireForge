// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../core/furnace-validate.js', () => ({
  validateAllComponents: vi.fn(),
  validateComponent: vi.fn(),
}));

vi.mock('../../core/furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

import { getFurnacePaths } from '../../core/furnace-config.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import type { FurnaceConfig, ValidationIssue } from '../../types/furnace.js';
import type { SpinnerHandle } from '../../utils/logger.js';
import { error, info, success, warn } from '../../utils/logger.js';
import { displayValidationIssues, runDeployValidation } from '../furnace/validation-output.js';

describe('displayValidationIssues', () => {
  it('returns [0, 0] for an empty list', () => {
    const [errors, warnings] = displayValidationIssues([]);
    expect(errors).toBe(0);
    expect(warnings).toBe(0);
  });

  it('counts errors and warnings separately', () => {
    const issues: ValidationIssue[] = [
      {
        component: 'moz-card',
        check: 'accessibility',
        severity: 'error',
        message: 'Missing ARIA role',
      },
      {
        component: 'moz-card',
        check: 'compatibility',
        severity: 'warning',
        message: 'Deprecated API',
      },
      { component: 'moz-button', check: 'structure', severity: 'error', message: 'Missing file' },
    ];

    const [errors, warnings] = displayValidationIssues(issues);

    expect(errors).toBe(2);
    expect(warnings).toBe(1);
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('formats error messages with component and check', () => {
    const issues: ValidationIssue[] = [
      { component: 'moz-card', check: 'structure', severity: 'error', message: 'CSS file missing' },
    ];

    displayValidationIssues(issues);

    expect(error).toHaveBeenCalledWith('moz-card: [structure] CSS file missing');
  });

  it('formats warning messages with component and check', () => {
    const issues: ValidationIssue[] = [
      {
        component: 'moz-button',
        check: 'compatibility',
        severity: 'warning',
        message: 'May break',
      },
    ];

    displayValidationIssues(issues);

    expect(warn).toHaveBeenCalledWith('moz-button: [compatibility] May break');
  });
});

describe('runDeployValidation', () => {
  const baseConfig: FurnaceConfig = {
    version: 1,
    componentPrefix: 'moz-',
    stock: ['moz-toggle'],
    overrides: {
      'moz-card': {
        type: 'css-only' as const,
        description: 'Override card',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
    },
    custom: {
      'moz-panel': {
        description: 'Custom panel',
        targetPath: 'toolkit/content/widgets/moz-panel',
        register: true,
        localized: false,
      },
    },
  };

  const furnacePaths = getFurnacePaths('/project');

  function makeSpinner(): SpinnerHandle {
    return {
      message: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
    } as unknown as SpinnerHandle;
  }

  it('skips validation for failed components', async () => {
    const spinner = makeSpinner();
    const result = await runDeployValidation(
      spinner,
      'moz-card',
      baseConfig,
      furnacePaths,
      new Set(['moz-card']),
      false,
      '/project'
    );

    expect(spinner.stop).toHaveBeenCalledWith('Validation skipped');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('apply failed'));
    expect(result).toEqual(expect.objectContaining({ done: false, skippedValidationCount: 1 }));
  });

  it('returns done: true for stock components', async () => {
    const spinner = makeSpinner();
    const result = await runDeployValidation(
      spinner,
      'moz-toggle',
      baseConfig,
      furnacePaths,
      new Set(),
      false,
      '/project'
    );

    expect(result).toEqual({ done: true });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('stock component'));
  });

  it('validates a single named override component', async () => {
    const spinner = makeSpinner();
    vi.mocked(validateComponent).mockResolvedValue([]);

    const result = await runDeployValidation(
      spinner,
      'moz-card',
      baseConfig,
      furnacePaths,
      new Set(),
      false,
      '/project'
    );

    expect(validateComponent).toHaveBeenCalledWith(
      expect.stringContaining('moz-card'),
      'moz-card',
      'override',
      baseConfig,
      '/project'
    );
    expect(success).toHaveBeenCalledWith('moz-card — all checks passed');
    expect(result).toEqual(
      expect.objectContaining({ done: false, totalErrors: 0, componentCount: 1 })
    );
  });

  it('validates all components when no name provided', async () => {
    const spinner = makeSpinner();
    const results = new Map<string, ValidationIssue[]>();
    results.set('moz-card', []);
    results.set('moz-panel', [
      { component: 'moz-panel', check: 'structure', severity: 'warning', message: 'Minor issue' },
    ]);
    vi.mocked(validateAllComponents).mockResolvedValue(results);

    const result = await runDeployValidation(
      spinner,
      undefined,
      baseConfig,
      furnacePaths,
      new Set(),
      false,
      '/project'
    );

    expect(validateAllComponents).toHaveBeenCalledWith('/project');
    expect(success).toHaveBeenCalledWith('moz-card — all checks passed');
    expect(result).toEqual(
      expect.objectContaining({
        done: false,
        totalErrors: 0,
        totalWarnings: 1,
        componentCount: 2,
      })
    );
  });

  it('throws for unknown component name', async () => {
    const spinner = makeSpinner();

    await expect(
      runDeployValidation(
        spinner,
        'unknown-widget',
        baseConfig,
        furnacePaths,
        new Set(),
        false,
        '/project'
      )
    ).rejects.toThrow('Component "unknown-widget" not found in furnace.json.');
  });
});
