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
  runMach: vi.fn(),
}));

vi.mock('../git-base.js', () => ({
  git: vi.fn(),
}));

vi.mock('../git.js', () => ({
  hasChanges: vi.fn(),
  isMissingHeadError: vi.fn(() => false),
}));

vi.mock('../git-status.js', () => ({
  getUntrackedFiles: vi.fn(() => Promise.resolve([] as string[])),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(),
  loadFurnaceConfig: vi.fn(),
  loadFurnaceState: vi.fn(),
  getFurnacePaths: vi.fn(() => ({
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../furnace-apply.js', () => ({
  applyAllComponents: vi.fn(),
}));

vi.mock('../furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (_root: string, _kind: string, body: (ctx: unknown) => Promise<unknown>) =>
      body({
        registerJournal: vi.fn(),
        registerCleanup: vi.fn(),
      })
  ),
}));

import type { FireForgeConfig, ProjectPaths } from '../../types/config.js';
import { pathExists } from '../../utils/fs.js';
import { info, spinner, warn } from '../../utils/logger.js';
import { isBrandingSetup, setupBranding } from '../branding.js';
import { prepareBuildEnvironment } from '../build-prepare.js';
import { applyAllComponents } from '../furnace-apply.js';
import { furnaceConfigExists, loadFurnaceConfig, loadFurnaceState } from '../furnace-config.js';
import { runFurnaceMutation } from '../furnace-operation.js';
import { cleanStories } from '../furnace-stories.js';
import { generateMozconfig } from '../mach.js';

const mockCleanStories = vi.mocked(cleanStories);
const mockIsBrandingSetup = vi.mocked(isBrandingSetup);
const mockSetupBranding = vi.mocked(setupBranding);
const mockGenerateMozconfig = vi.mocked(generateMozconfig);
const mockFurnaceConfigExists = vi.mocked(furnaceConfigExists);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockLoadFurnaceState = vi.mocked(loadFurnaceState);
const mockApplyAllComponents = vi.mocked(applyAllComponents);
const mockRunFurnaceMutation = vi.mocked(runFurnaceMutation);
const mockPathExists = vi.mocked(pathExists);
const mockWarn = vi.mocked(warn);
const mockInfo = vi.mocked(info);
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
  mockPathExists.mockResolvedValue(false);
  mockLoadFurnaceState.mockResolvedValue({} as never);
  mockSpinner.mockReturnValue({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  });
});

describe('prepareBuildEnvironment', () => {
  it('blocks build when pendingRepair marker exists', async () => {
    mockPathExists.mockResolvedValue(true);
    mockLoadFurnaceState.mockResolvedValue({
      pendingRepair: {
        operation: 'preview-teardown',
        timestamp: '2025-01-01T00:00:00Z',
        reason: 'rollback failed',
      },
    } as never);

    await expect(prepareBuildEnvironment('/project', paths, config)).rejects.toThrow(
      /unresolved repair marker.*preview-teardown/
    );
  });

  it('proceeds when furnace state has no pendingRepair', async () => {
    mockPathExists.mockResolvedValue(false);

    await prepareBuildEnvironment('/project', paths, config);
    expect(mockCleanStories).toHaveBeenCalledWith('/project/engine');
  });

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
    expect(mockRunFurnaceMutation).toHaveBeenCalledWith(
      '/project',
      'apply-rollback',
      expect.any(Function)
    );
    expect(mockApplyAllComponents.mock.calls.at(-1)?.[0]).toBe('/project');
    expect(mockApplyAllComponents.mock.calls.at(-1)?.[1]).toBe(false);
    const options: unknown = mockApplyAllComponents.mock.calls.at(-1)?.[2];
    expect(options).toBeDefined();
    if (!options || typeof options !== 'object' || !('operationContext' in options)) {
      throw new Error('expected apply options with operationContext');
    }
    const operationContext = (
      options as {
        operationContext: {
          registerJournal: unknown;
          registerCleanup: unknown;
        };
      }
    ).operationContext;
    expect(typeof operationContext.registerJournal).toBe('function');
    expect(typeof operationContext.registerCleanup).toBe('function');
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

  it('emits a banner naming applied components when apply wrote files', async () => {
    mockFurnaceConfigExists.mockResolvedValue(true);
    mockLoadFurnaceConfig.mockResolvedValue({
      overrides: { 'moz-button': {} },
      custom: { 'moz-storage-widget': {} },
      stock: [],
    } as never);
    mockApplyAllComponents.mockResolvedValue({
      applied: [
        { name: 'moz-button', filesAffected: [] },
        { name: 'moz-storage-widget', filesAffected: [] },
      ],
      errors: [],
      skipped: [],
    } as never);

    await prepareBuildEnvironment('/project', paths, config);

    const bannerCall = mockInfo.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('source → engine sync')
    );
    expect(bannerCall).toBeDefined();
    expect(bannerCall?.[0]).toContain('2 components');
    expect(bannerCall?.[0]).toContain('moz-button');
    expect(bannerCall?.[0]).toContain('moz-storage-widget');
  });

  it('does not emit the banner when no components were applied', async () => {
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

    await prepareBuildEnvironment('/project', paths, config);

    const bannerCall = mockInfo.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('source → engine sync')
    );
    expect(bannerCall).toBeUndefined();
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

  it('throws when applyAllComponents returns errors, logging each one', async () => {
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

    await expect(prepareBuildEnvironment('/project', paths, config)).rejects.toThrow(
      /2 components failed to apply cleanly/
    );
    expect(mockWarn).toHaveBeenCalledWith('Furnace: comp-a \u2014 copy failed');
    expect(mockWarn).toHaveBeenCalledWith('Furnace: comp-b \u2014 missing dir');
  });

  it('throws when an applied component has stepErrors, logging each one', async () => {
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

    await expect(prepareBuildEnvironment('/project', paths, config)).rejects.toThrow(
      /1 component failed to apply cleanly/
    );
    expect(mockWarn).toHaveBeenCalledWith('Furnace: moz-button [register] pattern mismatch');
  });
});

