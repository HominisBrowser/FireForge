// SPDX-License-Identifier: EUPL-1.2
/**
 * The restore build after a compiled negative control: a full protected
 * mach build under the build lock whose baseline drops the control stamp,
 * and a failure that leaves the stamp for the next run's refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../core/build-baseline.js', () => ({
  readBuildBaseline: vi.fn(),
  writeBuildBaseline: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({ engine: '/project/engine' })),
  loadConfig: vi.fn(() => Promise.resolve({ binaryName: 'mybrowser' })),
}));
vi.mock('../../core/mach.js', () => ({
  runProtectedMachBuild: vi.fn(() => Promise.resolve({ exitCode: 0, attempts: 1 })),
  withBuildLock: vi.fn((_root: string, body: () => Promise<unknown>) => body()),
}));

import { readBuildBaseline, writeBuildBaseline } from '../../core/build-baseline.js';
import type { BuildBaseline } from '../../core/build-baseline-types.js';
import { runProtectedMachBuild, withBuildLock } from '../../core/mach.js';
import { warn } from '../../utils/logger.js';
import { controlBuildRecorded, runControlRestoreBuild } from '../test-control-restore.js';

const STAMP = {
  diffFile: 'controls/first-key.diff',
  targets: ['gfx/layers/apz/src/APZCTreeManager.cpp'],
  appliedAt: '2026-10-22T10:00:00.000Z',
};
const STAMPED: BuildBaseline = {
  engineHeadSha: 'abc',
  builtAt: '2026-10-22T10:05:00.000Z',
  binaryName: 'mybrowser',
  testPackagingCoverage: ['browser/base/content/test/hominis'],
  controlBuild: STAMP,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readBuildBaseline).mockResolvedValue(STAMPED);
});

describe('controlBuildRecorded', () => {
  it("matches only this run's own stamp", async () => {
    await expect(controlBuildRecorded('/project', STAMP)).resolves.toBe(true);
    await expect(
      controlBuildRecorded('/project', { ...STAMP, appliedAt: '2026-10-22T11:00:00.000Z' })
    ).resolves.toBe(false);
    vi.mocked(readBuildBaseline).mockResolvedValueOnce(undefined);
    await expect(controlBuildRecorded('/project', STAMP)).resolves.toBe(false);
  });
});

describe('runControlRestoreBuild', () => {
  it('runs a full build under the build lock and writes a stamp-less baseline', async () => {
    await expect(runControlRestoreBuild('/project', STAMP, 1)).resolves.toBe('done');
    expect(withBuildLock).toHaveBeenCalledWith('/project', expect.any(Function));
    expect(runProtectedMachBuild).toHaveBeenCalledWith('full', '/project/engine', { retries: 1 });
    const written = vi.mocked(writeBuildBaseline).mock.calls[0]?.[0];
    expect(written).toMatchObject({
      buildKind: 'full',
      testPackagingCoverage: ['browser/base/content/test/hominis'],
    });
    expect(written?.controlBuild).toBeUndefined();
  });

  it('reports a failed build and keeps the stamp', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({ exitCode: 2, attempts: 1 } as never);
    await expect(runControlRestoreBuild('/project', STAMP, undefined)).resolves.toBe('failed');
    expect(writeBuildBaseline).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('note=control-built'));
  });

  it('never throws, even when the build cannot start', async () => {
    vi.mocked(runProtectedMachBuild).mockRejectedValueOnce(new Error('lock lost'));
    await expect(runControlRestoreBuild('/project', STAMP, undefined)).resolves.toBe('failed');
  });
});
