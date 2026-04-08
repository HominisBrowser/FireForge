// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
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
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
  buildArtifactMismatchMessage: vi.fn(() => undefined),
  buildUI: vi.fn(),
  generateMozconfig: vi.fn(),
  testWithOutput: vi.fn(),
}));

vi.mock('../../core/branding.js', () => ({
  isBrandingSetup: vi.fn(() => Promise.resolve(true)),
  setupBranding: vi.fn(),
}));

vi.mock('../../core/furnace-stories.js', () => ({
  cleanStories: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  info: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

import { isBrandingSetup, setupBranding } from '../../core/branding.js';
import { cleanStories } from '../../core/furnace-stories.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  generateMozconfig,
  hasBuildArtifacts,
  testWithOutput,
} from '../../core/mach.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../../errors/build.js';
import { pathExists } from '../../utils/fs.js';
import { testCommand } from '../test.js';

describe('testCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(buildUI).mockResolvedValue(0);
  });

  it('fails before invoking mach when a requested test path does not exist', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/missing.js'])
    ).rejects.toThrow(/run "fireforge import" first/i);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('surfaces UNKNOWN TEST as a discovery error instead of a generic build failure', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'UNKNOWN TEST: browser/modules/mybrowser/test/browser_mybrowser_schema.js',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/browser_mybrowser_schema.js'])
    ).rejects.toThrow(/could not discover the requested test path/i);
  });

  it('rewrites stale-branding failures into an actionable rebuild hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'No chrome package registered for chrome://branding/locale/brand.properties',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/distribution.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'])
    ).rejects.toThrow(/stale build artifacts/i);
  });

  it('rewrites missing generated branding moz.build failures into the same rebuild hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'mozbuild.frontend.reader.BuildReaderError: referenced a path that does not exist: /project/engine/browser/branding/mybrowser/moz.build',
    });

    await expect(
      testCommand('/project', [
        'browser/components/tests/unit/test_browserGlue_mybrowser_startup.js',
      ])
    ).rejects.toThrow(/stale build artifacts/i);
  });

  it('runs branding and mozconfig prep before an incremental test rebuild', async () => {
    vi.mocked(isBrandingSetup).mockResolvedValue(false);
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(setupBranding).toHaveBeenCalled();
    expect(generateMozconfig).toHaveBeenCalled();
    expect(cleanStories).toHaveBeenCalledWith('/project/engine');
    expect(buildUI).toHaveBeenCalledWith('/project/engine');
  });

  it('fails with an AmbiguousBuildArtifactsError when multiple objdirs are detected', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({
      exists: true,
      ambiguous: true,
      objDirs: ['obj-debug', 'obj-opt'],
    });

    await expect(testCommand('/project', [])).rejects.toBeInstanceOf(AmbiguousBuildArtifactsError);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('surfaces build artifact mismatch messages before invoking mach test', async () => {
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue('Build artifacts do not match Tests');

    await expect(testCommand('/project', [])).rejects.toThrow('Build artifacts do not match Tests');

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('requires a completed build when no objdir exists and --build was not requested', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({ exists: false });

    await expect(testCommand('/project', [])).rejects.toThrow('Tests require a completed build');

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('throws a BuildError when the incremental pre-test build fails', async () => {
    vi.mocked(buildUI).mockResolvedValue(1);

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).rejects.toBeInstanceOf(BuildError);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('normalizes engine-prefixed test paths and passes headless through to mach test', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['engine/browser/components/tests/unit/test_distribution.js'], {
        headless: true,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      ['--headless']
    );
  });
});
