// SPDX-License-Identifier: EUPL-1.2
/**
 * A `fireforge test` preflight refusal has to reach BOTH channels an
 * unattended operator actually keeps: the captured stdout stream and the
 * run log the verdict line names.
 *
 * It reached neither. `emitFailVerdict` seals stdout (so the verdict stays
 * the last line), which routes `withErrorHandling`'s rendering to stderr;
 * and that rendering happens after `testCommand`'s `finally` has already
 * closed the run log. A redirected run therefore kept
 * `FIREFORGE-VERDICT: FAIL reason=preflight` and nothing else, while the
 * log it pointed at held only the pre-test build.
 *
 * The run log is REAL here (not the shared mock the sibling suites use) —
 * the bug was in what reached the file, so a mocked sink could not see it.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

import { hasBuildArtifacts, runProtectedMachBuild } from '../../core/mach.js';
import { ensureLaunchableBrowserNotRunning } from '../../core/marionette-port.js';
import { checkStaleBuildForTest } from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { PreflightRefusalError } from '../../errors/base.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { testCommand } from '../test.js';

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
    // Refusal text first, verdict last — the ordering the seal exists for.
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

  it('still emits a bare reason=preflight for a gate that names no refusal class', async () => {
    // `note=` is additive: a thrower that does not classify itself must not
    // change the line's existing shape.
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({ exists: false });

    await expect(testCommand(projectRoot, [], { doctor: true })).rejects.toThrow();

    expect(stdout).toMatch(/FIREFORGE-VERDICT: FAIL reason=preflight log=/);
    expect(stdout).not.toContain('note=');
  });
});
