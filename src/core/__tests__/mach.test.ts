// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pathExists, readJson, readText, writeText } from '../../utils/fs.js';
import {
  bootstrap,
  bootstrapWithOutput,
  build,
  buildArtifactMismatchMessage,
  buildUI,
  ensureMach,
  ensurePython,
  hasBuildArtifacts,
  hasRunnableBundle,
  machPackage,
  resetResolvedPython,
  run as runBrowser,
  runMach,
  runMachCapture,
  runMachInheritCapture,
  runMachSmoke,
  test as runMachTest,
  testWithOutput,
  watch,
  watchWithOutput,
} from '../mach.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn() };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readJson: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
  execInherit: vi.fn(),
  execInheritCapture: vi.fn(),
  execSmokeRun: vi.fn(),
  execStream: vi.fn(),
  executableExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
}));

// hasRunnableBundle reads getPlatform() to pick the per-OS binary path;
// mock it so each `hasRunnableBundle` test can stamp the probe under a
// specific platform without touching the host.
vi.mock('../../utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'linux'),
}));

import { getPlatform } from '../../utils/platform.js';

describe('hasBuildArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no obj-* directories exist', async () => {
    vi.mocked(readdir).mockResolvedValue(['browser', 'toolkit'] as never);

    await expect(hasBuildArtifacts('/engine')).resolves.toEqual({ exists: false });
  });

  it('returns the single valid obj-* directory when only one has dist', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-debug', 'obj-stale'] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/engine/obj-debug/dist')
    );

    await expect(hasBuildArtifacts('/engine')).resolves.toEqual({
      exists: true,
      objDir: 'obj-debug',
    });
  });

  it('returns an ambiguous result when multiple obj-* directories have dist', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-a', 'obj-b'] as never);
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(hasBuildArtifacts('/engine')).resolves.toEqual({
      exists: true,
      ambiguous: true,
      objDirs: ['obj-a', 'obj-b'],
    });
  });

  it('reports incomplete artifacts when only stale obj-* directories exist', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-stale'] as never);
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(hasBuildArtifacts('/engine')).resolves.toEqual({
      exists: false,
      objDir: 'obj-stale',
    });
  });

  it('detects copied build artifacts whose mozinfo points at another workspace', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-debug'] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' || path === '/engine/obj-debug/mozinfo.json'
      )
    );
    vi.mocked(readJson).mockResolvedValue({
      topsrcdir: '/elsewhere/engine',
      topobjdir: '/elsewhere/engine/obj-debug',
      mozconfig: '/elsewhere/engine/mozconfig',
    });

    await expect(hasBuildArtifacts('/engine')).resolves.toEqual({
      exists: true,
      objDir: 'obj-debug',
      metadataMismatch: {
        objDir: 'obj-debug',
        topsrcdir: '/elsewhere/engine',
        topobjdir: '/elsewhere/engine/obj-debug',
        mozconfig: '/elsewhere/engine/mozconfig',
      },
    });
  });

  it('detects a workspace move when only the parent directory name differs', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-aarch64-apple-darwin25.4.0'] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/Users/dev/project2/engine/obj-aarch64-apple-darwin25.4.0/dist' ||
          path === '/Users/dev/project2/engine/obj-aarch64-apple-darwin25.4.0/mozinfo.json'
      )
    );
    vi.mocked(readJson).mockResolvedValue({
      topsrcdir: '/Users/dev/project1/engine',
      topobjdir: '/Users/dev/project1/engine/obj-aarch64-apple-darwin25.4.0',
      mozconfig: '/Users/dev/project1/engine/mozconfig',
    });

    const result = await hasBuildArtifacts('/Users/dev/project2/engine');
    expect(result.exists).toBe(true);
    expect(result.metadataMismatch).toBeDefined();
    expect(result.metadataMismatch?.topsrcdir).toBe('/Users/dev/project1/engine');
  });

  it('accepts matching mozinfo metadata even with platform-specific obj-* directory names', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-aarch64-apple-darwin25.4.0'] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/project/engine/obj-aarch64-apple-darwin25.4.0/dist' ||
          path === '/project/engine/obj-aarch64-apple-darwin25.4.0/mozinfo.json'
      )
    );
    vi.mocked(readJson).mockResolvedValue({
      topsrcdir: '/project/engine',
      topobjdir: '/project/engine/obj-aarch64-apple-darwin25.4.0',
    });

    await expect(hasBuildArtifacts('/project/engine')).resolves.toEqual({
      exists: true,
      objDir: 'obj-aarch64-apple-darwin25.4.0',
    });
  });

  it('ignores malformed mozinfo metadata and keeps the detected objdir', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-debug'] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' || path === '/engine/obj-debug/mozinfo.json'
      )
    );
    vi.mocked(readJson).mockResolvedValue({ topsrcdir: 42 });

    await expect(hasBuildArtifacts('/engine')).resolves.toEqual({
      exists: true,
      objDir: 'obj-debug',
    });
  });
});

