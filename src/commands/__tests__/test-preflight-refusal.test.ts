// SPDX-License-Identifier: EUPL-1.2
/**
 * A `fireforge test` preflight refusal has to reach both channels an
 * unattended operator actually keeps: the captured stdout stream and the
 * run log the verdict line names.
 *
 * It reached neither. `emitFailVerdict` seals stdout (so the verdict stays
 * the last line), which routes `withErrorHandling`'s rendering to stderr,
 * and that rendering happens after `testCommand`'s `finally` has already
 * closed the run log. A redirected run therefore kept
 * `FIREFORGE-VERDICT: FAIL reason=preflight` and nothing else, while the
 * log it pointed at held only the pre-test build.
 *
 * The run log is real here (not the shared mock the sibling suites use):
 * the bug was in what reached the file, so a mocked sink could not see it.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', async () => (await import('./test-command-mocks.js')).configMock());

vi.mock('../../core/mach.js', async () => (await import('./test-command-mocks.js')).machMock());

vi.mock('../../core/build-prepare.js', async () =>
  (await import('./test-command-mocks.js')).buildPrepareMock()
);

vi.mock('../../core/build-baseline.js', async () =>
  (await import('./test-command-mocks.js')).buildBaselineMock()
);

// The --extend-coverage anchor probes real git/file state (covered by
// src/core/__tests__/coverage-extend.test.ts). Here the command-level
// contract is what the command does with each verdict, so the probes are
// mocked and the union stays real.
vi.mock('../../core/coverage-extend.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).coverageExtendMock(importOriginal)
);

// Default to the pass-through analysis (file args, no siblings) so every
// existing dispatch assertion stays valid. The directory-scope tests
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

// The in-tree objdir/marker cross-check is a pass-through by default. The
// dedicated test drives its refusal. Real behavior is covered in
// tree-store.integration.test.ts.
vi.mock('../../core/tree-store.js', async () =>
  (await import('./test-command-mocks.js')).treeStoreMock()
);

vi.mock('../../core/mochitest-server-port.js', () => ({
  ensureMochitestServerPortAvailable: vi.fn(),
}));
vi.mock('../../core/harness-orphans.js', () => ({
  reportOrphanedHarnessProcesses: vi.fn(() => Promise.resolve([])),
}));

import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../../core/config.js';
import { reportOrphanedHarnessProcesses } from '../../core/harness-orphans.js';
import {
  hasBuildArtifacts,
  hasRunnableBundle,
  runMachTestSuite,
  runProtectedMachBuild,
} from '../../core/mach.js';
import { assertMarionettePortAvailable } from '../../core/marionette-port.js';
import { ensureLaunchableBrowserNotRunning } from '../../core/marionette-port.js';
import { ensureMochitestServerPortAvailable } from '../../core/mochitest-server-port.js';
import { checkStaleBuildForTest } from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { LockContentionError, PreflightRefusalError } from '../../errors/base.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { testCommand } from '../test.js';
import { ensureTestBrowserEnvironment } from '../test-browser-preflight.js';

const STALE_BROWSER_TEXT =
  "A browser from this project's objdir is already running (PID 4242).\nStop it and retry.";

let projectRoot: string;
let stdout: string;
let restoreStdout: () => void;

/** Contents of the single run log this run opened. */
async function readRunLog(): Promise<string> {
  const dir = join(projectRoot, '.fireforge', 'logs');
  const files = await readdir(dir);
  const logs = files.filter((name) => name.startsWith('test-'));
  expect(logs).toHaveLength(1);
  return readFile(join(dir, logs[0] ?? ''), 'utf8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  projectRoot = await mkdtemp(join(tmpdir(), 'ff-preflight-log-'));
  stdout = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    stdout += String(chunk);
    return true;
  };
  restoreStdout = (): void => {
    process.stdout.write = original;
  };
  vi.mocked(pathExists).mockResolvedValue(true);
  vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
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

afterEach(async () => {
  restoreStdout();
  await rm(projectRoot, { recursive: true, force: true });
});

describe('the lock-free head of the run', () => {
  it('refuses a missing launchable binary before the lock is requested, naming its class', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValueOnce({
      runnable: false,
      expectedPath: 'obj-debug/dist/bin/firefox',
    });
    const underLock = vi.fn((body: () => Promise<void>) => body());
    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], {}, underLock)
    ).rejects.toThrow(/launchable binary is missing/);
    expect(underLock).not.toHaveBeenCalled();
    expect(stdout).toContain('note=no-launchable-binary');
  });

  it('emits lock-timeout (not preflight) when the lock runner gives up, with the log named', async () => {
    const underLock = vi.fn(() =>
      Promise.reject(new LockContentionError('Another engine-mutating command holds the lock.'))
    );
    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], {}, underLock)
    ).rejects.toThrow(LockContentionError);
    expect(stdout).not.toContain('Preflight refused:');
    expect(stdout.trimEnd().split('\n').at(-1)).toMatch(
      /^FIREFORGE-VERDICT: FAIL reason=lock-timeout log=/
    );
  });

  it('keeps a --keep-log copy of the run, refusal included', async () => {
    vi.mocked(ensureLaunchableBrowserNotRunning).mockRejectedValueOnce(
      new PreflightRefusalError(STALE_BROWSER_TEXT, 'stale-browser')
    );
    const kept = join(projectRoot, 'kept', 'run.log');
    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], { keepLog: kept })
    ).rejects.toThrow(PreflightRefusalError);
    expect(await readFile(kept, 'utf8')).toBe(await readRunLog());
    expect(await readFile(kept, 'utf8')).toContain('already running (PID 4242)');
  });
});

