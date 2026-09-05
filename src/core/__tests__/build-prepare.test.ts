// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('../branding.js', () => ({
  setupBranding: vi.fn(),
  isBrandingSetup: vi.fn(),
}));

vi.mock('../furnace-stories.js', () => ({
  cleanStories: vi.fn(),
}));

vi.mock('../mach.js', () => ({
  generateMozconfig: vi.fn(),
  runMachCapture: vi.fn(),
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
  // The jar-escalation narrowing asks whether a changed jar.mn is new.
  // Default: tracked (pre-existing), so only tests that opt in escalate.
  getUntrackedFilesInDir: vi.fn(() => Promise.resolve([] as string[])),
}));

// The fingerprint comparison reads engine files through hashEngineFile.
// Stub it so a "dirty but byte-identical" build input can be simulated
// without a real engine tree.
vi.mock('../coverage-extend.js', () => ({
  hashEngineFile: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  warn: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
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

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../furnace-apply.js', () => ({
  applyAllComponents: vi.fn(),
}));

vi.mock('../furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (_root: string, _kind: string, body: (ctx: unknown) => Promise<unknown>) =>
      body({
        registerJournal: vi.fn(),
        registerCleanup: vi.fn(),
        markRolledBack: vi.fn(),
      })
  ),
}));

