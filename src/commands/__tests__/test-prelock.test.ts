// SPDX-License-Identifier: EUPL-1.2
/**
 * The lock-free head of `fireforge test`: what refuses or waits before the
 * engine session lock is requested, and what is left for the single
 * re-check under it.
 */
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn((root: string) => ({
    root,
    engine: `${root}/engine`,
    patches: `${root}/patches`,
  })),
  loadConfig: vi.fn(() => Promise.resolve({ binaryName: 'mybrowser' })),
}));
vi.mock('../../core/engine-precondition.js', () => ({
  assertEngineExists: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(),
  hasRunnableBundle: vi.fn(),
}));
vi.mock('../../core/build-run-record.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/build-run-record.js')>()),
  readBuildRunState: vi.fn(),
}));
vi.mock('../../core/marionette-port.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/marionette-port.js')>()),
  ensureLaunchableBrowserNotRunning: vi.fn(() => Promise.resolve()),
  assertMarionettePortAvailable: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/mochitest-server-port.js', () => ({
  ensureMochitestServerPortAvailable: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/preflight-wait.js', () => ({
  waitBeforeLock: vi.fn((action: () => Promise<void>) => action()),
}));
vi.mock('../test-checkjs.js', () => ({
  checkRequestedTestTypes: vi.fn(() => Promise.resolve()),
}));
vi.mock('../test-stale-gate.js', () => ({
  enforceStaleBuildGate: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/negative-control.js', () => ({
  planNegativeControl: vi.fn(() => Promise.resolve({ diffFile: 'c.diff', targets: [] })),
}));
vi.mock('../test-modes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../test-modes.js')>()),
  classifyBeforeDispatch: vi.fn(() =>
    Promise.resolve({ classification: { xpcshell: [], nonXpcshell: [] }, xpcshellOnly: false })
  ),
}));

import { readBuildRunState } from '../../core/build-run-record.js';
import { loadConfig } from '../../core/config.js';
import { hasBuildArtifacts, hasRunnableBundle } from '../../core/mach.js';
import {
  assertMarionettePortAvailable,
  ensureLaunchableBrowserNotRunning,
} from '../../core/marionette-port.js';
import { ensureMochitestServerPortAvailable } from '../../core/mochitest-server-port.js';
import { planNegativeControl } from '../../core/negative-control.js';
import { waitBeforeLock } from '../../core/preflight-wait.js';
import { PreflightRefusalError } from '../../errors/base.js';
import { info } from '../../utils/logger.js';
import { checkRequestedTestTypes } from '../test-checkjs.js';
import { classifyBeforeDispatch } from '../test-modes.js';
import { resolveLaunchablePathForTests, runTestPreLockPreflight } from '../test-prelock.js';
import { enforceStaleBuildGate } from '../test-stale-gate.js';

const ROOT = '/project';
const APP = 'obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser';
const FILE = 'browser/base/content/test/foo/browser_a.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
  vi.mocked(hasRunnableBundle).mockResolvedValue({ runnable: true, expectedPath: APP });
  vi.mocked(readBuildRunState).mockResolvedValue({ kind: 'none' });
});

describe('resolveLaunchablePathForTests', () => {
  it('names an interrupted peer build as the cause of a missing binary', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({ runnable: false, expectedPath: APP });
    vi.mocked(readBuildRunState).mockResolvedValue({
      kind: 'interrupted',
      record: {
        status: 'running',
        pid: 4242,
        command: 'fireforge build',
        machCommand: 'mach build',
        startedAt: '2026-10-03T21:10:00.000Z',
      },
    });
    const refusal = resolveLaunchablePathForTests(ROOT, `${ROOT}/engine`, 'mybrowser', 'obj-debug');
    await expect(refusal).rejects.toBeInstanceOf(PreflightRefusalError);
    await expect(refusal).rejects.toMatchObject({ note: 'no-launchable-binary' });
    await expect(refusal).rejects.toThrow(
      /expected at engine\/obj-debug.*\n\nThe last build never finished: "fireforge build" \(mach build, PID 4242/s
    );
  });

  it('keeps the generic hint when no build left a record, and skips a tree without an objdir', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({ runnable: false });
    await expect(
      resolveLaunchablePathForTests(ROOT, `${ROOT}/engine`, 'mybrowser', 'obj-debug')
    ).rejects.toThrow(/typically the result of an interrupted or partially failed/);
    await expect(
      resolveLaunchablePathForTests(ROOT, `${ROOT}/engine`, 'mybrowser', undefined)
    ).resolves.toBeUndefined();
  });
});