describe('prepareBuildEnvironment auto-configure', () => {
  it('runs mach configure when moz.build changed since the baseline', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMach } = await import('../mach.js');

    vi.mocked(git).mockImplementation((args: string[]) => {
      if (args.includes('abc..HEAD')) {
        return Promise.resolve('browser/moz.build\nbrowser/base/browser.js\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMach).mockResolvedValue(0);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.reconfigured).toBe(true);
    expect(runMach).toHaveBeenCalledWith(['configure'], '/project/engine');
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('Backend config changed; running mach configure first')
    );
  });

  it('skips mach configure when no backend-invalidating files changed', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMach } = await import('../mach.js');

    vi.mocked(git).mockResolvedValue('browser/base/browser.js\n'); // .js is not backend-invalidating
    vi.mocked(hasChanges).mockResolvedValue(false);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.reconfigured).toBe(false);
    expect(runMach).not.toHaveBeenCalled();
  });

  it('continues the build when mach configure exits non-zero', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMach } = await import('../mach.js');

    vi.mocked(git).mockResolvedValue('browser/moz.build\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMach).mockResolvedValue(1);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    // configure failed, but prepare itself did not — reconfigured stays false.
    expect(result.reconfigured).toBe(false);
  });

  it('swallows mach configure exceptions and keeps building', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMach } = await import('../mach.js');

    vi.mocked(git).mockResolvedValue('browser/moz.configure\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMach).mockRejectedValue(new Error('python missing'));

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.reconfigured).toBe(false);
  });

  it('picks up workdir-modified moz.build when the baseline diff is empty', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMach } = await import('../mach.js');
    const { getUntrackedFiles } = await import('../git-status.js');

    vi.mocked(git).mockImplementation((args: string[]) => {
      if (args.includes('abc..HEAD')) {
        return Promise.resolve('');
      }
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'HEAD') {
        return Promise.resolve('toolkit/Makefile.in\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);
    vi.mocked(runMach).mockResolvedValue(0);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.reconfigured).toBe(true);
  });

  it('skips auto-configure entirely when no baseline is provided', async () => {
    const { runMach } = await import('../mach.js');

    const result = await prepareBuildEnvironment('/project', paths, config);

    expect(result.reconfigured).toBe(false);
    expect(runMach).not.toHaveBeenCalled();
  });
});

describe('isBackendInvalidatingFile', () => {
  it('matches moz.build, moz.configure, and Makefile.in at any depth', async () => {
    const { isBackendInvalidatingFile } = await import('../build-prepare.js');
    expect(isBackendInvalidatingFile('moz.build')).toBe(true);
    expect(isBackendInvalidatingFile('browser/moz.build')).toBe(true);
    expect(isBackendInvalidatingFile('browser/base/moz.build')).toBe(true);
    expect(isBackendInvalidatingFile('moz.configure')).toBe(true);
    expect(isBackendInvalidatingFile('toolkit/moz.configure')).toBe(true);
    expect(isBackendInvalidatingFile('Makefile.in')).toBe(true);
    expect(isBackendInvalidatingFile('toolkit/Makefile.in')).toBe(true);
  });

  it('does not match packaged source or similarly-named files', async () => {
    const { isBackendInvalidatingFile } = await import('../build-prepare.js');
    expect(isBackendInvalidatingFile('browser/base/browser.js')).toBe(false);
    expect(isBackendInvalidatingFile('browser/moz.build.py')).toBe(false);
    expect(isBackendInvalidatingFile('docs/moz.build.md')).toBe(false);
    expect(isBackendInvalidatingFile('makefile.in')).toBe(false);
  });
});
