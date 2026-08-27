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
  xpcshellTestWithOutput,
} from '../../core/mach.js';
import {
  assertMarionettePortAvailable,
  ensureLaunchableBrowserNotRunning,
  ensureMarionettePortAvailable,
  probeMarionettePort,
} from '../../core/marionette-port.js';
import { runMarionettePreflight } from '../../core/marionette-preflight.js';
import {} from '../../core/test-stale-check.js';
import {
  findNearestXpcshellManifest,
  operatorAlreadySetAppPath,
  resolveXpcshellAppdirArg,
} from '../../core/xpcshell-appdir.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { testCommand } from '../test.js';

// Marionette port forwarding and xpcshell --app-path injection. Split out
// of `test.test.ts`; the shared `vi.mock` header comes from
// `test-command-mocks.ts`.
describe('testCommand Marionette and appdir forwarding', () => {
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

  it('skips the Marionette preflight and client flags for xpcshell-only runs', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).not.toHaveBeenCalled();
    expect(ensureLaunchableBrowserNotRunning).not.toHaveBeenCalled();
    const [, , extraArgs] = vi.mocked(xpcshellTestWithOutput).mock.calls[0] ?? [];
    expect(extraArgs).not.toEqual(
      expect.arrayContaining([expect.stringContaining('--setpref=marionette.port')])
    );
    expect(extraArgs).not.toEqual(
      expect.arrayContaining([expect.stringContaining('--marionette=')])
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('preflight probe only'));
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping the Marionette stale-port preflight')
    );
  });

  it('xpcshell-only + --kill-stale-marionette does not touch the port', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {
        killStaleMarionette: true,
      })
    ).resolves.toBeUndefined();

    expect(ensureMarionettePortAvailable).not.toHaveBeenCalled();
    expect(assertMarionettePortAvailable).not.toHaveBeenCalled();
    expect(ensureLaunchableBrowserNotRunning).not.toHaveBeenCalled();
  });

  it('probes the mochitest server port for a browser-chrome run', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    await testCommand('/project', ['browser/base/content/test/browser_tile.js'], {});
    // The httpd probe reuses the port-generic Marionette probe, so seeing
    // it called for 8888 is what proves the preflight ran.
    expect(probeMarionettePort).toHaveBeenCalledWith(8888);
  });

  it('does NOT probe the mochitest server port for an xpcshell-only run', async () => {
    // xpcshell does not use the harness httpd, so a developer's unrelated
    // service on 8888 must not block an xpcshell run.
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    await testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {});
    expect(probeMarionettePort).not.toHaveBeenCalledWith(8888);
  });

  it('keeps the Marionette preflight for xpcshell-only --doctor runs', async () => {
    // Set explicitly: while this case lived in the 2,900-line file it
    // inherited a preflight result a much earlier `it` had left behind on
    // the shared mock, and would have thrown on its own.
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 120,
      detail: 'connected',
    });
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {
        doctor: true,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalled();
  });

  it('ignores an empty --mach-arg array without appending anything', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        machArg: [],
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      []
    );
  });

  it('auto-injects --app-path when the resolver returns an "injected" outcome', async () => {
    // Simulates a rebranded fork (appname=mybrowser) whose xpcshell.toml
    // sets `firefox-appdir = "browser"`. The resolver returns the
    // absolute path it computed against obj-debug/dist/, and the test
    // command must append `--app-path=<abs>` to the mach test args so
    // the harness uses the right root rather than falling back to xrePath.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'injected',
      result: {
        appPath: '/project/engine/obj-debug/dist/bin/browser',
        manifestPath: '/project/engine/browser/base/content/test/foo/xpcshell.toml',
        key: 'firefox-appdir',
        relativeAppdir: 'browser',
      },
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'])
    ).resolves.toBeUndefined();

    expect(resolveXpcshellAppdirArg).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      'obj-debug'
    );
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      ['--app-path=/project/engine/obj-debug/dist/bin/browser']
    );
  });

  it('does not auto-inject when the operator already passed --app-path via --mach-arg', async () => {
    // Operator override takes precedence: the resolver must not even be
    // consulted to compute its outcome. The recorded call confirms the
    // skip path runs before resolution.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(operatorAlreadySetAppPath).mockReturnValueOnce(true);

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'], {
        machArg: ['--app-path=/custom/path'],
      })
    ).resolves.toBeUndefined();

    expect(resolveXpcshellAppdirArg).not.toHaveBeenCalled();
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      ['--app-path=/custom/path']
    );
  });

  it('warns and skips injection when the resolver reports a mismatch across paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'mismatch',
      values: ['/p/A/dist/bin/browser', '/p/B/dist/bin/xulrunner'],
    });

    // Multi-path appdir mismatch only arises in a combined invocation;
    // default sharding would probe each path's manifest separately.
    await expect(
      testCommand(
        '/project',
        ['browser/base/content/test/A/test_a.js', 'browser/base/content/test/B/test_b.js'],
        { shard: false }
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/multiple test paths resolved to different app dirs/)
    );
    // No --app-path injected.
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/A/test_a.js', 'browser/base/content/test/B/test_b.js'],
      []
    );
  });

  it('warns and skips injection when the resolver cannot find the appdir under dist', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'unresolved',
      relativeAppdir: 'browser',
      manifestPath: '/project/engine/browser/base/content/test/foo/xpcshell.toml',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'])
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/no matching directory exists under obj-debug\/dist/)
    );
  });

  it('rewrites xpcshell appdir failures with an injection-attempted hint when injection fired', async () => {
    // After auto-injection runs and the xpcshell symptom STILL fires, the
    // diagnostic message must say so — the operator needs to know
    // FireForge already tried the easy fix and the cause lies elsewhere.
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'injected',
      result: {
        appPath: '/project/engine/obj-debug/dist/bin/browser',
        manifestPath: '/project/engine/x/xpcshell.toml',
        key: 'firefox-appdir',
        relativeAppdir: 'browser',
      },
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/Something.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_something.js'])
    ).rejects.toThrow(/auto-injected `--app-path=<absolute>` against the resolved obj-dir/);
  });

  it('keeps the original "Likely triggers" wording when injection did not run', async () => {
    // Default mock returns kind: 'none' — no injection. The diagnostic
    // hint must keep its pre-injection wording so the operator sees the
    // appname-key explanation that points at the underlying upstream
    // behaviour rather than at FireForge's auto-injection path.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/Something.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_something.js'])
    ).rejects.toThrow(/literal `firefox-appdir` directive is silently ignored/);
  });

  // ── --marionette-port option ──────────────────────────────────────────

  it('passes --marionette-port through to the stale-browser probe', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(ensureLaunchableBrowserNotRunning).toHaveBeenCalledWith(
      '/project/engine/obj-debug/dist/bin/firefox',
      { killStaleBrowser: false }
    );
  });

  it('auto-forwards setpref and mochitest --marionette client for browser-chrome paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2912,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--setpref=marionette.port=2912', '--marionette=127.0.0.1:2912']
    );
  });

  it('auto-forwards --setpref=marionette.port=N for toolkit widget HTML paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['toolkit/content/tests/widgets/test_moz-example.html'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['toolkit/content/tests/widgets/test_moz-example.html'],
      ['--setpref=marionette.port=2838', '--marionette=127.0.0.1:2838']
    );
  });

  it('auto-forwards --setpref for xpcshell filesystem paths without --flavor=xpcshell', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['toolkit/components/tests/xpcshell/test_observer.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['toolkit/components/tests/xpcshell/test_observer.js'],
      ['--setpref=marionette.port=2838', '--marionette=127.0.0.1:2838']
    );
  });

  it('does not auto-forward when the operator already passed the port via --mach-arg', async () => {
    // The forwarded mach-arg is recognised by extractForwardedMarionettePort;
    // the wrapper preflight then targets 2838 too, but the auto-forward must
    // not duplicate the operator's arg in extraArgs.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2838,
        machArg: ['--marionette-port=2838'],
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--marionette-port=2838', '--marionette=127.0.0.1:2838']
    );
  });

  it('does not add a second --marionette when --mach-arg already sets the client endpoint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2912,
        machArg: ['--marionette=127.0.0.1:2912'],
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--marionette=127.0.0.1:2912', '--setpref=marionette.port=2912']
    );
  });

  it('parses a forwarded --mach-arg --marionette-port=N as the effective port (no first-class option)', async () => {
    // The documented workaround: operator passes the port via --mach-arg.
    // Pre-fix, the wrapper preflight checked the default 2828 before the
    // forwarded arg ever reached mach. Now extractForwardedMarionettePort
    // surfaces the value to the probe so the workaround actually works.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        machArg: ['--marionette-port=2838'],
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
  });

  it('does not auto-forward to mach for an explicit xpcshell flavor', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['toolkit/components/tests/xpcshell/test_observer.js'], {
        marionettePort: 2838,
        machArg: ['--flavor=xpcshell'],
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['toolkit/components/tests/xpcshell/test_observer.js'],
      ['--flavor=xpcshell']
    );
  });

  it('passes --marionette-port through to the doctor preflight', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 12_000,
      detail: 'handshake ok',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        doctor: true,
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(runMarionettePreflight).toHaveBeenCalledWith('/project/engine', { port: 2838 });
  });
});
