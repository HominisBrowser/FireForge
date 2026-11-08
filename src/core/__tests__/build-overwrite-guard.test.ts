// SPDX-License-Identifier: EUPL-1.2
/**
 * A build-prepare overwrite that destroys unexported engine drift must be
 * loud. Silence is what lets a later re-export capture a half-reverted
 * hybrid that every gate then passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engine-state.js', () => ({ readEngineInventory: vi.fn() }));
vi.mock('../furnace-config.js', () => ({ collectFurnaceManagedPrefixes: vi.fn() }));
// The composed-source comparison has its own real-fs suite
// (furnace-composed-source.integration.test.ts); here it is a seam.
vi.mock('../furnace-composed-source.js', () => ({
  matchDeployedComponentFiles: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock('../status-classify.js', () => ({ classifyFiles: vi.fn() }));
vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    engine: '/project/engine',
    patches: '/project/patches',
  })),
}));

import type { FireForgeConfig } from '../../types/config.js';
import {
  assessUnexportedDrift,
  findUnexportedDriftAtRisk,
  formatDeployedUnexportedNote,
  formatUnexportedDriftWarning,
} from '../build-overwrite-guard.js';
import { readEngineInventory } from '../engine-state.js';
import { matchDeployedComponentFiles } from '../furnace-composed-source.js';
import { collectFurnaceManagedPrefixes } from '../furnace-config.js';
import type { GitStatusEntry } from '../git-base.js';
import { classifyFiles } from '../status-classify.js';

const config = { binaryName: 'testbrowser' } as FireForgeConfig;

/**
 * A dirty-worktree entry in the shape both the engine inventory and
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

function mockEngineStatus(entries: GitStatusEntry[]): void {
  vi.mocked(readEngineInventory).mockResolvedValue({
    status: '',
    entries,
    paths: entries.map((entry) => entry.file),
  });
}

describe('findUnexportedDriftAtRisk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(matchDeployedComponentFiles).mockResolvedValue(new Map());
  });

  it('reports drift under a path build-prepare rewrites', async () => {
    mockEngineStatus([
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
    mockEngineStatus([statusEntry('browser/base/tabs.js')]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['components/']));
    vi.mocked(classifyFiles).mockResolvedValue([]);

    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
    // Nothing to classify means the classifier is never asked.
    expect(classifyFiles).not.toHaveBeenCalled();
  });

  it('does not warn about content the patch body already records', async () => {
    mockEngineStatus([statusEntry('components/custom/thing.sys.mjs')]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['components/']));
    vi.mocked(classifyFiles).mockResolvedValue([
      { ...statusEntry('components/custom/thing.sys.mjs'), classification: 'patch-backed' },
    ] as Awaited<ReturnType<typeof classifyFiles>>);

    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
  });

  it('fails open: a probe failure never blocks a build', async () => {
    vi.mocked(readEngineInventory).mockRejectedValue(new Error('not a git checkout'));
    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual([]);
  });
});

describe('assessUnexportedDrift — deployed-unexported Furnace files', () => {
  const WIDGET = 'toolkit/content/widgets/moz-x/moz-x.css';
  const EDITED = 'toolkit/content/widgets/moz-x/moz-x.mjs';

  beforeEach(() => {
    vi.clearAllMocks();
    mockEngineStatus([statusEntry(WIDGET), statusEntry(EDITED)]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
      new Set(['toolkit/content/widgets/moz-x/'])
    );
    vi.mocked(classifyFiles).mockResolvedValue([
      { ...statusEntry(WIDGET), classification: 'patch-owned-drift', owner: '010-ui-x.patch' },
      { ...statusEntry(EDITED), classification: 'patch-owned-drift', owner: '010-ui-x.patch' },
    ] as Awaited<ReturnType<typeof classifyFiles>>);
  });

  it('allows the overwrite of a file equal to its composed source and refuses the rest', async () => {
    vi.mocked(matchDeployedComponentFiles).mockResolvedValue(
      new Map([[WIDGET, 'composed-source']])
    );

    const assessment = await assessUnexportedDrift('/project', config);

    expect(matchDeployedComponentFiles).toHaveBeenCalledWith('/project', '/project/engine', [
      WIDGET,
      EDITED,
    ]);
    expect(assessment.atRisk.map((entry) => entry.file)).toEqual([EDITED]);
    expect(assessment.deployedUnexported).toEqual([
      {
        file: WIDGET,
        classification: 'deployed-unexported',
        match: 'composed-source',
        owner: '010-ui-x.patch',
      },
    ]);
    await expect(findUnexportedDriftAtRisk('/project', config)).resolves.toEqual(assessment.atRisk);
    const note = formatDeployedUnexportedNote(assessment.deployedUnexported);
    expect(note).toContain(`${WIDGET} [deployed-unexported: composed-source]`);
    expect(note).toContain('owned by 010-ui-x.patch');
  });

  it('fails closed: when the source comparison cannot run, every file stays at risk', async () => {
    vi.mocked(matchDeployedComponentFiles).mockRejectedValue(new Error('furnace.json unreadable'));

    const assessment = await assessUnexportedDrift('/project', config);

    expect(assessment.atRisk.map((entry) => entry.file)).toEqual([WIDGET, EDITED]);
    expect(assessment.deployedUnexported).toEqual([]);
  });

  it('skips the comparison when no Furnace prefix is managed', async () => {
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set());
    mockEngineStatus([statusEntry('mozconfig')]);
    vi.mocked(classifyFiles).mockResolvedValue([
      { ...statusEntry('mozconfig'), classification: 'unmanaged' },
    ] as Awaited<ReturnType<typeof classifyFiles>>);

    const assessment = await assessUnexportedDrift('/project', config);

    expect(assessment.atRisk.map((entry) => entry.file)).toEqual(['mozconfig']);
    expect(matchDeployedComponentFiles).not.toHaveBeenCalled();
  });
});