describe('hasRunnableBundle (Finding #13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns runnable=false when dist/ itself does not exist', async () => {
    // dist/ absent is the pre-`mach build` state; no subsequent probe is
    // meaningful. Caller surfaces this as "build has not started".
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(hasRunnableBundle('/engine', 'mybrowser', 'obj-debug')).resolves.toEqual({
      runnable: false,
    });
  });

  it('finds the Linux binary under dist/bin/<binaryName>', async () => {
    vi.mocked(getPlatform).mockReturnValue('linux');
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' || path === '/engine/obj-debug/dist/bin/mybrowser'
      )
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(true);
    expect(result.expectedPath).toBe('obj-debug/dist/bin/mybrowser');
  });

  it('reports the expected path when the Linux binary is missing', async () => {
    vi.mocked(getPlatform).mockReturnValue('linux');
    // dist/ exists but dist/bin/mybrowser does not — the precise error
    // message must name the missing path so the operator can grep dist/
    // for a moved/renamed binary.
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/engine/obj-debug/dist')
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(false);
    expect(result.expectedPath).toBe('obj-debug/dist/bin/mybrowser');
  });

  it('appends .exe to the probed Windows binary path', async () => {
    vi.mocked(getPlatform).mockReturnValue('win32');
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' || path === '/engine/obj-debug/dist/bin/mybrowser.exe'
      )
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(true);
    expect(result.expectedPath).toBe('obj-debug/dist/bin/mybrowser.exe');
  });

  it('finds the macOS binary inside *.app/Contents/MacOS/<binaryName>', async () => {
    vi.mocked(getPlatform).mockReturnValue('darwin');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'MyBrowser.app', isDirectory: () => true, isFile: () => false } as never,
      { name: 'bin', isDirectory: () => true, isFile: () => false } as never,
    ] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' ||
          path === '/engine/obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser'
      )
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(true);
    expect(result.expectedPath).toBe('obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser');
  });

  it('reports the expected macOS path even when no .app exists yet', async () => {
    vi.mocked(getPlatform).mockReturnValue('darwin');
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/engine/obj-debug/dist')
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(false);
    // The synthetic "<AppName>.app" placeholder tells the operator what
    // shape to look for without committing to a specific display name.
    expect(result.expectedPath).toContain('<AppName>.app/Contents/MacOS/mybrowser');
  });

  it('degrades to runnable=false on readdir failure rather than throwing', async () => {
    vi.mocked(getPlatform).mockReturnValue('darwin');
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockRejectedValue(new Error('EACCES'));

    await expect(hasRunnableBundle('/engine', 'mybrowser', 'obj-debug')).resolves.toEqual({
      runnable: false,
    });
  });

  it('ignores non-directory and non-.app entries under dist/ on darwin', async () => {
    // The `entry.isDirectory()` and `.app` filter branches must hit the
    // skip-continue paths (not just the match path) so the module's
    // branch coverage reflects all three outcomes. A mixed fixture —
    // regular file, non-.app directory, `.app` directory with binary —
    // exercises all three in one pass.
    vi.mocked(getPlatform).mockReturnValue('darwin');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'README.txt', isDirectory: () => false, isFile: () => true } as never,
      { name: 'bin', isDirectory: () => true, isFile: () => false } as never,
      { name: 'MyBrowser.app', isDirectory: () => true, isFile: () => false } as never,
    ] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' ||
          path === '/engine/obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser'
      )
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(true);
    expect(result.expectedPath).toBe('obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser');
  });

  it('keeps looking through later .app bundles when an earlier one is empty on darwin', async () => {
    // Exercises the darwin for-loop's "candidate exists? no" continue
    // branch. Two `.app` bundles, only the second owns the binary —
    // the iterator must fall through the first `if (await pathExists)`
    // branch and still return runnable via the second.
    vi.mocked(getPlatform).mockReturnValue('darwin');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'OldBrowser.app', isDirectory: () => true, isFile: () => false } as never,
      { name: 'MyBrowser.app', isDirectory: () => true, isFile: () => false } as never,
    ] as never);
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/obj-debug/dist' ||
          // OldBrowser.app binary is NOT present; MyBrowser.app is.
          path === '/engine/obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser'
      )
    );

    const result = await hasRunnableBundle('/engine', 'mybrowser', 'obj-debug');
    expect(result.runnable).toBe(true);
    expect(result.expectedPath).toBe('obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser');
  });
});

