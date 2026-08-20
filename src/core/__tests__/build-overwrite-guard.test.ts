// SPDX-License-Identifier: EUPL-1.2
/**
 * A build-prepare overwrite that destroys unexported engine drift must be
 * LOUD. Silence is what let a later re-export capture a half-reverted
 * hybrid that every gate then passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-status.js', () => ({
  getWorkingTreeStatus: vi.fn(),
  // The guard expands collapsed `?? dir/` entries before classifying;
  // the default double is a pass-through so per-file fixtures are
  // unaffected, and the collapsing itself is covered for real in
  // build-overwrite-guard-untracked-dir.integration.test.ts.
  expandUntrackedDirectoryEntries: vi.fn((_repoDir: string, entries: GitStatusEntry[]) =>
    Promise.resolve(entries)
  ),
}));
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
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../git-status.js';
import { classifyFiles } from '../status-classify.js';

const config = { binaryName: 'testbrowser' } as FireForgeConfig;

/**
 * A dirty-worktree entry in the shape both `getWorkingTreeStatus` and
 * `classifyFiles` accept, so one fixture serves the mock on either side.
 */
function untrackedDirEntry(file: string): GitStatusEntry {
  return {
    status: '??',
    indexStatus: '?',
    worktreeStatus: '?',
    file,
    isUntracked: true,
    isRenameOrCopy: false,
    isDeleted: false,
  };
}

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
    vi.mocked(expandUntrackedDirectoryEntries).mockImplementation((_repoDir, entries) =>
      Promise.resolve(entries)
    );
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

  it('classifies the files inside a collapsed untracked directory, never the directory', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      untrackedDirEntry('browser/branding/testbrowser/content/'),
    ]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set());
    vi.mocked(expandUntrackedDirectoryEntries).mockResolvedValue([
      untrackedDirEntry('browser/branding/testbrowser/content/logo.svg'),
    ]);
    vi.mocked(classifyFiles).mockResolvedValue([
      {
        ...untrackedDirEntry('browser/branding/testbrowser/content/logo.svg'),
        classification: 'branding',
      },
    ] as Awaited<ReturnType<typeof classifyFiles>>);

    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
    expect(vi.mocked(classifyFiles).mock.calls[0]?.[0].map((entry) => entry.file)).toEqual([
      'browser/branding/testbrowser/content/logo.svg',
    ]);
  });

  it('scopes a collapsed ancestor directory to the owned prefixes beneath it', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([untrackedDirEntry('browser/branding/')]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['components/']));
    vi.mocked(expandUntrackedDirectoryEntries).mockResolvedValue([]);
    vi.mocked(classifyFiles).mockResolvedValue([]);

    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
    // Only the owned branding prefix is walked — not the whole
    // `browser/branding/` tree, and not the unrelated furnace prefix.
    expect(
      vi.mocked(expandUntrackedDirectoryEntries).mock.calls[0]?.[1].map((entry) => entry.file)
    ).toEqual(['browser/branding/testbrowser/']);
  });

  it('fails open: a probe failure never blocks a build', async () => {
    vi.mocked(getWorkingTreeStatus).mockRejectedValue(new Error('not a git checkout'));
    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
  });
});
