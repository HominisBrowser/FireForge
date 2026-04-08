// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../branding.js', () => ({
  setupBranding: vi.fn(),
  isBrandingSetup: vi.fn(),
}));

vi.mock('../furnace-stories.js', () => ({
  cleanStories: vi.fn(),
}));

vi.mock('../mach.js', () => ({
  generateMozconfig: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(),
  loadFurnaceConfig: vi.fn(),
}));

vi.mock('../furnace-apply.js', () => ({
  applyAllComponents: vi.fn(),
}));

import type { FireForgeConfig, ProjectPaths } from '../../types/config.js';
import { spinner, warn } from '../../utils/logger.js';
import { isBrandingSetup, setupBranding } from '../branding.js';
import { prepareBuildEnvironment } from '../build-prepare.js';
import { applyAllComponents } from '../furnace-apply.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../furnace-config.js';
import { cleanStories } from '../furnace-stories.js';
import { generateMozconfig } from '../mach.js';

const mockCleanStories = vi.mocked(cleanStories);
const mockIsBrandingSetup = vi.mocked(isBrandingSetup);
const mockSetupBranding = vi.mocked(setupBranding);
const mockGenerateMozconfig = vi.mocked(generateMozconfig);
const mockFurnaceConfigExists = vi.mocked(furnaceConfigExists);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockApplyAllComponents = vi.mocked(applyAllComponents);
const mockWarn = vi.mocked(warn);
const mockSpinner = vi.mocked(spinner);

const paths: ProjectPaths = {
  root: '/project',
  config: '/project/fireforge.json',
  fireforgeDir: '/project/.fireforge',
  state: '/project/.fireforge/state.json',
  engine: '/project/engine',
  configs: '/project/configs',
  patches: '/project/patches',
  src: '/project/src',
  componentsDir: '/project/src/components',
};

const config = {
  name: 'TestBrowser',
  vendor: 'TestVendor',
  appId: 'test.browser',
  binaryName: 'testbrowser',
} as FireForgeConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBrandingSetup.mockResolvedValue(true);
  mockFurnaceConfigExists.mockResolvedValue(false);
  mockGenerateMozconfig.mockResolvedValue(undefined);
  mockCleanStories.mockResolvedValue(0);
  mockSpinner.mockReturnValue({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  });
});

describe('prepareBuildEnvironment', () => {
  it('calls cleanStories first', async () => {
    await prepareBuildEnvironment('/project', paths, config);
    expect(mockCleanStories).toHaveBeenCalledWith('/project/engine');
  });

  it('sets up branding when not already configured', async () => {
    mockIsBrandingSetup.mockResolvedValue(false);

    await prepareBuildEnvironment('/project', paths, config);
    expect(mockSetupBranding).toHaveBeenCalledWith('/project/engine', {
      name: 'TestBrowser',
      vendor: 'TestVendor',
      appId: 'test.browser',
      binaryName: 'testbrowser',
    });
  });

  it('skips branding setup when already configured', async () => {
    mockIsBrandingSetup.mockResolvedValue(true);

    await prepareBuildEnvironment('/project', paths, config);
    expect(mockSetupBranding).not.toHaveBeenCalled();
  });

  it('applies Furnace components when furnace.json exists with components', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: { 'moz-button': {} },
      custom: {},
      stock: [],
    } as never);
    mockApplyAllComponents.mockResolvedValue({
      applied: [{ name: 'moz-button' }],
      errors: [],
      skipped: [],
    } as never);

    const result = await prepareBuildEnvironment('/project', paths, config);
    expect(result.furnaceApplied).toBe(1);
    expect(mockApplyAllComponents).toHaveBeenCalledWith('/project');
  });

  it('skips Furnace when furnace.json does not exist', async () => {
    mockFurnaceConfigExists.mockResolvedValue(false);

    const result = await prepareBuildEnvironment('/project', paths, config);
    expect(result.furnaceApplied).toBe(0);
    expect(mockApplyAllComponents).not.toHaveBeenCalled();
  });

  it('propagates error when applyAllComponents throws', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: { 'moz-button': {} },
      custom: {},
      stock: [],
    } as never);
    mockApplyAllComponents.mockRejectedValue(new Error('apply failed'));

    await expect(prepareBuildEnvironment('/project', paths, config)).rejects.toThrow(
      'apply failed'
    );
  });

  it('always calls generateMozconfig', async () => {
    await prepareBuildEnvironment('/project', paths, config);
    expect(mockGenerateMozconfig).toHaveBeenCalledWith(
      '/project/configs',
      '/project/engine',
      config
    );
  });

  it('propagates error when generateMozconfig throws', async () => {
    mockGenerateMozconfig.mockRejectedValue(new Error('mozconfig failed'));

    await expect(prepareBuildEnvironment('/project', paths, config)).rejects.toThrow(
      'mozconfig failed'
    );
  });

  it('returns furnaceApplied: 0 when config has no components', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: {},
      custom: {},
      stock: [],
    } as never);

    const result = await prepareBuildEnvironment('/project', paths, config);
    expect(result.furnaceApplied).toBe(0);
  });

  it('shows "Components up to date" when 0 applied but components exist', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: { 'moz-button': {} },
      custom: {},
      stock: [],
    } as never);
    mockApplyAllComponents.mockResolvedValue({
      applied: [],
      errors: [],
      skipped: [],
    } as never);

    const result = await prepareBuildEnvironment('/project', paths, config);
    expect(result.furnaceApplied).toBe(0);
    // The second spinner call (index 1) is the Furnace spinner
    const furnaceSpinner = mockSpinner.mock.results[1]?.value as
      | { stop: ReturnType<typeof vi.fn> }
      | undefined;
    expect(furnaceSpinner?.stop).toHaveBeenCalledWith('Components up to date');
  });

  it('warns for each error in applyAllComponents result', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: { 'moz-button': {} },
      custom: {},
      stock: [],
    } as never);
    mockApplyAllComponents.mockResolvedValue({
      applied: [],
      errors: [
        { name: 'comp-a', error: 'copy failed' },
        { name: 'comp-b', error: 'missing dir' },
      ],
      skipped: [],
    } as never);

    await prepareBuildEnvironment('/project', paths, config);
    expect(mockWarn).toHaveBeenCalledWith('Furnace: comp-a \u2014 copy failed');
    expect(mockWarn).toHaveBeenCalledWith('Furnace: comp-b \u2014 missing dir');
  });

  it('warns for stepErrors on applied components', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: { 'moz-button': {} },
      custom: {},
      stock: [],
    } as never);
    mockApplyAllComponents.mockResolvedValue({
      applied: [
        {
          name: 'moz-button',
          stepErrors: [{ step: 'register', error: 'pattern mismatch' }],
        },
      ],
      errors: [],
      skipped: [],
    } as never);

    await prepareBuildEnvironment('/project', paths, config);
    expect(mockWarn).toHaveBeenCalledWith('Furnace: moz-button [register] pattern mismatch');
  });
});