describe('buildArtifactMismatchMessage', () => {
  it('formats a copied-workspace explanation from mozinfo metadata', () => {
    expect(
      buildArtifactMismatchMessage(
        '/engine',
        {
          exists: true,
          objDir: 'obj-debug',
          metadataMismatch: {
            objDir: 'obj-debug',
            topsrcdir: '/elsewhere/engine',
            topobjdir: '/elsewhere/engine/obj-debug',
          },
        },
        'Tests'
      )
    ).toContain('copied or relocated build artifacts');
  });

  it('includes all mozinfo details for platform-specific objdirs', () => {
    const message = buildArtifactMismatchMessage(
      '/Users/dev/project2/engine',
      {
        exists: true,
        objDir: 'obj-aarch64-apple-darwin25.4.0',
        metadataMismatch: {
          objDir: 'obj-aarch64-apple-darwin25.4.0',
          topsrcdir: '/Users/dev/project1/engine',
          topobjdir: '/Users/dev/project1/engine/obj-aarch64-apple-darwin25.4.0',
          mozconfig: '/Users/dev/project1/engine/mozconfig',
        },
      },
      'Build'
    );
    expect(message).toContain('Build cannot use copied or relocated');
    expect(message).toContain('mozinfo topsrcdir: /Users/dev/project1/engine');
    expect(message).toContain('mozinfo mozconfig: /Users/dev/project1/engine/mozconfig');
    expect(message).toContain('Delete the stale obj-* directory');
  });

  it('returns undefined when there is no metadata mismatch', () => {
    expect(
      buildArtifactMismatchMessage('/engine', { exists: true, objDir: 'obj-debug' }, 'Build')
    ).toBeUndefined();
  });
});

