// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', async () => (await import('./test-command-mocks.js')).configMock());

vi.mock('../../core/mach.js', async () => (await import('./test-command-mocks.js')).machMock());

vi.mock('../../core/build-prepare.js', async () =>
  (await import('./test-command-mocks.js')).buildPrepareMock()
);

vi.mock('../../core/build-baseline.js', async () =>
  (await import('./test-command-mocks.js')).buildBaselineMock()
);

// The --extend-coverage anchor probes real git/file state (covered by
// src/core/__tests__/coverage-extend.test.ts); here the command-level
// contract is what the command does with each verdict, so the probes are
// mocked and the union stays real.
vi.mock('../../core/coverage-extend.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).coverageExtendMock(importOriginal)
);

// Default to the pass-through analysis (file args, no siblings) so every
// existing dispatch assertion stays valid; the directory-scope tests
// override per case. formatScopeNotice stays real so notice assertions
// pin the actual wording. The fs-walking analysis itself is covered by
// src/core/__tests__/test-path-scope.test.ts.
vi.mock('../../core/test-path-scope.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).testPathScopeMock(importOriginal)
);

vi.mock('../../utils/fs.js', async () => (await import('./test-command-mocks.js')).fsMock());

vi.mock('../../utils/logger.js', async () =>
  (await import('./test-command-mocks.js')).loggerMock()
);

vi.mock('../../utils/platform.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).platformMock(importOriginal)
);

vi.mock('../../core/marionette-preflight.js', async () =>
  (await import('./test-command-mocks.js')).marionettePreflightMock()
);

// Default to "port is free" so every existing test case proceeds
// through the probe to the mach invocation. The dedicated port-probe
// tests in `src/core/__tests__/marionette-port.test.ts` exercise the
// holder detection and error shape in isolation.
vi.mock('../../core/marionette-port.js', async () =>
  (await import('./test-command-mocks.js')).marionettePortMock()
);

// Partial mock: the probes and warning copy stay stubbed, but the pure
// coverage helpers (`findUncoveredRequestPaths`, `formatTestCoverageRefusal`,
// `formatStaticComponentsRefusal`) run real so the refusal tests pin the
// actual matcher semantics and message wording through the command.
vi.mock('../../core/test-stale-check.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).testStaleCheckMock(importOriginal)
);

vi.mock('../../core/xpcshell-appdir.js', async () =>
  (await import('./test-command-mocks.js')).xpcshellAppdirMock()
);

// The in-tree objdir/marker cross-check is a pass-through by default; the
// dedicated test drives its refusal. Real behavior is covered in
// tree-store.integration.test.ts.
vi.mock('../../core/tree-store.js', async () =>
  (await import('./test-command-mocks.js')).treeStoreMock()
);

import {} from '../../core/coverage-extend.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  runProtectedMachBuild,
  testWithOutput,
} from '../../core/mach.js';
import {} from '../../core/marionette-port.js';
import { runMarionettePreflight } from '../../core/marionette-preflight.js';
import {} from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { GeneralError } from '../../errors/base.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { testCommand } from '../test.js';