describe('a named file no harness can run', () => {
  const unit = 'browser/modules/hominis/test/unit';
  async function engineWith(files: Record<string, string>): Promise<void> {
    const engine = join(projectRoot, 'engine');
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(engine, path, '..'), { recursive: true });
      await writeFile(join(engine, path), text);
    }
    const paths = getProjectPaths(projectRoot);
    vi.mocked(getProjectPaths).mockReturnValue({ ...paths, engine });
  }

  it('refuses a support file before the build or the harness, naming the tests that read it', async () => {
    await engineWith({
      [`${unit}/xpcshell.toml`]:
        '["test_HominisStoreSchema.js"]\nsupport-files = ["fixtures/*.sqlite"]\n',
      [`${unit}/test_HominisStoreSchema.js`]: '',
      [`${unit}/fixtures/schema-v10.sqlite`]: 'SQLite',
    });
    await expect(
      testCommand(projectRoot, [`${unit}/fixtures/schema-v10.sqlite`], { build: true })
    ).rejects.toThrow(/support file, not a test: .*test_HominisStoreSchema\.js/);
    expect(runMachTestSuite).not.toHaveBeenCalled();
    expect(runProtectedMachBuild).not.toHaveBeenCalled();
    expect(stdout.trimEnd().split('\n').at(-1)).toMatch(
      /^FIREFORGE-VERDICT: FAIL reason=preflight note=not-a-test /
    );
  });

  it('refuses a file that is no test input at all, and passes a test or a manifest', async () => {
    await engineWith({
      [`${unit}/notes.txt`]: 'notes',
      [`${unit}/xpcshell.toml`]: '["test_a.js"]\n',
      [`${unit}/test_a.js`]: '',
    });
    await expect(testCommand(projectRoot, [`${unit}/notes.txt`], {})).rejects.toThrow(
      /notes\.txt is not a test/
    );
    for (const path of [`${unit}/test_a.js`, `${unit}/xpcshell.toml`, unit]) {
      vi.mocked(runMachTestSuite).mockClear();
      await testCommand(projectRoot, [path], {}).catch(() => undefined);
      expect(runMachTestSuite).toHaveBeenCalled();
    }
  });
});