describe('ensurePython / resetResolvedPython', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetResolvedPython();
  });

  it('resolves a supported Python version and caches the result', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.11.9\n', stderr: '', exitCode: 0 });

    await ensurePython();

    // Second call should not re-invoke exec (cached)
    vi.mocked(exec).mockClear();
    await ensurePython();
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts Python 3.12 when mach supports it', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.12.7\n', stderr: '', exitCode: 0 });

    await expect(ensurePython()).resolves.toBeUndefined();
  });

  it('rejects Python above mach maximum', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.14.3\n', stderr: '', exitCode: 0 });

    await expect(ensurePython()).rejects.toThrow();
  });

  it('skips a too-new Python and selects a compatible lower version', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(
      'MIN_PYTHON_VERSION = (3, 8)\nMAX_PYTHON_VERSION_TO_CONSIDER = (3, 12)\n'
    );
    // python3.12 exists, python3.11 exists, etc. — all candidates "exist"
    vi.mocked(executableExists).mockResolvedValue(true);
    // First candidate (python3.12) reports 3.14.3 (too new, e.g. symlink),
    // second candidate (python3.11) reports 3.11.9 (in range)
    vi.mocked(exec)
      .mockResolvedValueOnce({ stdout: '3.14.3\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '3.11.9\n', stderr: '', exitCode: 0 });

    await expect(ensurePython('/engine')).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('clears cached resolution via resetResolvedPython', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.11.9\n', stderr: '', exitCode: 0 });

    await ensurePython();

    // Reset the cache
    resetResolvedPython();

    // Now make python unavailable
    vi.mocked(executableExists).mockResolvedValue(false);

    // Should attempt resolution again and fail
    await expect(ensurePython()).rejects.toThrow();
  });

  it('reads mach version bounds when an engine path is provided', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(
      'MIN_PYTHON_VERSION = (3, 10)\nMAX_PYTHON_VERSION_TO_CONSIDER = (3, 12)\n'
    );
    vi.mocked(executableExists).mockImplementation((candidate: string) =>
      Promise.resolve(candidate === 'python3.12')
    );
    vi.mocked(exec).mockResolvedValue({ stdout: '3.12.12\n', stderr: '', exitCode: 0 });

    await expect(ensurePython('/engine')).resolves.toBeUndefined();
    expect(executableExists).toHaveBeenCalledWith('python3.12');
  });

  it('throws PythonNotFoundError when no candidates pass executableExists', async () => {
    const { executableExists } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(false);

    await expect(ensurePython()).rejects.toThrow();
  });

  it('skips candidate whose version check throws and tries next', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec)
      .mockRejectedValueOnce(new Error('segfault'))
      .mockResolvedValueOnce({ stdout: '3.11.5\n', stderr: '', exitCode: 0 });

    await expect(ensurePython()).resolves.toBeUndefined();
  });

  it('throws when all candidates exist but versions are out of range', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(executableExists).mockResolvedValue(true);
    // All return Python 2.7
    vi.mocked(exec).mockResolvedValue({ stdout: '2.7.18\n', stderr: '', exitCode: 0 });

    await expect(ensurePython()).rejects.toThrow();
  });

  it('falls back to defaults when engine mach file is not found', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.11.5\n', stderr: '', exitCode: 0 });

    await expect(ensurePython('/engine')).resolves.toBeUndefined();
  });

  it('falls back to defaults when mach file parsing fails', async () => {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('not a python script');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.11.5\n', stderr: '', exitCode: 0 });

    await expect(ensurePython('/engine')).resolves.toBeUndefined();
  });
});

