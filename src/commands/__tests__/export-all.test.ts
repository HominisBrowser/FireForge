// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn().mockReturnValue({
    root: '/fake/root',
    engine: '/fake/engine',
    patches: '/fake/patches',
    config: '/fake/root/fireforge.json',
    fireforgeDir: '/fake/root/.fireforge',
    state: '/fake/root/.fireforge/state.json',
    configs: '/fake/root/configs',
    src: '/fake/root/src',
    componentsDir: '/fake/root/src/components',
  }),
  loadConfig: vi.fn().mockResolvedValue({
    binaryName: 'mybrowser',
    firefox: { version: '140.9.0esr' },
  }),
}));

vi.mock('../../core/git.js', () => ({
  isGitRepository: vi.fn().mockResolvedValue(true),
  hasChanges: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../core/git-diff.js', () => ({
  getAllDiff: vi.fn(),
  getDiffForFilesAgainstHead: vi.fn(),
}));

vi.mock('../../core/git-status.js', () => ({
  getWorkingTreeStatus: vi.fn().mockResolvedValue([]),
  expandUntrackedDirectoryEntries: vi.fn((_dir: string, entries: unknown[]) =>
    Promise.resolve(entries)
  ),
}));

vi.mock('../../core/patch-apply.js', () => ({
  extractAffectedFiles: vi.fn().mockReturnValue([]),
}));

vi.mock('../../core/patch-export.js', () => ({
  commitExportedPatch: vi.fn().mockResolvedValue({
    patchFilename: '001-ui-test.patch',
    metadata: {
      filename: '001-ui-test.patch',
      order: 1,
      category: 'ui',
      name: 'all-changes',
      description: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['a.js'],
    },
    superseded: [],
  }),
  findAllPatchesForFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/patch-lint.js', () => ({
  lintExportedPatch: vi.fn().mockResolvedValue([]),
  detectNewFilesInDiff: vi.fn().mockReturnValue(new Set()),
  commentStyleForFile: vi.fn().mockReturnValue(null),
  buildPatchQueueContext: vi.fn().mockResolvedValue({ entries: [] }),
  collectNewFileCreatorsByPath: vi.fn().mockReturnValue(new Map()),
  resolvePatchSizeTier: vi.fn().mockReturnValue({ tier: 'general' }),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/furnace-config.js', () => ({
  collectFurnaceManagedPrefixes: vi.fn(() => Promise.resolve(new Set())),
  // 2026-04-24 eval Finding 1: export-all now consults
  // `furnaceConfigExists` + `loadFurnaceConfig` to refuse patches that
  // would register furnace-managed components without carrying their
  // source files. Default to "no furnace config" so tests that don't
  // opt in stay on the legacy (pre-refusal) happy path.
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    })
  ),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn().mockReturnValue({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  }),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

import * as prompts from '@clack/prompts';

import { collectFurnaceManagedPrefixes } from '../../core/furnace-config.js';
import { hasChanges } from '../../core/git.js';
import { getAllDiff } from '../../core/git-diff.js';
import { getWorkingTreeStatus } from '../../core/git-status.js';
import { extractAffectedFiles } from '../../core/patch-apply.js';
import { commitExportedPatch, findAllPatchesForFiles } from '../../core/patch-export.js';
import {
  buildPatchQueueContext,
  collectNewFileCreatorsByPath,
  detectNewFilesInDiff,
  lintExportedPatch,
} from '../../core/patch-lint.js';
import { setInteractiveMode } from '../../test-utils/index.js';
import { ensureDir } from '../../utils/fs.js';
import { cancel, info, outro, warn } from '../../utils/logger.js';
import { exportAllCommand } from '../export-all.js';

