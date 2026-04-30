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
  // Default to "launchable bundle present" so existing tests keep passing
  // through the new runnable-bundle preflight added for finding 17. The
  // dedicated regression test for the missing-binary branch overrides
  // this with mockResolvedValueOnce({ runnable: false, ... }).
  hasRunnableBundle: vi.fn(() =>
    Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/firefox' })
  ),
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
  outro: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../core/marionette-preflight.js', () => ({
  runMarionettePreflight: vi.fn(),
  reportMarionettePreflight: vi.fn(),
  formatMarionettePreflightLine: (result: { ok: boolean; durationMs: number; detail: string }) => {
    const status = result.ok ? 'PASS' : 'FAIL';
    return `Marionette preflight: ${status} (${result.durationMs}ms) — ${result.detail}`;
  },
}));

// Default to "port is free" so every existing test case proceeds
// through the probe to the mach invocation. The dedicated port-probe
// tests in `src/core/__tests__/marionette-port.test.ts` exercise the
// holder detection and error shape in isolation.
vi.mock('../../core/marionette-port.js', async () => {
  // Use the real `extractForwardedMarionettePort` and `isMarionetteFlavor`
  // helpers — they are pure parsing utilities and exercising them through
  // the test command keeps the integration honest. Mock only the I/O-shaped
  // probe so the mach invocation is reached.
  const actual = await vi.importActual<typeof import('../../core/marionette-port.js')>(
    '../../core/marionette-port.js'
  );
  return {
    ...actual,
    assertMarionettePortAvailable: vi.fn(() => Promise.resolve()),
    probeMarionettePort: vi.fn(() => Promise.resolve({ inUse: false })),
  };
});

vi.mock('../../core/test-stale-check.js', () => ({
  checkStaleBuildForTest: vi.fn(() =>
    Promise.resolve({ stale: false, changedPaths: [], truncated: 0, baseline: undefined })
  ),
  formatStaleBuildWarning: vi.fn(() => 'stale warning'),
}));

vi.mock('../../core/xpcshell-appdir.js', () => ({
  resolveXpcshellAppdirArg: vi.fn(() => Promise.resolve({ kind: 'none' })),
  operatorAlreadySetAppPath: vi.fn(() => false),
}));

import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import {
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  testWithOutput,
} from '../../core/mach.js';
import { assertMarionettePortAvailable } from '../../core/marionette-port.js';
import {
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../../core/marionette-preflight.js';
import { checkStaleBuildForTest, formatStaleBuildWarning } from '../../core/test-stale-check.js';
import { operatorAlreadySetAppPath, resolveXpcshellAppdirArg } from '../../core/xpcshell-appdir.js';
import { GeneralError } from '../../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../../errors/build.js';
import { pathExists } from '../../utils/fs.js';
import { outro, success, warn } from '../../utils/logger.js';
import { testCommand } from '../test.js';

describe('testCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(buildUI).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
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

  it('routes fork-module load failures to the module-registration hint (Eval 1 Finding #14)', async () => {
    // Both the fork-module signal AND the branding-stale signal fire
    // because the harness teardown prints a branding warning. The
    // fork-module diagnosis must win — telling the operator to rebuild
    // when the module is missing from moz.build sends them in a loop.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout:
        'ERROR Error: Failed to load resource:///modules/mybrowser/MybrowserStore.sys.mjs\n' +
        'No chrome package registered for chrome://branding/locale/brand.properties',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_mybrowser_store.js'])
    ).rejects.toThrow(/module-registration issue/i);
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
    vi.mocked(buildUI).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

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
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await expect(testCommand('/project', [], { doctor: true })).resolves.toBeUndefined();

      expect(runMarionettePreflight).toHaveBeenCalledWith('/project/engine');
      expect(reportMarionettePreflight).toHaveBeenCalled();
      expect(testWithOutput).not.toHaveBeenCalled();
      // 2026-04-24 eval Finding 7: the doctor-only success path now writes
      // the PASS line via `process.stdout.write` as the authoritative
      // emission so non-TTY captures always see the summary. The clack
      // `success()` + `outro('Test completed')` calls stay for TTY users
      // who rely on the visual framing.
      expect(success).toHaveBeenCalledWith(expect.stringMatching(/Marionette preflight: PASS/));
      expect(outro).toHaveBeenCalledWith('Test completed');
      const rawWrites = writeSpy.mock.calls
        .map((args) => args[0])
        .filter((chunk): chunk is string => typeof chunk === 'string');
      expect(rawWrites.some((chunk) => /Running marionette preflight\.\.\./.test(chunk))).toBe(
        true
      );
      expect(rawWrites.some((chunk) => /Marionette preflight: PASS \(200ms\)/.test(chunk))).toBe(
        true
      );
    } finally {
      writeSpy.mockRestore();
    }
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
    // 0.16.0 narrowing: the stale-build signal no longer matches
    // `resource:///modules/distribution.sys.mjs` on its own — that literal
    // was producing false-positive "rebuild" advice for fork-custom
    // module-load failures (the eval saw this for
    // `HominisStore.sys.mjs`, which was actually an appdir issue). A
    // generic `Failed to load resource:///modules/…` now routes straight
    // to the xpcshell-appdir hint, which is the right first guess in
    // practice. Branding-specific stale signals (brand.properties,
    // branding moz.build) still win ahead of xpcshell-appdir.
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
    // Eval regression: the hominis
    // `Failed to load resource:///modules/hominis/HominisStore.sys.mjs`
    // failure surfaced as "rebuild" advice before the narrowing, because
    // `distribution.sys.mjs` wasn't there but the broader pattern caught
    // any `resource:///modules/…`. After the narrowing the right hint
    // wins — app-path injection, not rebuild.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/hominis/HominisStore.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_browserGlue_hominis_startup.js'])
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

  it('forwards --mach-arg values verbatim to testWithOutput after --headless', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

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

  it('ignores an empty --mach-arg array without appending anything', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'mismatch',
      values: ['/p/A/dist/bin/browser', '/p/B/dist/bin/xulrunner'],
    });

    await expect(
      testCommand('/project', [
        'browser/base/content/test/A/test_a.js',
        'browser/base/content/test/B/test_b.js',
      ])
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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
  });

  it('auto-forwards --setpref=marionette.port=N to mach for browser-chrome paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--setpref=marionette.port=2838']
    );
  });

  it('does not auto-forward when the operator already passed the port via --mach-arg', async () => {
    // The forwarded mach-arg is recognised by extractForwardedMarionettePort;
    // the wrapper preflight then targets 2838 too, but the auto-forward must
    // not duplicate the operator's arg in extraArgs.
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

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
      ['--marionette-port=2838']
    );
  });

  it('parses a forwarded --mach-arg --marionette-port=N as the effective port (no first-class option)', async () => {
    // The documented workaround: operator passes the port via --mach-arg.
    // Pre-fix, the wrapper preflight checked the default 2828 before the
    // forwarded arg ever reached mach. Now extractForwardedMarionettePort
    // surfaces the value to the probe so the workaround actually works.
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

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
    vi.mocked(testWithOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
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