describe('mach command execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetResolvedPython();
  });

  async function primePythonResolution(engineDir = '/engine'): Promise<void> {
    const { executableExists, exec } = await import('../../utils/process.js');
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === `${engineDir}/mach`)
    );
    vi.mocked(readText).mockResolvedValue('MIN_PYTHON_VERSION = (3, 10)\n');
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ stdout: '3.11.5\n', stderr: '', exitCode: 0 });

    await ensurePython(engineDir);
    vi.mocked(exec).mockClear();
  }

  it('throws when mach is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(ensureMach('/engine')).rejects.toThrow('mach not found');
  });

  it('runs mach with captured exit code and env', async () => {
    const { exec } = await import('../../utils/process.js');
    await primePythonResolution();
    vi.mocked(exec).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 7 });

    await expect(runMach(['build'], '/engine', { env: { MOZCONFIG: 'debug' } })).resolves.toBe(7);

    expect(exec).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'build'],
      expect.objectContaining({ cwd: '/engine', env: { MOZCONFIG: 'debug' } })
    );
  });

  it('normalizes Firefox ignore files before spawning mach', async () => {
    const { exec } = await import('../../utils/process.js');
    await primePythonResolution();
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(
        path === '/engine/mach' ||
          path === '/engine/tools/lint/ignorefile.yml' ||
          path === '/engine/.gitignore'
      )
    );
    vi.mocked(readText).mockResolvedValue('obj-*/\n*.pyc\n');
    vi.mocked(exec).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await expect(
      runMach(['lint', '--fix', 'browser/base/content/foo.js'], '/engine')
    ).resolves.toBe(0);

    expect(writeText).toHaveBeenCalledWith('/engine/.hgignore', 'obj-*/\n*.pyc\n');
    expect(exec).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'lint', '--fix', 'browser/base/content/foo.js'],
      expect.objectContaining({ cwd: '/engine' })
    );
  });

  it('runs mach with inherited stdio when requested', async () => {
    const { execInherit } = await import('../../utils/process.js');
    await primePythonResolution();
    vi.mocked(execInherit).mockResolvedValueOnce(0);

    await expect(runMach(['package'], '/engine', { inherit: true })).resolves.toBe(0);

    expect(execInherit).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'package'],
      expect.objectContaining({ cwd: '/engine' })
    );
  });

  it('captures streamed stdout and stderr from mach', async () => {
    const { execStream } = await import('../../utils/process.js');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await primePythonResolution();
    vi.mocked(execStream).mockImplementationOnce((_cmd, _args, options) => {
      options?.onStdout?.('hello\n');
      options?.onStderr?.('oops\n');
      return Promise.resolve(3);
    });

    await expect(runMachCapture(['test'], '/engine')).resolves.toEqual({
      stdout: 'hello\n',
      stderr: 'oops\n',
      exitCode: 3,
    });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('truncates captured stream tails when mach output exceeds the retention limit', async () => {
    const { execStream } = await import('../../utils/process.js');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await primePythonResolution();

    const oversizedStdout = 'a'.repeat(2 * 1024 * 1024 + 11);
    const oversizedStderr = 'b'.repeat(2 * 1024 * 1024 + 17);

    vi.mocked(execStream).mockImplementationOnce((_cmd, _args, options) => {
      options?.onStdout?.(oversizedStdout);
      options?.onStderr?.(oversizedStderr);
      return Promise.resolve(9);
    });

    await expect(runMachCapture(['build'], '/engine')).resolves.toEqual({
      stdout: oversizedStdout.slice(-(2 * 1024 * 1024)),
      stderr: oversizedStderr.slice(-(2 * 1024 * 1024)),
      exitCode: 9,
    });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('captures inherited mach output', async () => {
    const { execInheritCapture } = await import('../../utils/process.js');
    await primePythonResolution();
    vi.mocked(execInheritCapture).mockResolvedValueOnce({
      stdout: 'boot\n',
      stderr: '',
      exitCode: 0,
    });

    await expect(runMachInheritCapture(['bootstrap'], '/engine')).resolves.toEqual({
      stdout: 'boot\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('covers the public wrapper commands', async () => {
    const { execInherit, execInheritCapture, execStream } = await import('../../utils/process.js');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await primePythonResolution();

    vi.mocked(execInherit).mockResolvedValue(0);
    vi.mocked(execInheritCapture).mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    vi.mocked(execStream).mockImplementation((_cmd, _args, options) => {
      options?.onStdout?.('stream');
      return Promise.resolve(0);
    });

    await expect(bootstrap('/engine')).resolves.toBe(0);
    await expect(bootstrapWithOutput('/engine')).resolves.toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });
    await expect(build('/engine', 4)).resolves.toMatchObject({ exitCode: 0 });
    await expect(build('/engine')).resolves.toMatchObject({ exitCode: 0 });
    await expect(buildUI('/engine')).resolves.toMatchObject({ exitCode: 0 });
    await expect(runBrowser('/engine', ['--safe-mode'])).resolves.toBe(0);
    await expect(machPackage('/engine')).resolves.toBe(0);
    await expect(watch('/engine')).resolves.toBe(0);
    await expect(watchWithOutput('/engine')).resolves.toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });
    await expect(runMachTest('/engine', ['browser/test'], ['--headless'])).resolves.toBe(0);
    await expect(testWithOutput('/engine', ['browser/test'], ['--headless'])).resolves.toEqual({
      stdout: 'stream',
      stderr: '',
      exitCode: 0,
    });

    expect(execInherit).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'bootstrap', '--application-choice', 'browser'],
      expect.any(Object)
    );
    expect(execInheritCapture).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'build', '-j', '4'],
      expect.any(Object)
    );
    expect(execInheritCapture).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'build'],
      expect.any(Object)
    );
    expect(execInheritCapture).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'build', 'faster'],
      expect.any(Object)
    );
    expect(execInherit).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'run', '--safe-mode'],
      expect.any(Object)
    );
    expect(execInherit).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'package'],
      expect.any(Object)
    );
    expect(execInherit).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'watch'],
      expect.any(Object)
    );
    expect(execInherit).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'test', 'browser/test', '--headless'],
      expect.any(Object)
    );
    expect(execInheritCapture).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'bootstrap', '--application-choice', 'browser'],
      expect.any(Object)
    );
    expect(execInheritCapture).toHaveBeenCalledWith(
      'python3.12',
      ['/engine/mach', 'watch'],
      expect.any(Object)
    );

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('forwards runMachSmoke options through to execSmokeRun without undefined keys', async () => {
    const { execSmokeRun } = await import('../../utils/process.js');
    await primePythonResolution();
    vi.mocked(execSmokeRun).mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    const onStdoutLine = vi.fn();
    const onStderrLine = vi.fn();
    const mirror = { stdout: process.stdout, stderr: process.stderr };

    await expect(
      runMachSmoke(['run'], '/engine', {
        env: { SMOKE: '1' },
        smokeTimeoutMs: 30_000,
        killGraceMs: 5_000,
        onStdoutLine,
        onStderrLine,
        mirror,
      })
    ).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0, timedOut: false });

    // Every optional key is present on the forwarded options when the
    // caller supplied it. The conditional spreads inside runMachSmoke are
    // there specifically to avoid tripping exactOptionalPropertyTypes, so
    // the assertion shape has to match — a plain objectContaining would
    // pass even with `key: undefined`.
    expect(execSmokeRun).toHaveBeenCalledWith('python3.12', ['/engine/mach', 'run'], {
      cwd: '/engine',
      env: { SMOKE: '1' },
      smokeTimeoutMs: 30_000,
      killGraceMs: 5_000,
      onStdoutLine,
      onStderrLine,
      mirror,
    });
  });

  it('omits optional keys from forwarded runMachSmoke options when unset', async () => {
    // Mirrors the exactOptionalPropertyTypes contract — a missing option
    // must leave its key absent, not set it to undefined. Previously we
    // relied on this implicitly; the test pins it down.
    const { execSmokeRun } = await import('../../utils/process.js');
    await primePythonResolution();
    vi.mocked(execSmokeRun).mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 143,
      timedOut: true,
    });

    await expect(runMachSmoke(['run'], '/engine', { smokeTimeoutMs: 15_000 })).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 143,
      timedOut: true,
    });

    expect(execSmokeRun).toHaveBeenCalledWith('python3.12', ['/engine/mach', 'run'], {
      cwd: '/engine',
      smokeTimeoutMs: 15_000,
    });
  });

  it('surfaces preprocessor hints on a failed mach build', async () => {
    const { execInheritCapture } = await import('../../utils/process.js');
    const { warn } = await import('../../utils/logger.js');
    await primePythonResolution();

    const stderr = [
      'mozbuild.preprocessor.Preprocessor.Error: (',
      "'mybrowser.js', None, 'no preprocessor directives found', None",
      ')',
    ].join('\n');
    vi.mocked(execInheritCapture).mockResolvedValueOnce({ stdout: '', stderr, exitCode: 1 });
    const warnMock = vi.mocked(warn);
    warnMock.mockClear();

    await expect(build('/engine')).resolves.toMatchObject({ exitCode: 1 });
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('JS_PREFERENCE_FILES'));
  });

  it('surfaces preprocessor hints on a failed mach build faster (UI-only)', async () => {
    const { execInheritCapture } = await import('../../utils/process.js');
    const { warn } = await import('../../utils/logger.js');
    await primePythonResolution();

    const stderr = [
      'mozbuild.preprocessor.Preprocessor.Error: (',
      "'mybrowser.js', None, 'no preprocessor directives found', None",
      ')',
    ].join('\n');
    vi.mocked(execInheritCapture).mockResolvedValueOnce({ stdout: '', stderr, exitCode: 2 });
    const warnMock = vi.mocked(warn);
    warnMock.mockClear();

    await expect(buildUI('/engine')).resolves.toMatchObject({ exitCode: 2 });
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('JS_PREFERENCE_FILES'));
  });

  it('stays silent when a failing mach build has no recognized hint patterns', async () => {
    const { execInheritCapture } = await import('../../utils/process.js');
    const { warn } = await import('../../utils/logger.js');
    await primePythonResolution();

    vi.mocked(execInheritCapture).mockResolvedValueOnce({
      stdout: '',
      stderr: 'Some unrelated build error',
      exitCode: 1,
    });
    const warnMock = vi.mocked(warn);
    warnMock.mockClear();

    await expect(build('/engine')).resolves.toMatchObject({ exitCode: 1 });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('surfaces the bindgen hint when the _CharT error lands on stdout instead of stderr', async () => {
    // Finding #5: the eval's Darwin 25 Rust error streamed through mach's
    // timestamp-prefixing wrapper on stdout, but pre-0.16.0 `build()` only
    // scanned `result.stderr` for hints. Combined stdout+stderr scanning
    // makes the registered `_CharT` hint fire against whichever stream
    // mach chose.
    const { execInheritCapture } = await import('../../utils/process.js');
    const { warn } = await import('../../utils/logger.js');
    await primePythonResolution();

    const stdout = [
      ' 1:25.29 error[E0425]: cannot find type `_CharT` in this scope',
      ' 1:25.29   --> /build/obj-debug/release/build/gecko-profiler-abc123/out/gecko/bindings.rs:1877:67',
    ].join('\n');
    vi.mocked(execInheritCapture).mockResolvedValueOnce({ stdout, stderr: '', exitCode: 2 });
    const warnMock = vi.mocked(warn);
    warnMock.mockClear();

    await expect(build('/engine')).resolves.toMatchObject({ exitCode: 2 });
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('gecko-profiler'));
  });

  it('surfaces the post-failure epilogue hint on a failed mach build that appends Configure complete!', async () => {
    // Finding #6: mach's own shutdown pipeline prints a "Configure
    // complete!" banner after a failed build, which reads like success.
    // The hint now recognises the exact post-failure signature and
    // clarifies the trailing block.
    const { execInheritCapture } = await import('../../utils/process.js');
    const { warn } = await import('../../utils/logger.js');
    await primePythonResolution();

    const stdout = [
      ' 2:22.26 make: *** [build] Error 2',
      ' 2:22.36 W 87 compiler warnings present.',
      ' Config object not found by mach.',
      'Configure complete!',
      'Be sure to run |mach build| to pick up any changes',
    ].join('\n');
    vi.mocked(execInheritCapture).mockResolvedValueOnce({ stdout, stderr: '', exitCode: 2 });
    const warnMock = vi.mocked(warn);
    warnMock.mockClear();

    await expect(build('/engine')).resolves.toMatchObject({ exitCode: 2 });
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('post-failure configure summary')
    );
  });
});