// xpcshell / mochitest failure-hint rewriting and stale harness symlink
// recovery. Split out of `test.test.ts`; the shared `vi.mock` header comes
// from `test-command-mocks.ts`.
describe('testCommand xpcshell and mochitest failure hints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(null);
    vi.mocked(isSymlink).mockResolvedValue(false);
    vi.mocked(removeFile).mockResolvedValue();
  });

  it('proceeds to mach test when the preflight passes and test paths are supplied', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 120,
      detail: 'handshake',
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        doctor: true,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalled();
  });

  it('rewrites xpcshell resource:///modules/ failures into the appdir hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/CanvasMath.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_canvas_math.js'])
    ).rejects.toThrow(/xpcshell failed to load core resource:\/\/\/modules/);
  });

  it('throws the xpcshell appdir hint as GeneralError, not BuildError', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/Something.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_something.js'])
    ).rejects.toBeInstanceOf(GeneralError);
  });

  it('falls through to the xpcshell-appdir hint when only resource:///modules/* is named', async () => {
    // The stale-build signal must not match
    // `resource:///modules/distribution.sys.mjs` on its own — that literal
    // produces false-positive "rebuild" advice for fork-custom module-load
    // failures that are actually appdir issues. A generic
    // `Failed to load resource:///modules/…` routes straight to the
    // xpcshell-appdir hint, the right first guess in practice.
    // Branding-specific stale signals (brand.properties, branding moz.build)
    // still win ahead of it.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/distribution.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'])
    ).rejects.toThrow(/xpcshell failed to load core resource/i);
  });

  it('routes fork-custom resource module failures to the xpcshell-appdir hint', async () => {
    // A fork-shaped resource path whose module subdirectory does NOT match
    // this project's binaryName surfaces as "rebuild" advice under a broader
    // `resource:///modules/…` pattern. Narrowed, the right hint wins —
    // app-path injection, not rebuild — when the fork-module signal does not
    // match the configured binaryName.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/otherfork/OtherForkStore.sys.mjs',
    });

    await expect(
      testCommand('/project', [
        'browser/components/tests/unit/test_browserGlue_otherfork_startup.js',
      ])
    ).rejects.toThrow(/xpcshell failed to load core resource/i);
  });

  it('rewrites the MochitestDesktop http3Server AttributeError into the branding-registration hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        "File \"/project/engine/obj-debug/_tests/testing/mochitest/runtests.py\", line 1519, in stopServers: if self.http3Server is not None: AttributeError: 'MochitestDesktop' object has no attribute 'http3Server'",
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/browser_mybrowser_canvas.js'])
    ).rejects.toThrow(/chrome:\/\/branding/);
  });

  it('throws the mochitest http3Server hint as GeneralError, not BuildError', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: "AttributeError: 'MochitestDesktop' object has no attribute 'http3Server'",
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/browser_mybrowser_canvas.js'])
    ).rejects.toBeInstanceOf(GeneralError);
  });

  it('rewrites stale mochitest symlink setup failures into a harness-state hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'FileExistsError: [Errno 17] File exists: mochitest',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'])
    ).rejects.toThrow(/stale harness setup/i);
  });

  it('removes a stale xpcshell _tests symlink and retries mach test once', async () => {
    const staleLink =
      '/project/engine/obj-debug/_tests/xpcshell/toolkit/mozapps/extensions/test/xpcshell/data/bug455906_block.xml';
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/toolkit/mozapps/extensions/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(true);
    vi.mocked(testWithOutput)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: `FileExistsError: [Errno 17] File exists: '/src/bug455906_block.xml' -> '${staleLink}'`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
        stderr: '',
      });

    await expect(
      testCommand('/project', [
        'toolkit/mozapps/extensions/test/xpcshell/test_bug455906_blocklist.js',
      ])
    ).resolves.toBeUndefined();

    expect(removeFile).toHaveBeenCalledWith(staleLink);
    expect(testWithOutput).toHaveBeenCalledTimes(2);
  });

  it('removes stale xpcshell install symlinks under the shared mochitest harness tree', async () => {
    const staleLink =
      '/project/engine/obj-debug/_tests/testing/mochitest/browser/browser/extensions/formautofill/test/fixtures/autocomplete_address_basic.html';
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/extensions/formautofill/test/unit/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(true);
    vi.mocked(testWithOutput)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: `FileExistsError: [Errno 17] File exists: '/src/autocomplete_address_basic.html' -> '${staleLink}'`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
        stderr: '',
      });

    await expect(
      testCommand('/project', ['browser/extensions/formautofill/test/unit/test_sync.js'])
    ).resolves.toBeUndefined();

    expect(removeFile).toHaveBeenCalledWith(staleLink);
    expect(testWithOutput).toHaveBeenCalledTimes(2);
  });

  it('does not remove FileExistsError destinations outside the active _tests tree', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/toolkit/mozapps/extensions/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(true);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout:
        "xpcshell FileExistsError: [Errno 17] File exists: '/src' -> '/tmp/not-fireforge.xml'",
      stderr: '',
    });

    await expect(
      testCommand('/project', [
        'toolkit/mozapps/extensions/test/xpcshell/test_bug455906_blocklist.js',
      ])
    ).rejects.toThrow(/stale harness setup/i);

    expect(removeFile).not.toHaveBeenCalled();
    expect(testWithOutput).toHaveBeenCalledTimes(1);
  });

  it('does not remove a stale xpcshell destination unless it is a symlink', async () => {
    const stalePath = '/project/engine/obj-debug/_tests/xpcshell/data/bug455906_block.xml';
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/toolkit/mozapps/extensions/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(false);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: `FileExistsError: [Errno 17] File exists: '/src' -> '${stalePath}'`,
      stderr: '',
    });

    await expect(
      testCommand('/project', [
        'toolkit/mozapps/extensions/test/xpcshell/test_bug455906_blocklist.js',
      ])
    ).rejects.toThrow(/stale harness setup/i);

    expect(removeFile).not.toHaveBeenCalled();
    expect(testWithOutput).toHaveBeenCalledTimes(1);
  });

  it('forwards --mach-arg values verbatim to testWithOutput after --headless', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        headless: true,
        machArg: ['--verbose', '--keep-going'],
      })
    ).resolves.toBeUndefined();

    // Order matters: FireForge-managed flags first, passthrough last.
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      ['--headless', '--verbose', '--keep-going']
    );
  });

  it('filters redundant --flavor=xpcshell when xpcshell is inferred from the manifest', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/foo/xpcshell.toml'
    );

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'], {
        machArg: ['--flavor=xpcshell', '--verbose'],
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      ['--verbose'],
      expect.objectContaining({ XPCSHELL_TEST_PROFILE_DIR: expect.any(String) as string })
    );
  });

  it('fails before mach when xpcshell and browser paths are mixed', async () => {
    vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
      Promise.resolve(path.includes('/xpcshell/') ? '/project/engine/foo/xpcshell.toml' : null)
    );

    await expect(
      testCommand('/project', [
        'browser/base/content/test/xpcshell/test_tile.js',
        'browser/base/content/test/browser/browser_tile.js',
      ])
    ).rejects.toThrow(/cannot run xpcshell and browser\/mochitest paths/i);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses a mixed request before dispatching the pre-test build', async () => {
    vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
      Promise.resolve(path.includes('/xpcshell/') ? '/project/engine/foo/xpcshell.toml' : null)
    );

    await expect(
      testCommand(
        '/project',
        [
          'browser/base/content/test/xpcshell/test_tile.js',
          'browser/base/content/test/browser/browser_tile.js',
        ],
        { build: true }
      )
    ).rejects.toThrow(/cannot run xpcshell and browser\/mochitest paths/i);

    expect(runProtectedMachBuild).not.toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });
});