describe('runTestPreLockPreflight', () => {
  it('refuses a missing binary before the lock is requested', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({ runnable: false, expectedPath: APP });
    await expect(runTestPreLockPreflight(ROOT, [FILE], {})).rejects.toMatchObject({
      note: 'no-launchable-binary',
    });
  });

  it('queues behind a running build instead of refusing its half-linked bundle', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({ runnable: false, expectedPath: APP });
    vi.mocked(readBuildRunState).mockResolvedValue({
      kind: 'running',
      record: {
        status: 'running',
        pid: process.pid,
        command: 'fireforge build',
        machCommand: 'mach build',
        startedAt: '2026-10-03T21:10:00.000Z',
      },
    });
    await expect(runTestPreLockPreflight(ROOT, [FILE], { waitBrowser: 30 })).resolves.toMatchObject(
      { waitBrowser: 30 }
    );
    // No binary to watch, so the browser budget stays for the in-lock check.
    expect(ensureLaunchableBrowserNotRunning).not.toHaveBeenCalled();
  });

  it('runs the named-file checkJs pass for a build run, with engine-relative paths', async () => {
    await runTestPreLockPreflight(ROOT, [`engine/${FILE}`], { build: true });
    expect(checkRequestedTestTypes).toHaveBeenCalledWith(
      expect.objectContaining({ engine: `${ROOT}/engine` }),
      expect.objectContaining({ binaryName: 'mybrowser' }),
      [FILE]
    );
  });

  it('propagates a checkJs refusal and skips the pass without a build', async () => {
    vi.mocked(checkRequestedTestTypes).mockRejectedValueOnce(new Error('type errors'));
    await expect(runTestPreLockPreflight(ROOT, [FILE], { buildOnly: true })).rejects.toThrow(
      'type errors'
    );
    await runTestPreLockPreflight(ROOT, [FILE], {});
    expect(checkRequestedTestTypes).toHaveBeenCalledTimes(1);
  });

  it('refuses the pathless shape before touching the objdir', async () => {
    await expect(runTestPreLockPreflight(ROOT, [], {})).rejects.toThrow(
      /requires an explicit test path/
    );
    expect(hasBuildArtifacts).not.toHaveBeenCalled();
  });

  it('leaves a tree with no objdir to the in-lock ladder', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true });
    const options = { waitBrowser: 30 };
    await expect(runTestPreLockPreflight(ROOT, [FILE], options)).resolves.toBe(options);
    expect(hasRunnableBundle).not.toHaveBeenCalled();
  });

  it('spends both wait budgets before the lock and strips them for the single in-lock re-check', async () => {
    const result = await runTestPreLockPreflight(ROOT, [FILE], {
      waitBrowser: 120,
      waitPort: true,
      marionettePort: 2838,
      headless: true,
    });
    expect(result).toEqual({ headless: true, marionettePort: 2838 });
    expect(waitBeforeLock).toHaveBeenNthCalledWith(1, expect.any(Function), 120, []);
    expect(waitBeforeLock).toHaveBeenNthCalledWith(2, expect.any(Function), 60);
    expect(waitBeforeLock).toHaveBeenNthCalledWith(3, expect.any(Function), 60);
    expect(ensureLaunchableBrowserNotRunning).toHaveBeenCalledWith(join(`${ROOT}/engine`, APP));
    expect(ensureMochitestServerPortAvailable).toHaveBeenCalledWith(undefined, {
      engineDir: `${ROOT}/engine`,
    });
    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(2838, { binaryName: 'mybrowser' });
  });

  it('lets a reapable stale browser count as clear, and leaves port waits under the lock with --kill-stale-marionette', async () => {
    const result = await runTestPreLockPreflight(ROOT, [FILE], {
      waitBrowser: 10,
      waitPort: 10,
      killStaleMarionette: true,
    });
    expect(waitBeforeLock).toHaveBeenCalledTimes(1);
    expect(waitBeforeLock).toHaveBeenCalledWith(expect.any(Function), 10, ['stale-browser']);
    expect(result).toEqual({ waitPort: 10, killStaleMarionette: true });
  });

  it('skips the browser and mochitest waits for an xpcshell-only run, keeping the --doctor port probe', async () => {
    vi.mocked(classifyBeforeDispatch).mockResolvedValueOnce({
      classification: { xpcshell: ['a/test_x.js'], nonXpcshell: [] },
      xpcshellOnly: true,
    });
    const result = await runTestPreLockPreflight(ROOT, ['a/test_x.js'], {
      waitBrowser: 10,
      waitPort: 10,
      doctor: true,
    });
    expect(ensureLaunchableBrowserNotRunning).not.toHaveBeenCalled();
    expect(ensureMochitestServerPortAvailable).not.toHaveBeenCalled();
    expect(assertMarionettePortAvailable).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ waitBrowser: 10, doctor: true });
  });

  it('leaves both waits to the lock when the request cannot be classified', async () => {
    vi.mocked(classifyBeforeDispatch).mockRejectedValueOnce(new Error('manifest unreadable'));
    const options = { waitBrowser: 10, waitPort: 10 };
    await expect(runTestPreLockPreflight(ROOT, [FILE], options)).resolves.toBe(options);
    expect(waitBeforeLock).not.toHaveBeenCalled();
  });
});

