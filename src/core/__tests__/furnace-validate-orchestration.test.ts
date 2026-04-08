// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAllComponents, validateComponent } from '../furnace-validate.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({
    configPath: '/project/furnace.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
  })),
  loadFurnaceConfig: vi.fn(),
}));

vi.mock('../furnace-validate-checks.js', () => ({
  validateStructure: vi.fn(() => []),
  validateAccessibility: vi.fn(() => []),
  validateCompatibility: vi.fn(() => []),
  validateTokenLink: vi.fn(() => []),
  validateRegistrationPatterns: vi.fn(() => []),
  validateJarMnEntries: vi.fn(() => []),
}));

import type { FurnaceConfig } from '../../types/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';
import {
  validateAccessibility,
  validateCompatibility,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateStructure,
  validateTokenLink,
} from '../furnace-validate-checks.js';

const mockPathExists = vi.mocked(pathExists);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockValidateStructure = vi.mocked(validateStructure);
const mockValidateAccessibility = vi.mocked(validateAccessibility);
const mockValidateCompatibility = vi.mocked(validateCompatibility);
const mockValidateTokenLink = vi.mocked(validateTokenLink);
const mockValidateRegistrationPatterns = vi.mocked(validateRegistrationPatterns);
const mockValidateJarMnEntries = vi.mocked(validateJarMnEntries);

beforeEach(() => {
  vi.clearAllMocks();
});

const baseConfig: FurnaceConfig = {
  version: 1,
  componentPrefix: 'moz-',
  tokenPrefix: '--brand-',
  tokenAllowlist: [],
  stock: [],
  overrides: {},
  custom: {},
};

describe('validateComponent', () => {
  it('runs structure, accessibility, and compatibility checks', async () => {
    await validateComponent('/comp/my-btn', 'my-btn', 'custom');

    expect(mockValidateStructure).toHaveBeenCalledWith('/comp/my-btn', 'my-btn', 'custom');
    expect(mockValidateAccessibility).toHaveBeenCalledWith('/comp/my-btn', 'my-btn');
    expect(mockValidateCompatibility).toHaveBeenCalledWith(
      '/comp/my-btn',
      'my-btn',
      'custom',
      undefined,
      undefined
    );
  });

  it('runs tokenLink check when root is provided', async () => {
    await validateComponent('/comp/my-btn', 'my-btn', 'custom', baseConfig, '/project');

    expect(mockValidateTokenLink).toHaveBeenCalledWith(
      '/comp/my-btn',
      'my-btn',
      '/project',
      '--brand-'
    );
  });

  it('skips tokenLink check when root is omitted', async () => {
    await validateComponent('/comp/my-btn', 'my-btn', 'custom');

    expect(mockValidateTokenLink).not.toHaveBeenCalled();
  });

  it('runs registration and jar.mn checks for registered custom components', async () => {
    const config: FurnaceConfig = {
      ...baseConfig,
      custom: {
        'my-btn': {
          description: 'Button',
          targetPath: 'toolkit/content/widgets/my-btn',
          register: true,
          localized: false,
        },
      },
    };

    await validateComponent('/comp/my-btn', 'my-btn', 'custom', config, '/project');

    expect(mockValidateRegistrationPatterns).toHaveBeenCalled();
    expect(mockValidateJarMnEntries).toHaveBeenCalled();
  });

  it('skips registration checks for override components', async () => {
    await validateComponent('/comp/my-btn', 'my-btn', 'override', baseConfig, '/project');

    expect(mockValidateRegistrationPatterns).not.toHaveBeenCalled();
    expect(mockValidateJarMnEntries).not.toHaveBeenCalled();
  });

  it('aggregates issues from all checks', async () => {
    mockValidateStructure.mockResolvedValueOnce([
      { component: 'c', severity: 'error', check: 'missing-mjs', message: 'No .mjs file' },
    ]);
    mockValidateAccessibility.mockResolvedValueOnce([
      { component: 'c', severity: 'warning', check: 'no-aria-role', message: 'Missing role' },
    ]);

    const issues = await validateComponent('/comp/c', 'c', 'custom');

    expect(issues).toHaveLength(2);
  });
});