describe('preflight refusals reach the captured stream and the run log', () => {
  it('renders a stale-browser refusal on stdout, in the log, and notes it on the verdict', async () => {
    vi.mocked(ensureLaunchableBrowserNotRunning).mockRejectedValueOnce(
      new PreflightRefusalError(STALE_BROWSER_TEXT, 'stale-browser')
    );

    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], {})
    ).rejects.toThrow(PreflightRefusalError);

    expect(stdout).toContain('Preflight refused:');
    expect(stdout).toContain('already running (PID 4242)');
    expect(await readRunLog()).toContain('already running (PID 4242)');
  });

  it('refuses a live peer before any pre-test deploy or build starts', async () => {
    vi.mocked(ensureLaunchableBrowserNotRunning).mockRejectedValueOnce(
      new PreflightRefusalError('Live peer browser; parent fireforge test', 'browser-busy')
    );
    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], { build: true })
    ).rejects.toThrow(/Live peer/);
    expect(prepareBuildEnvironment).not.toHaveBeenCalled();
    expect(runProtectedMachBuild).not.toHaveBeenCalled();
    expect(stdout).toContain('note=browser-busy');
  });

  it('keeps the verdict as the LAST stdout line, with reason unchanged and note added', async () => {
    vi.mocked(ensureLaunchableBrowserNotRunning).mockRejectedValueOnce(
      new PreflightRefusalError(STALE_BROWSER_TEXT, 'stale-browser')
    );

    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], {})
    ).rejects.toThrow();

    const lines = stdout.trimEnd().split('\n');
    const last = lines.at(-1) ?? '';
    expect(last).toMatch(/^FIREFORGE-VERDICT: FAIL reason=preflight note=stale-browser log=/);
    // Refusal text first, verdict last: the ordering the seal exists for.
    expect(stdout.indexOf('Preflight refused:')).toBeLessThan(stdout.indexOf('FIREFORGE-VERDICT:'));
  });

  it('carries the coverage-replaced note for a peer-replaced packaging record', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce({
      stale: false,
      changedPaths: [],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc123',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
        testPackagingCoverage: ['browser/base/content/test/other'],
      },
    });

    await expect(
      testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], {})
    ).rejects.toThrow(PreflightRefusalError);

    expect(stdout).toContain('Preflight refused:');
    expect(stdout).toMatch(/FIREFORGE-VERDICT: FAIL reason=preflight note=coverage-replaced/);
    expect(await readRunLog()).toContain('Preflight refused:');
  });

  it('names the paths to rebuild as build-paths= on the coverage-replaced verdict', async () => {
    const coverage = {
      stale: false,
      changedPaths: [],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc123',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
        testPackagingCoverage: ['browser/base/content/test/other'],
      },
    };
    const requested = [
      'browser/base/content/test/browser_a.js',
      'engine/browser/base/content/test/other/browser_covered.js',
      'browser/components/tests/',
    ];
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(coverage);
    await expect(testCommand(projectRoot, requested, {})).rejects.toThrow(PreflightRefusalError);
    const verdict = stdout.trimEnd().split('\n').at(-1) ?? '';
    expect(verdict).toMatch(/^FIREFORGE-VERDICT: FAIL reason=preflight note=coverage-replaced /);
    expect(verdict).toContain(
      ' build-paths=browser/base/content/test/browser_a.js,browser/components/tests '
    );
  });

  it('still emits a bare reason=preflight for a gate that names no refusal class', async () => {
    // `note=` is additive: a thrower that does not classify itself must not
    // change the line's existing shape.
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({ exists: false });

    await expect(testCommand(projectRoot, [], { doctor: true })).rejects.toThrow();

    expect(stdout).toMatch(/FIREFORGE-VERDICT: FAIL reason=preflight log=/);
    expect(stdout).not.toContain('note=');
  });
});

it('waits out a browser that appeared during the pre-test build with the spent --wait-browser budget', async () => {
  // The pre-lock wait and the in-lock pre-build check see no browser; a
  // peer's starts during the build, and the post-build check waits for it.
  vi.mocked(ensureLaunchableBrowserNotRunning)
    .mockResolvedValueOnce()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new PreflightRefusalError('busy browser', 'browser-busy'));
  await testCommand(projectRoot, ['browser/base/content/test/browser_a.js'], {
    build: true,
    waitBrowser: 30,
  }).catch(() => undefined);
  expect(stdout).not.toContain('note=browser-busy');
  expect(vi.mocked(ensureLaunchableBrowserNotRunning).mock.calls.length).toBeGreaterThanOrEqual(4);
});

it('build-only protects the browser without probing or reaping harness ports', async () => {
  await expect(
    ensureTestBrowserEnvironment(
      '/engine',
      'obj/dist/bin/firefox',
      false,
      await loadConfig(projectRoot),
      { buildOnly: true, reapOrphans: true },
      'obj'
    )
  ).resolves.toEqual({ forwardedPort: undefined, effectivePort: undefined });
  expect(ensureLaunchableBrowserNotRunning).toHaveBeenCalled();
  expect(ensureMochitestServerPortAvailable).not.toHaveBeenCalled();
  expect(assertMarionettePortAvailable).not.toHaveBeenCalled();
  expect(reportOrphanedHarnessProcesses).not.toHaveBeenCalled();
  vi.mocked(ensureLaunchableBrowserNotRunning).mockRejectedValueOnce(
    new PreflightRefusalError('busy browser', 'browser-busy')
  );
  await expect(
    ensureTestBrowserEnvironment(
      '/engine',
      'obj/dist/bin/firefox',
      false,
      await loadConfig(projectRoot),
      { buildOnly: true },
      'obj'
    )
  ).rejects.toThrow('busy browser');
});