describe('exportAllCommand', () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = undefined;
    vi.clearAllMocks();
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(getAllDiff).mockResolvedValue('diff --git a/a.js b/a.js\n+content a\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.js']);
    vi.mocked(findAllPatchesForFiles).mockResolvedValue([]);
    vi.mocked(lintExportedPatch).mockResolvedValue([]);
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    // `clearAllMocks` resets call history but leaves the last mock
    // implementation in place — tests that set `collectFurnaceManagedPrefixes`
    // to a non-empty set would otherwise bleed into neighbors. Reset to
    // the "no Furnace config" default here so each test starts clean.
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set());
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it('returns early when there are no changes to export', async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);

    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
        category: 'ui',
        description: 'test',
      })
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('No changes to export');
    expect(outro).toHaveBeenCalledWith('Nothing to export');
    expect(getAllDiff).not.toHaveBeenCalled();
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('returns early when git diff is empty despite a dirty tree', async () => {
    vi.mocked(getAllDiff).mockResolvedValue('   \n');

    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
        category: 'ui',
        description: 'test',
      })
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('No diff content to export');
    expect(outro).toHaveBeenCalledWith('Nothing to export');
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('requires --name in non-interactive mode', async () => {
    await expect(
      exportAllCommand('/fake/root', {
        category: 'ui',
      })
    ).rejects.toThrow('The --name flag is required in non-interactive mode');

    expect(ensureDir).not.toHaveBeenCalled();
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('requires --category in non-interactive mode', async () => {
    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
      })
    ).rejects.toThrow('The --category flag is required in non-interactive mode');

    expect(ensureDir).not.toHaveBeenCalled();
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('warns about lint issues before committing', async () => {
    vi.mocked(getAllDiff).mockResolvedValue('diff --git a/x b/x\n+content\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.css']);
    vi.mocked(lintExportedPatch).mockResolvedValue([
      {
        check: 'hardcoded-color',
        file: 'a.css',
        message: 'Use a token instead.',
        severity: 'warning' as const,
      },
    ]);
    vi.mocked(commitExportedPatch).mockResolvedValueOnce({
      patchFilename: '002-ui-all-changes.patch',
      metadata: {
        filename: '002-ui-all-changes.patch',
        order: 2,
        category: 'ui',
        name: 'all-changes',
        description: 'test',
        createdAt: '2026-01-02T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['a.css'],
      },
      superseded: [{ filename: '001-ui-old.patch', order: 1, path: '/fake/patches/001.patch' }],
    });

    await exportAllCommand('/fake/root', {
      name: 'all-changes',
      category: 'ui',
      description: 'test',
      supersede: true,
    });

    expect(warn).toHaveBeenCalledWith('[hardcoded-color] a.css: Use a token instead.');
    expect(info).toHaveBeenCalledWith('Superseded: 001-ui-old.patch');
  });

  it('cancels instead of superseding patches when the interactive confirmation is declined', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(findAllPatchesForFiles).mockResolvedValue([
      {
        path: '/fake/patches/001-ui-existing.patch',
        filename: '001-ui-existing.patch',
        order: 1,
      },
    ]);
    vi.mocked(prompts.confirm).mockResolvedValue(false);

    await expect(
      exportAllCommand('/fake/root', {
        name: 'replacement',
        category: 'ui',
        description: 'test',
      })
    ).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledWith('Export cancelled');
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('passes the full diff through the commit helper', async () => {
    vi.mocked(getAllDiff).mockResolvedValue(
      'diff --git a/a.js b/a.js\n+content a\n\ndiff --git a/c.js b/c.js\n+content c\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.js', 'c.js']);

    await exportAllCommand('/fake/root', {
      name: 'all-changes',
      category: 'ui',
      description: 'test',
    });

    expect(commitExportedPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        patchesDir: '/fake/patches',
        category: 'ui',
        name: 'all-changes',
        description: 'test',
        diff: 'diff --git a/a.js b/a.js\n+content a\n\ndiff --git a/c.js b/c.js\n+content c\n',
        filesAffected: ['a.js', 'c.js'],
        sourceEsrVersion: '140.9.0esr',
        policyCommand: 'export-all',
      })
    );
  });

  it('surfaces commit failures from the patch helper', async () => {
    vi.mocked(getAllDiff).mockResolvedValue('diff --git a/a.js b/a.js\n+content a\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.js']);
    vi.mocked(commitExportedPatch).mockRejectedValueOnce(new Error('manifest failed'));

    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow('manifest failed');
  });

  it('refuses to export tool-managed branding changes via export-all', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'browser/moz.configure',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
      {
        status: '??',
        indexStatus: '?',
        worktreeStatus: '?',
        file: 'browser/branding/mybrowser/default128.png',
        isUntracked: true,
        isRenameOrCopy: false,
        isDeleted: false,
      },
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/modules/AppConstants.sys.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow(/refuses to capture tool-managed branding changes/i);

    expect(getAllDiff).not.toHaveBeenCalled();
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('refuses renamed branding paths based on both source and destination paths', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: 'R ',
        indexStatus: 'R',
        worktreeStatus: ' ',
        file: 'browser/branding/mybrowser/default128-old.png',
        originalPath: 'browser/branding/mybrowser/default128.png',
        isUntracked: false,
        isRenameOrCopy: true,
        isDeleted: false,
      },
    ]);

    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow(/refuses to capture tool-managed branding changes/i);

    expect(getAllDiff).not.toHaveBeenCalled();
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('refuses to supersede exactly 1 patch in non-interactive mode', async () => {
    restoreTTY = setInteractiveMode(false);
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/modules/Example.sys.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);
    vi.mocked(getAllDiff).mockResolvedValue(
      'diff --git a/toolkit/modules/Example.sys.mjs b/toolkit/modules/Example.sys.mjs\n+content\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['toolkit/modules/Example.sys.mjs']);
    vi.mocked(findAllPatchesForFiles).mockResolvedValueOnce([
      {
        path: '/fake/patches/001-ui-existing.patch',
        filename: '001-ui-existing.patch',
        order: 1,
      },
    ]);

    await expect(
      exportAllCommand('/fake/root', {
        name: 'replacement',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow('Refusing to supersede 1 patch');
  });

  it('refuses to export Furnace-managed component changes via export-all', async () => {
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
      new Set(['toolkit/content/widgets/moz-button/'])
    );
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/content/widgets/moz-button/moz-button.css',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/modules/AppConstants.sys.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    await expect(
      exportAllCommand('/fake/root', {
        name: 'all-changes',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow(/refuses to capture Furnace-managed/i);

    expect(getAllDiff).not.toHaveBeenCalled();
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('does not refuse Furnace-managed files when no furnace config exists', async () => {
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set());
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/content/widgets/moz-button/moz-button.css',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    await exportAllCommand('/fake/root', {
      name: 'all-changes',
      category: 'ui',
      description: 'test',
    });

    expect(commitExportedPatch).toHaveBeenCalled();
  });

  it('filters Furnace-managed files out of the diff when --exclude-furnace is set (Finding #13)', async () => {
    // Regression guard: pre-0.16.0 export-all refused outright on any
    // Furnace-managed file, which made it unusable in realistic mixed
    // workspaces. `--exclude-furnace` now keeps the command running on
    // the non-Furnace subset of the diff; the Furnace-managed paths
    // stay untouched in the working tree (they are re-deployed by
    // `furnace apply`), and the info line reports how many paths were
    // excluded so the operator can verify the carve-out.
    const { getDiffForFilesAgainstHead } = await import('../../core/git-diff.js');
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue(
      'diff --git a/toolkit/modules/AppConstants.sys.mjs b/toolkit/modules/AppConstants.sys.mjs\n' +
        '+content\n'
    );

    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
      new Set(['toolkit/content/widgets/moz-button/'])
    );
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/content/widgets/moz-button/moz-button.css',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/modules/AppConstants.sys.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    await exportAllCommand('/fake/root', {
      name: 'no-furnace',
      category: 'ui',
      description: 'test',
      excludeFurnace: true,
    });

    // `commitExportedPatch` must have run (the command did not refuse).
    expect(commitExportedPatch).toHaveBeenCalled();

    // Exclusion is reported to the operator.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Excluded 1 furnace-managed file(s)')
    );

    // The diff passed to the export path was the Furnace-filtered one —
    // we rescope via `getDiffForFilesAgainstHead`, which should have
    // been called with only the non-Furnace path subset.
    const diffCall = vi.mocked(getDiffForFilesAgainstHead).mock.calls.at(-1);
    expect(diffCall?.[1]).toContain('toolkit/modules/AppConstants.sys.mjs');
    expect(diffCall?.[1]).not.toContain('toolkit/content/widgets/moz-button/moz-button.css');
  });

  it('reports "Nothing to export" when --exclude-furnace removes every changed path', async () => {
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
      new Set(['toolkit/content/widgets/moz-button/'])
    );
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/content/widgets/moz-button/moz-button.css',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    await exportAllCommand('/fake/root', {
      name: 'no-furnace',
      category: 'ui',
      description: 'test',
      excludeFurnace: true,
    });

    expect(commitExportedPatch).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith('Nothing to export');
  });

  it('refuses to create a new file that an existing patch already creates', async () => {
    // Simulate a queue where a previous patch owns `browser/modules/labforge/Hello.sys.mjs`
    // as a new-file creation, then have the current aggregate diff try to
    // newly-create the same path — the direct repro of Finding #3.
    vi.mocked(getAllDiff).mockResolvedValue(
      'diff --git a/browser/modules/labforge/Hello.sys.mjs b/browser/modules/labforge/Hello.sys.mjs\nnew file mode 100644\n+contents\n'
    );
    vi.mocked(detectNewFilesInDiff).mockReturnValue(
      new Set(['browser/modules/labforge/Hello.sys.mjs'])
    );
    vi.mocked(buildPatchQueueContext).mockResolvedValue({
      entries: [{ filename: '001-infra-hello.patch', metadata: {} as never, diff: '' } as never],
    });
    vi.mocked(collectNewFileCreatorsByPath).mockReturnValue(
      new Map([['browser/modules/labforge/Hello.sys.mjs', ['001-infra-hello.patch']]])
    );

    await expect(
      exportAllCommand('/fake/root', {
        name: 'bye-module',
        category: 'infra',
        description: 'second creator',
      })
    ).rejects.toThrow(/refuses to capture new-file creations/i);

    expect(commitExportedPatch).not.toHaveBeenCalled();
  });

  it('permits new-file creations that no other patch claims', async () => {
    vi.mocked(getAllDiff).mockResolvedValue(
      'diff --git a/browser/modules/labforge/Fresh.sys.mjs b/browser/modules/labforge/Fresh.sys.mjs\nnew file mode 100644\n+contents\n'
    );
    vi.mocked(detectNewFilesInDiff).mockReturnValue(
      new Set(['browser/modules/labforge/Fresh.sys.mjs'])
    );
    vi.mocked(buildPatchQueueContext).mockResolvedValue({
      entries: [{ filename: '001-infra-other.patch', metadata: {} as never, diff: '' } as never],
    });
    // Queue has creators recorded for an unrelated path — ours is not in the map.
    vi.mocked(collectNewFileCreatorsByPath).mockReturnValue(
      new Map([['browser/modules/labforge/Unrelated.sys.mjs', ['001-infra-other.patch']]])
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/modules/labforge/Fresh.sys.mjs']);

    await exportAllCommand('/fake/root', {
      name: 'fresh-module',
      category: 'infra',
      description: 'clean new creator',
    });

    expect(commitExportedPatch).toHaveBeenCalled();
  });
});
