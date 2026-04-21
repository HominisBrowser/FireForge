// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      license: 'EUPL-1.2',
      build: { jobs: 8 },
    })
  ),
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

vi.mock('../../core/mach.js', () => ({
  generateMozconfig: vi.fn(),
  watchWithOutput: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 130 })),
  hasBuildArtifacts: vi.fn(),
  buildArtifactMismatchMessage: vi.fn(),
  // `packageCommand` now uses the capturing variant so it can surface
  // `explainMachError` hints (Finding #12). Keep the legacy `machPackage`
  // mock for any path that still references it; both resolve to a
  // clean-exit shape for these preflight tests which gate on the
  // `hasBuildArtifacts` outcome, never on the package result.
  machPackage: vi.fn(),
  machPackageCapture: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })),
  // Finding #13 adds a bundle-readiness probe that `run` and `watch`
  // consult. Default to "runnable" so the preflight tests still hit the
  // branch they actually care about (mismatch reasons, watchman failures);
  // dedicated bundle-agreement coverage lives in run.test.ts /
  // watch.test.ts.
  hasRunnableBundle: vi.fn(() =>
    Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/mybrowser' })
  ),
  test: vi.fn(),
  testWithOutput: vi.fn(),
  buildUI: vi.fn(),
  // Build lock added in 0.16.0; pass through so the preflight tests
  // still exercise the downstream mach calls exactly as before.
  withBuildLock: vi.fn((_projectRoot: string, operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../core/branding.js', () => ({
  isBrandingSetup: vi.fn(() => Promise.resolve(true)),
  setupBranding: vi.fn(),
}));

vi.mock('../../core/furnace-stories.js', () => ({
  cleanStories: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
  checkDiskSpace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/process.js', () => ({
  executableExists: vi.fn(() => Promise.resolve(true)),
  exec: vi.fn(() => Promise.resolve({ stdout: '2024.01.15.00\n', stderr: '', exitCode: 0 })),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

// `fireforge watch` now runs a furnace staleness check before entering
// the watch loop. Stub the helper out for preflight tests that don't
// exercise furnace state.
vi.mock('../../core/furnace-staleness.js', () => ({
  warnIfFurnaceStale: vi.fn(() => Promise.resolve()),
}));

import {
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  watchWithOutput,
} from '../../core/mach.js';
import { executableExists } from '../../utils/process.js';
import { buildCommand } from '../build.js';
import { packageCommand } from '../package.js';
import { testCommand } from '../test.js';
import { watchCommand } from '../watch.js';

describe('build artifact preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: true,
      ambiguous: true,
      objDirs: ['obj-debug', 'obj-release'],
    });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(watchWithOutput).mockResolvedValue({ stdout: '', stderr: '', exitCode: 130 });
  });

  it('watchCommand fails instead of guessing when build artifacts are ambiguous', async () => {
    await expect(watchCommand('/project')).rejects.toThrow(/Multiple build artifact directories/);
  });

  it('testCommand fails instead of guessing when build artifacts are ambiguous', async () => {
    await expect(testCommand('/project', [])).rejects.toThrow(
      /Multiple build artifact directories/
    );
  });

  it('watchCommand fails early when watchman is not installed', async () => {
    vi.mocked(executableExists).mockResolvedValue(false);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });

    await expect(watchCommand('/project')).rejects.toThrow(/requires watchman/i);
  });

  it('testCommand rejects copied build artifacts that point at another workspace', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Tests cannot use copied or relocated build artifacts'
    );

    await expect(testCommand('/project', [])).rejects.toThrow(
      /copied or relocated build artifacts/i
    );
  });

  it('watchCommand rejects copied build artifacts that point at another workspace', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Watch mode cannot use copied or relocated build artifacts'
    );

    await expect(watchCommand('/project')).rejects.toThrow(/copied or relocated build artifacts/i);
  });

  it('packageCommand fails instead of guessing when build artifacts are ambiguous', async () => {
    await expect(packageCommand('/project', {})).rejects.toThrow(
      /Multiple build artifact directories/
    );
  });

  it('buildCommand fails instead of guessing when build artifacts are ambiguous', async () => {
    await expect(buildCommand('/project', { ui: true })).rejects.toThrow(
      /Multiple build artifact directories/
    );
    expect(buildUI).not.toHaveBeenCalled();
  });

  it('packageCommand rejects copied build artifacts that point at another workspace', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Package cannot use copied or relocated build artifacts'
    );

    await expect(packageCommand('/project', {})).rejects.toThrow(
      /copied or relocated build artifacts/i
    );
  });

  it('buildCommand rejects copied build artifacts that point at another workspace', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Build cannot use copied or relocated build artifacts'
    );

    await expect(buildCommand('/project', { ui: true })).rejects.toThrow(
      /copied or relocated build artifacts/i
    );
    expect(buildUI).not.toHaveBeenCalled();
  });

  it('watchCommand rewrites configure-time watchman failures into rebuild guidance', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(watchWithOutput).mockResolvedValue({
      stdout: '',
      stderr: 'mach watch requires watchman to be installed and found at configure time',
      exitCode: 1,
    });

    await expect(watchCommand('/project')).rejects.toThrow(
      /watchman was not available when Firefox was configured/i
    );
  });
});
