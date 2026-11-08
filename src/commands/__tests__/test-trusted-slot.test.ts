// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/jobs/guard.js', () => ({ trustedSlotBuild: vi.fn() }));
vi.mock('../../core/build-baseline.js', () => ({ readBuildBaseline: vi.fn() }));
vi.mock('../../core/test-stale-check.js', async (original) => ({
  ...(await original<typeof import('../../core/test-stale-check.js')>()),
  checkStaleBuildForTest: vi.fn(() =>
    Promise.resolve({
      stale: false,
      changedPaths: [],
      truncated: 0,
      baseline: { engineHeadSha: 'base', builtAt: 'now', binaryName: 'browser' },
    })
  ),
  checkStaticComponentsStale: vi.fn(() => Promise.resolve({ stale: false, changedManifests: [] })),
  findCompiledSourcesNewerThanBinary: vi.fn(() => Promise.resolve(undefined)),
  findChangedTestManifestsForPaths: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../core/coverage-dispatch.js', () => ({
  filterByCarriedFullCoverage: vi.fn(() =>
    Promise.resolve([{ path: 'browser/b.js', changed: [] }])
  ),
}));
vi.mock('../../utils/logger.js', () => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../test-verdict.js', () => ({
  setVerdictRunAttribute: vi.fn(),
  formatVerdictPathList: (paths: string[]) => paths.join(','),
}));

import { readBuildBaseline } from '../../core/build-baseline.js';
import { trustedSlotBuild } from '../../core/jobs/guard.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  findChangedTestManifestsForPaths,
  findCompiledSourcesNewerThanBinary,
} from '../../core/test-stale-check.js';
import { enforceStaleBuildGate } from '../test-stale-gate.js';

describe('authenticated frozen-slot stale admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(trustedSlotBuild).mockResolvedValue(undefined);
    vi.mocked(readBuildBaseline).mockResolvedValue({
      engineHeadSha: 'base',
      builtAt: 'now',
      binaryName: 'browser',
      testPackagingCoverage: 'full',
    });
  });

  const trust = (): void => {
    vi.mocked(trustedSlotBuild).mockResolvedValue({
      sourceId: 'source',
      materializationDigest: 'materialized',
      baselineDigest: 'baseline',
      slotGeneration: 2,
      successfulBuildGeneration: 1,
    });
  };

  it('uses authenticated source/build generations without broad stale collectors', async () => {
    trust();
    await enforceStaleBuildGate('/root', '/root/engine', {}, ['browser/a.js']);
    expect(checkStaleBuildForTest).not.toHaveBeenCalled();
    expect(checkStaticComponentsStale).not.toHaveBeenCalled();
    expect(findCompiledSourcesNewerThanBinary).not.toHaveBeenCalled();
  });

  it('retains exact packaging coverage and refuses a missing baseline without scanning', async () => {
    trust();
    vi.mocked(readBuildBaseline).mockResolvedValueOnce({
      engineHeadSha: 'base',
      builtAt: 'now',
      binaryName: 'browser',
      testPackagingCoverage: ['browser/a.js'],
    });
    await expect(
      enforceStaleBuildGate('/root', '/root/engine', {}, ['browser/b.js'])
    ).rejects.toMatchObject({ note: 'coverage-replaced' });
    expect(findChangedTestManifestsForPaths).not.toHaveBeenCalled();
    vi.mocked(readBuildBaseline).mockResolvedValueOnce(undefined);
    await expect(
      enforceStaleBuildGate('/root', '/root/engine', {}, ['browser/a.js'])
    ).rejects.toMatchObject({ note: 'slot-build-missing' });
  });

  it('unknown build identity recollects the legacy gate rather than trusting an environment flag', async () => {
    await enforceStaleBuildGate('/root', '/root/engine', {}, ['browser/a.js']);
    expect(checkStaleBuildForTest).toHaveBeenCalledOnce();
    expect(checkStaticComponentsStale).toHaveBeenCalledOnce();
  });
});