describe('packaging and control refusals before the lock', () => {
  it('runs the stale gate quietly for a build-less run, and never for a build', async () => {
    await runTestPreLockPreflight(ROOT, [FILE], {});
    expect(enforceStaleBuildGate).toHaveBeenCalledWith(ROOT, `${ROOT}/engine`, {}, [FILE], {
      quiet: true,
    });
    vi.mocked(enforceStaleBuildGate).mockClear();
    await runTestPreLockPreflight(ROOT, [FILE], { build: true });
    await runTestPreLockPreflight(ROOT, [FILE], { allowStaleBuild: true });
    vi.mocked(readBuildRunState).mockResolvedValueOnce({ kind: 'running' } as never);
    await runTestPreLockPreflight(ROOT, [FILE], {});
    expect(enforceStaleBuildGate).not.toHaveBeenCalled();
  });

  it('tells a build-less --negative-control to add --build', async () => {
    vi.mocked(enforceStaleBuildGate).mockRejectedValueOnce(
      new PreflightRefusalError('Stale build.', 'stale-build')
    );
    await expect(
      runTestPreLockPreflight(ROOT, [FILE], { negativeControl: 'c.diff' })
    ).rejects.toMatchObject({
      note: 'stale-build',
      message: expect.stringContaining('Add --build') as string,
    });
    const plain = new PreflightRefusalError('Stale build.', 'stale-build');
    vi.mocked(enforceStaleBuildGate).mockRejectedValueOnce(plain);
    await expect(runTestPreLockPreflight(ROOT, [FILE], {})).rejects.toBe(plain);
  });

  it('refuses a build-less control on compiled source, and leaves other plan errors to the lock', async () => {
    vi.mocked(planNegativeControl).mockResolvedValueOnce({
      diffFile: 'c.diff',
      targets: [],
      compiled: ['gfx/x.cpp'],
    });
    await expect(
      runTestPreLockPreflight(ROOT, [FILE], { negativeControl: 'c.diff' })
    ).rejects.toThrow(/edits compiled source \(engine\/gfx\/x\.cpp\)/);
    vi.mocked(planNegativeControl).mockRejectedValueOnce(new Error('pending journal'));
    await expect(
      runTestPreLockPreflight(ROOT, [FILE], { negativeControl: 'c.diff' })
    ).resolves.toEqual({ negativeControl: 'c.diff' });
  });
});

describe('lock mode', () => {
  it('holds the lock shared only for a build-less auto-ports run that asked for it', async () => {
    await expect(
      runTestPreLockPreflight(ROOT, [FILE], { sharedLock: true, autoPorts: true })
    ).resolves.toEqual({ sharedLock: true, autoPorts: true });
    await expect(
      runTestPreLockPreflight(ROOT, [FILE], { sharedLock: true, autoPorts: true, build: true })
    ).resolves.toEqual({ autoPorts: true, build: true });
    await expect(runTestPreLockPreflight(ROOT, [FILE], { sharedLock: true })).resolves.toEqual({});
    expect(info).toHaveBeenCalledWith(expect.stringContaining('does not use auto ports'));
    vi.mocked(loadConfig).mockResolvedValueOnce({
      binaryName: 'mybrowser',
      test: { lockMode: 'shared', mochitestPorts: 'auto' },
    } as never);
    await expect(runTestPreLockPreflight(ROOT, [FILE], {})).resolves.toEqual({ sharedLock: true });
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({ exists: true });
    await expect(runTestPreLockPreflight(ROOT, [FILE], { sharedLock: true })).resolves.toEqual({});
  });
});
