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
  testWithOutput: vi.fn(),
}));

vi.mock('../../core/build-prepare.js', () => ({
  prepareBuildEnvironment: vi.fn(() => Promise.resolve({ furnaceApplied: 0, reconfigured: false })),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../core/marionette-preflight.js', () => ({
  runMarionettePreflight: vi.fn(),
  reportMarionettePreflight: vi.fn(),
}));

vi.mock('../../core/test-stale-check.js', () => ({
  checkStaleBuildForTest: vi.fn(() =>
    Promise.resolve({ stale: false, changedPaths: [], truncated: 0, baseline: undefined })
  ),
  formatStaleBuildWarning: vi.fn(() => 'stale warning'),
}));

import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  testWithOutput,
} from '../../core/mach.js';
import {
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../../core/marionette-preflight.js';
import { checkStaleBuildForTest, formatStaleBuildWarning } from '../../core/test-stale-check.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../../errors/build.js';
import { pathExists } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
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

  it('calls prepareBuildEnvironment before an incremental test rebuild', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(prepareBuildEnvironment).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ engine: '/project/engine' }),
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
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

  it('strips a case-insensitive engine prefix on case-insensitive filesystems', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['Engine/browser/components/tests/unit/test_distribution.js'])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      []
    );
  });

  it('strips engine prefix using a Windows-style backslash separator', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['engine\\browser\\components\\tests\\unit\\test_distribution.js'])
    ).resolves.toBeUndefined();

    // backslashes survive into mach (Windows mach handles them), but the
    // engine prefix is stripped.
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser\\components\\tests\\unit\\test_distribution.js'],
      []
    );
  });

  it('trims surrounding whitespace from supplied test paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['  engine/browser/components/tests/unit/test_distribution.js  '])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      []
    );
  });

  it('runs the marionette preflight without calling mach test when --doctor is supplied alone', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 200,
      detail: 'handshake',
    });

    await expect(testCommand('/project', [], { doctor: true })).resolves.toBeUndefined();

    expect(runMarionettePreflight).toHaveBeenCalledWith('/project/engine');
    expect(reportMarionettePreflight).toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('surfaces a FAIL preflight as an actionable error and does not invoke mach test', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: false,
      durationMs: 12_000,
      detail: 'socket timeout',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        doctor: true,
      })
    ).rejects.toThrow(/Marionette preflight reported FAIL/i);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('warns up-front when the stale-build preflight reports packageable engine changes', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce({
      stale: true,
      changedPaths: ['browser/base/content/hominis.xhtml', 'browser/base/content/hominis.js'],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc123',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
      },
    });
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).resolves.toBeUndefined();

    // The warning must fire before mach test — the user's feedback was that
    // discovering stale artifacts AFTER xpcshell launches gives no actionable
    // signal in time.
    expect(checkStaleBuildForTest).toHaveBeenCalledWith('/project', '/project/engine');
    expect(formatStaleBuildWarning).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('stale warning');
    expect(testWithOutput).toHaveBeenCalled();
  });

  it('skips the stale-build preflight when --build was requested', async () => {
    // --build already refreshes the obj-* bundle, so an additional
    // stale-build warning would be actively misleading — it reports drift
    // against a baseline that the rebuild just invalidated.
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(checkStaleBuildForTest).not.toHaveBeenCalled();
  });

  it('does not warn when the stale-build preflight reports no packageable changes', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    // Default mock already returns stale: false.

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).resolves.toBeUndefined();

    expect(checkStaleBuildForTest).toHaveBeenCalled();
    expect(formatStaleBuildWarning).not.toHaveBeenCalled();
  });

  it('proceeds to mach test when the preflight passes and test paths are supplied', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 120,
      detail: 'handshake',
    });
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        doctor: true,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalled();
  });
});