import type { FireForgeConfig, ProjectPaths } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import { info, notice, spinner, warn } from '../../utils/logger.js';
import { isBrandingSetup, setupBranding } from '../branding.js';
import { prepareBuildEnvironment } from '../build-prepare.js';
import { hashEngineFile } from '../coverage-extend.js';
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
const mockNotice = vi.mocked(notice);
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
  mockLoadFurnaceState.mockResolvedValue({});
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

  it('cleans stories and writes the mozconfig on the happy path', async () => {
    await prepareBuildEnvironment('/project', paths, config);

    expect(mockCleanStories).toHaveBeenCalledWith('/project/engine');
    expect(mockGenerateMozconfig).toHaveBeenCalledWith(
      '/project/configs',
      '/project/engine',
      config
    );
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

    // FireForge's own explanatory banners ride the warning channel so an
    // agent output filter that keeps only warnings and errors cannot drop
    // them.
    const bannerCall = mockNotice.mock.calls.find(
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
    });

    await prepareBuildEnvironment('/project', paths, config);

    const bannerCall = mockNotice.mock.calls.find(
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
    });

    const result = await prepareBuildEnvironment('/project', paths, config);
    expect(result.furnaceApplied).toBe(0);
    // The second spinner call (index 1) is the Furnace spinner
    const furnaceSpinner = mockSpinner.mock.results[1]?.value as
      { stop: ReturnType<typeof vi.fn> } | undefined;
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
    });

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
  // The 0.41.0 rule escalated on any changed jar.mn. A downstream
  // experiment showed `mach build faster` installs entries added to an
  // existing dist/bin manifest, so only a new manifest still escalates.
  it('escalates for a NEW jar.mn', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { getUntrackedFilesInDir } = await import('../git-status.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValueOnce(['toolkit/content/jar.mn']);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.fullBuildRequired).toBe(true);
    expect(result.fullBuildReason).toContain('new jar.mn');
  });

  it('does not escalate for an entry added to an existing dist/bin jar.mn', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValueOnce(
      'browser.jar:\n% content browser %content/browser/\n  content/browser/probe.txt (content/probe.txt)\n'
    );

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.fullBuildRequired).toBe(false);
  });

  // The bracketed base-directory prefix redirects the install destination
  // away from the default chrome root, the half the experiment never ran.
  it('still escalates for a jar.mn that redirects its install base directory', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValueOnce(
      '[localization] toolkit.jar:\n  en-US/foo.ftl (foo.ftl)\n'
    );

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.fullBuildRequired).toBe(true);
    expect(result.fullBuildReason).toContain('redirects the install base directory');
  });

  it('does not escalate for a dirty jar.mn byte-identical to the last successful build', async () => {
    // A fork's worktree is permanently dirty (imported patches, Furnace
    // components), so `git diff HEAD` names the patched jar.mn on every
    // run. Before the baseline carried buildInputFingerprints that meant
    // every `test --build` after a full build paid a second full build
    // for a manifest the first one had already installed.
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(hashEngineFile).mockResolvedValue('ab'.repeat(32));

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
        buildInputFingerprints: { 'toolkit/content/jar.mn': 'ab'.repeat(32) },
      },
    });

    expect(result.fullBuildRequired).toBe(false);
    expect(hashEngineFile).toHaveBeenCalledWith('/project/engine', 'toolkit/content/jar.mn');
  });

  it('still escalates when the dirty jar.mn no longer matches its recorded fingerprint', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(true);
    // The fingerprint gate is what this test is about. Mark the manifest
    // new so the narrowed jar rule (0.45.0) also escalates and the
    // fingerprint assertion below stays the assertion under test.
    const { getUntrackedFilesInDir } = await import('../git-status.js');
    vi.mocked(getUntrackedFilesInDir).mockResolvedValueOnce(['toolkit/content/jar.mn']);
    vi.mocked(hashEngineFile).mockResolvedValue('cd'.repeat(32));

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
        buildInputFingerprints: { 'toolkit/content/jar.mn': 'ab'.repeat(32) },
      },
    });

    expect(result.fullBuildRequired).toBe(true);
  });

  it('treats an unhashable jar.mn as changed rather than proven unchanged', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(true);
    // The fingerprint gate is what this test is about. Mark the manifest
    // new so the narrowed jar rule (0.45.0) also escalates and the
    // fingerprint assertion below stays the assertion under test.
    const { getUntrackedFilesInDir } = await import('../git-status.js');
    vi.mocked(getUntrackedFilesInDir).mockResolvedValueOnce(['toolkit/content/jar.mn']);
    vi.mocked(hashEngineFile).mockResolvedValue(undefined);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
        buildInputFingerprints: { 'toolkit/content/jar.mn': 'ab'.repeat(32) },
      },
    });

    expect(result.fullBuildRequired).toBe(true);
  });

  it('escalates for a dirty jar.mn the last successful build never fingerprinted', async () => {
    // The record covers other inputs but has no entry for this manifest:
    // it was clean at build time and is dirty now, so nothing can prove
    // it unchanged, and no hash is even attempted.
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(true);
    // The fingerprint gate is what this test is about. Mark the manifest
    // new so the narrowed jar rule (0.45.0) also escalates and the
    // fingerprint assertion below stays the assertion under test.
    const { getUntrackedFilesInDir } = await import('../git-status.js');
    vi.mocked(getUntrackedFilesInDir).mockResolvedValueOnce(['toolkit/content/jar.mn']);

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
        buildInputFingerprints: { 'browser/base/moz.build': 'ab'.repeat(32) },
      },
    });

    expect(result.fullBuildRequired).toBe(true);
    expect(hashEngineFile).not.toHaveBeenCalled();
  });

  it('escalates on a legacy baseline that carries no buildInputFingerprints', async () => {
    // A marker written before the field existed cannot prove anything
    // about the manifest, so the path-only rule applies unchanged.
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    vi.mocked(git).mockResolvedValue('toolkit/content/jar.mn\n');
    vi.mocked(hasChanges).mockResolvedValue(true);
    // The fingerprint gate is what this test is about. Mark the manifest
    // new so the narrowed jar rule (0.45.0) also escalates and the
    // fingerprint assertion below stays the assertion under test.
    const { getUntrackedFilesInDir } = await import('../git-status.js');
    vi.mocked(getUntrackedFilesInDir).mockResolvedValueOnce(['toolkit/content/jar.mn']);
    vi.mocked(hashEngineFile).mockResolvedValue('ab'.repeat(32));

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.fullBuildRequired).toBe(true);
    expect(hashEngineFile).not.toHaveBeenCalled();
  });

  it('skips mach configure for a dirty moz.build byte-identical to the last successful build', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');
    vi.mocked(git).mockImplementation((args: string[]) => {
      if (args.includes('abc..HEAD')) return Promise.resolve('');
      return Promise.resolve('browser/moz.build\nbrowser/base/browser.js\n');
    });
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(hashEngineFile).mockResolvedValue('ab'.repeat(32));

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
        buildInputFingerprints: { 'browser/moz.build': 'ab'.repeat(32) },
      },
    });

    expect(result.reconfigured).toBe(false);
    expect(runMachCapture).not.toHaveBeenCalled();
    // Only build inputs are hashed. The packageable .js path is not this
    // preflight's business.
    expect(hashEngineFile).not.toHaveBeenCalledWith('/project/engine', 'browser/base/browser.js');
  });

  it('runs mach configure when moz.build changed since the baseline', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');

    vi.mocked(git).mockImplementation((args: string[]) => {
      if (args.includes('abc..HEAD')) {
        return Promise.resolve('browser/moz.build\nbrowser/base/browser.js\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMachCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const result = await prepareBuildEnvironment('/project', paths, config, {
      previousBaseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'testbrowser',
      },
    });

    expect(result.reconfigured).toBe(true);
    expect(runMachCapture).toHaveBeenCalledWith(['configure'], '/project/engine');
    // The "why is this run slow" explanation is emitted at warning
    // severity, so an agent output filter cannot drop it and leave a
    // multi-minute reconfigure unexplained.
    expect(mockNotice).toHaveBeenCalledWith(
      expect.stringContaining('Backend config changed; running backend regeneration first')
    );
    expect(mockNotice).toHaveBeenCalledWith(
      expect.stringContaining('Backend command: mach configure')
    );
    expect(mockInfo).toHaveBeenCalledWith('Backend regeneration succeeded; continuing with build.');
  });

  it('skips mach configure when no backend-invalidating files changed', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');

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
    expect(runMachCapture).not.toHaveBeenCalled();
  });

  it('stops the build and surfaces the mozbuild UnsortedError text on non-zero configure', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');

    const unsorted =
      'mozbuild.util.UnsortedError: An attempt was made to add an unsorted sequence to a list. ' +
      "The incoming list is: ['HominisAppMenuIntegration.sys.mjs', 'HominisAppearanceController.sys.mjs']";

    vi.mocked(git).mockResolvedValue('browser/moz.build\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMachCapture).mockResolvedValue({
      stdout: '',
      stderr: `Traceback (most recent call last):\n${unsorted}\n`,
      exitCode: 1,
    });

    await expect(
      prepareBuildEnvironment('/project', paths, config, {
        previousBaseline: {
          engineHeadSha: 'abc',
          builtAt: new Date().toISOString(),
          binaryName: 'testbrowser',
        },
      })
    ).rejects.toThrow(/mozbuild\.util\.UnsortedError/);

    expect(runMachCapture).toHaveBeenCalledWith(['configure'], '/project/engine');
  });

  it('appends the fireforge bootstrap hint when configure fails on a moved toolchain minimum', async () => {
    // 152.0b7 → 153.0b8 source-refresh drill: the auto-configure path
    // must feed its captured output through the same hint translator the
    // protected build dispatch uses, so the cbindgen too-old failure
    // names `fireforge bootstrap` here too (mach's own remediation text
    // suggests "./mach bootstrap", the wrong tool for a managed repo).
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');

    vi.mocked(git).mockResolvedValue('browser/moz.build\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMachCapture).mockResolvedValue({
      stdout: '',
      stderr:
        'ERROR: cbindgen version 0.29.1 is too old. At least version 0.29.4 is required.\n' +
        "Please update using 'cargo install cbindgen --force' or running\n" +
        "'./mach bootstrap', after removing the existing executable.\n",
      exitCode: 1,
    });

    await expect(
      prepareBuildEnvironment('/project', paths, config, {
        previousBaseline: {
          engineHeadSha: 'abc',
          builtAt: new Date().toISOString(),
          binaryName: 'testbrowser',
        },
      })
    ).rejects.toThrow(/Hint: .*"fireforge bootstrap"/);
  });

  it('surfaces mach configure exceptions and stops building', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');

    vi.mocked(git).mockResolvedValue('browser/moz.configure\n');
    vi.mocked(hasChanges).mockResolvedValue(false);
    vi.mocked(runMachCapture).mockRejectedValue(new Error('python missing'));

    await expect(
      prepareBuildEnvironment('/project', paths, config, {
        previousBaseline: {
          engineHeadSha: 'abc',
          builtAt: new Date().toISOString(),
          binaryName: 'testbrowser',
        },
      })
    ).rejects.toThrow(/Backend regeneration failed while running mach configure: python missing/);
  });

  it('picks up workdir-modified moz.build when the baseline diff is empty', async () => {
    const { git } = await import('../git-base.js');
    const { hasChanges } = await import('../git.js');
    const { runMachCapture } = await import('../mach.js');
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
    vi.mocked(runMachCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

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
    const { runMachCapture } = await import('../mach.js');

    const result = await prepareBuildEnvironment('/project', paths, config);

    expect(result.reconfigured).toBe(false);
    expect(runMachCapture).not.toHaveBeenCalled();
  });
});

describe('describeSignalShapedExit', () => {
  it('describes exit 144 with the arithmetic and a host signal name', async () => {
    const { describeSignalShapedExit } = await import('../build-prepare.js');
    const note = describeSignalShapedExit(144);
    expect(note).toContain('Exit 144 is signal-shaped (144 - 128 = 16');
    expect(note).toContain('interrupted externally');
    expect(note).toContain('truncated mid-step');
  });

  it('names SIGINT for exit 130', async () => {
    const { describeSignalShapedExit } = await import('../build-prepare.js');
    expect(describeSignalShapedExit(130)).toContain('SIGINT');
  });

  it('returns undefined for regular failures and out-of-range codes', async () => {
    const { describeSignalShapedExit } = await import('../build-prepare.js');
    expect(describeSignalShapedExit(1)).toBeUndefined();
    expect(describeSignalShapedExit(128)).toBeUndefined();
    expect(describeSignalShapedExit(255)).toBeUndefined();
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
