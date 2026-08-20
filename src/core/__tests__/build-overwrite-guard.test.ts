// SPDX-License-Identifier: EUPL-1.2
/**
 * A build-prepare overwrite that destroys unexported engine drift must be
 * LOUD. Silence is what let a later re-export capture a half-reverted
 * hybrid that every gate then passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-status.js', () => ({ getWorkingTreeStatus: vi.fn() }));
vi.mock('../furnace-config.js', () => ({ collectFurnaceManagedPrefixes: vi.fn() }));
vi.mock('../status-classify.js', () => ({ classifyFiles: vi.fn() }));
vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    engine: '/project/engine',
    patches: '/project/patches',
  })),
}));

import type { FireForgeConfig } from '../../types/config.js';
import {
  findUnexportedDriftAtRisk,
  formatUnexportedDriftWarning,
} from '../build-overwrite-guard.js';
import { collectFurnaceManagedPrefixes } from '../furnace-config.js';
import type { GitStatusEntry } from '../git-base.js';
import { getWorkingTreeStatus } from '../git-status.js';
import { classifyFiles } from '../status-classify.js';

const config = { binaryName: 'testbrowser' } as FireForgeConfig;

/**
 * A dirty-worktree entry in the shape both `getWorkingTreeStatus` and
 * `classifyFiles` accept, so one fixture serves the mock on either side.
 */
function statusEntry(file: string): GitStatusEntry {
  return {
    status: ' M',
    indexStatus: ' ',
    worktreeStatus: 'M',
    file,
    isUntracked: false,
    isRenameOrCopy: false,
    isDeleted: false,
  };
}

describe('findUnexportedDriftAtRisk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports drift under a path build-prepare rewrites', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      statusEntry('browser/branding/testbrowser/configure.sh'),
      statusEntry('components/custom/thing.sys.mjs'),
    ]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['components/']));
    vi.mocked(classifyFiles).mockResolvedValue([
      {
        ...statusEntry('browser/branding/testbrowser/configure.sh'),
        classification: 'unmanaged',
      },
      {
        ...statusEntry('components/custom/thing.sys.mjs'),
        classification: 'patch-owned-drift',
        owner: '004-ui-thing.patch',
      },
    ] as Awaited<ReturnType<typeof classifyFiles>>);

    const atRisk = await findUnexportedDriftAtRisk('/project', config);

    expect(atRisk.map((entry) => entry.file)).toEqual([
      'browser/branding/testbrowser/configure.sh',
      'components/custom/thing.sys.mjs',
    ]);
    const message = formatUnexportedDriftWarning(atRisk);
    expect(message).toContain('components/custom/thing.sys.mjs');
    expect(message).toContain('owned by 004-ui-thing.patch');
    expect(message).toContain('--refuse-unexported-drift');
  });

  it('ignores drift outside the paths build-prepare rewrites', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([statusEntry('browser/base/tabs.js')]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['components/']));
    vi.mocked(classifyFiles).mockResolvedValue([]);

    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
    // Nothing to classify means the classifier is never asked.
    expect(classifyFiles).not.toHaveBeenCalled();
  });

  it('does not warn about content the patch body already records', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      statusEntry('components/custom/thing.sys.mjs'),
    ]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['components/']));
    vi.mocked(classifyFiles).mockResolvedValue([
      { ...statusEntry('components/custom/thing.sys.mjs'), classification: 'patch-backed' },
    ] as Awaited<ReturnType<typeof classifyFiles>>);

    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
  });

  it('fails open: a probe failure never blocks a build', async () => {
    vi.mocked(getWorkingTreeStatus).mockRejectedValue(new Error('not a git checkout'));
    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
  });
});