describe('validateAllComponents', () => {
  it('validates override and custom components', async () => {
    const config: FurnaceConfig = {
      ...baseConfig,
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {
        'my-btn': {
          description: 'Button',
          targetPath: 'toolkit/content/widgets/my-btn',
          register: true,
          localized: false,
        },
      },
    };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);
    mockPathExists.mockResolvedValue(true);

    const results = await validateAllComponents('/project');

    expect(results.has('moz-card')).toBe(true);
    expect(results.has('my-btn')).toBe(true);
  });

  it('reports missing component directory', async () => {
    const config: FurnaceConfig = {
      ...baseConfig,
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
    };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);
    mockPathExists.mockResolvedValue(false);

    const results = await validateAllComponents('/project');
    const issues = results.get('moz-card') ?? [];

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-component-dir');
  });

  it('runs aggregate registration and jar.mn validation', async () => {
    const config: FurnaceConfig = { ...baseConfig };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);

    await validateAllComponents('/project');

    // Aggregate checks always run even with no components
    expect(mockValidateRegistrationPatterns).toHaveBeenCalledWith('/project', config);
    expect(mockValidateJarMnEntries).toHaveBeenCalledWith('/project', config);
  });

  it('merges aggregate registration issues into per-component results', async () => {
    const config: FurnaceConfig = {
      ...baseConfig,
      custom: {
        'my-btn': {
          description: 'Button',
          targetPath: 'toolkit/content/widgets/my-btn',
          register: true,
          localized: false,
        },
      },
    };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);
    mockPathExists.mockResolvedValue(true);
    mockValidateRegistrationPatterns.mockResolvedValueOnce([
      { component: 'my-btn', severity: 'error', check: 'wrong-pattern', message: 'Wrong block' },
    ]);

    const results = await validateAllComponents('/project');
    const issues = results.get('my-btn') ?? [];

    expect(issues.some((i) => i.check === 'wrong-pattern')).toBe(true);
  });

  it('creates new entry for registration issue on unknown component', async () => {
    const config: FurnaceConfig = { ...baseConfig };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);
    mockValidateRegistrationPatterns.mockResolvedValueOnce([
      { component: 'ghost', severity: 'error', check: 'wrong-pattern', message: 'Stale entry' },
    ]);

    const results = await validateAllComponents('/project');

    expect(results.has('ghost')).toBe(true);
    expect(results.get('ghost')?.[0]?.check).toBe('wrong-pattern');
  });

  it('merges aggregate jar.mn issues into per-component results', async () => {
    const config: FurnaceConfig = {
      ...baseConfig,
      custom: {
        'my-btn': {
          description: 'Button',
          targetPath: 'toolkit/content/widgets/my-btn',
          register: true,
          localized: false,
        },
      },
    };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);
    mockPathExists.mockResolvedValue(true);
    mockValidateJarMnEntries.mockResolvedValueOnce([
      { component: 'my-btn', severity: 'error', check: 'missing-jar-mn-mjs', message: 'No mjs' },
    ]);

    const results = await validateAllComponents('/project');
    const issues = results.get('my-btn') ?? [];

    expect(issues.some((i) => i.check === 'missing-jar-mn-mjs')).toBe(true);
  });

  it('creates new entry for jar.mn issue on unknown component', async () => {
    const config: FurnaceConfig = { ...baseConfig };
    mockLoadFurnaceConfig.mockResolvedValueOnce(config);
    mockValidateJarMnEntries.mockResolvedValueOnce([
      { component: 'phantom', severity: 'error', check: 'missing-jar-mn-mjs', message: 'Gone' },
    ]);

    const results = await validateAllComponents('/project');

    expect(results.has('phantom')).toBe(true);
    expect(results.get('phantom')?.[0]?.check).toBe('missing-jar-mn-mjs');
  });
});
