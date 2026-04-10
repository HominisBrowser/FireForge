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
    name: 'TestBrowser',
    vendor: 'Test',
    appId: 'org.test.browser',
    binaryName: 'testbrowser',
    firefox: { version: '140.0esr', product: 'firefox-esr' },
    license: 'MPL-2.0',
  }),
}));

vi.mock('../../core/git.js', () => ({
  isGitRepository: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../core/git-diff.js', () => ({
  getDiffForFilesAgainstHead: vi.fn().mockResolvedValue('diff --git a/x b/x\n+content\n'),
}));

vi.mock('../../core/git-status.js', () => ({
  getModifiedFilesInDir: vi.fn().mockResolvedValue([]),
  getUntrackedFilesInDir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/patch-export.js', () => ({
  updatePatchMetadata: vi.fn().mockResolvedValue(undefined),
  updatePatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(),
  getClaimedFiles: vi.fn().mockReturnValue(new Set<string>()),
}));

vi.mock('../../core/patch-lint.js', () => ({
  lintExportedPatch: vi.fn().mockResolvedValue([]),
  detectNewFilesInDiff: vi.fn().mockReturnValue(new Set()),
  commentStyleForFile: vi.fn().mockReturnValue(null),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  spinner: vi.fn().mockReturnValue({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  }),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

import { multiselect } from '@clack/prompts';

import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../../core/git-status.js';
import { updatePatch, updatePatchMetadata } from '../../core/patch-export.js';
import { lintExportedPatch } from '../../core/patch-lint.js';
import { getClaimedFiles, loadPatchesManifest } from '../../core/patch-manifest.js';
import { setInteractiveMode } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { cancel, info, isCancel, outro, spinner, success, warn } from '../../utils/logger.js';
import { reExportCommand } from '../re-export.js';

function makePatch(filename: string, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order: parseInt(filename.split('-')[0] ?? '0', 10),
    category: 'ui' as const,
    name: 'test',
    description: '',
    createdAt: new Date().toISOString(),
    sourceEsrVersion: '140.0esr',
    filesAffected,
  };
}

function makeManifest(patches: PatchMetadata[]): PatchesManifest {
  return { version: 1, patches };
}

describe('reExportCommand - --scan flag', () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = undefined;
    vi.clearAllMocks();
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(updatePatch).mockResolvedValue(undefined);
    vi.mocked(updatePatchMetadata).mockResolvedValue(undefined);
    vi.mocked(lintExportedPatch).mockResolvedValue([]);
    vi.mocked(isCancel).mockReturnValue(false);
    vi.mocked(multiselect).mockResolvedValue([]);
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it('requires explicit patch identifiers or --all in non-interactive mode', async () => {
    restoreTTY = setInteractiveMode(false);
    vi.mocked(loadPatchesManifest).mockResolvedValue(
      makeManifest([makePatch('001-ui-test.patch', ['a.js'])])
    );

    await expect(reExportCommand('/fake/root', [], {})).rejects.toThrow(
      'Specify patch identifiers or use --all in non-interactive mode.'
    );
  });

  it('returns cleanly when interactive patch selection is cancelled', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue(
      makeManifest([makePatch('001-ui-test.patch', ['a.js'])])
    );
    vi.mocked(isCancel).mockReturnValue(true);

    await expect(reExportCommand('/fake/root', [], {})).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledWith('Re-export cancelled');
    expect(spinner).not.toHaveBeenCalled();
  });

  it('exits without work when interactive selection returns no patches', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue(
      makeManifest([makePatch('001-ui-test.patch', ['a.js'])])
    );
    vi.mocked(multiselect).mockResolvedValue([]);

    await expect(reExportCommand('/fake/root', [], {})).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('No patches selected');
    expect(outro).toHaveBeenCalledWith('Nothing to re-export');
    expect(spinner).not.toHaveBeenCalled();
  });

  it('rejects unknown patch identifiers with the available manifest entries', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue(
      makeManifest([
        makePatch('001-ui-test.patch', ['a.js']),
        makePatch('002-ui-other.patch', ['b.js']),
      ])
    );

    await expect(reExportCommand('/fake/root', ['999'], {})).rejects.toThrow(
      'Patch "999" not found in manifest.'
    );
  });

  it('reports partial success when one selected patch is skipped and another is re-exported', async () => {
    const existingPatch = makePatch('001-ui-keep.patch', ['a.js']);
    const missingPatch = makePatch('002-ui-missing.patch', ['missing.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([existingPatch, missingPatch]));
    vi.mocked(pathExists).mockImplementation((targetPath: string) => {
      if (targetPath === '/fake/engine') return Promise.resolve(true);
      if (targetPath.endsWith('/a.js')) return Promise.resolve(true);
      if (targetPath.endsWith('/missing.js')) return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await expect(reExportCommand('/fake/root', ['001', '002'], {})).resolves.toBeUndefined();

    expect(updatePatch).toHaveBeenCalledTimes(1);
    expect(updatePatchMetadata).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Skipped 002-ui-missing.patch: all affected files missing');
    expect(success).toHaveBeenCalledWith('Re-exported 1 of 2 patch(es)');
    expect(outro).toHaveBeenCalledWith('Re-export complete');
  });

  it('should discover new files in scanned directories', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/modules/foo/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/modules/foo/b.js']);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true });

    expect(info).toHaveBeenCalledWith('  + browser/modules/foo/b.js');
    expect(updatePatchMetadata).toHaveBeenCalledWith(
      '/fake/patches',
      '001-ui-test.patch',
      expect.objectContaining({
        filesAffected: expect.arrayContaining([
          'browser/modules/foo/a.js',
          'browser/modules/foo/b.js',
        ]) as string[],
      })
    );
  });

  it('does not update the manifest ahead of a failed patch rewrite during scan', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/modules/foo/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/modules/foo/b.js']);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(updatePatch).mockRejectedValueOnce(new Error('write failed'));

    await expect(reExportCommand('/fake/root', ['001'], { scan: true })).rejects.toThrow(
      'All selected patches failed to re-export'
    );

    expect(updatePatchMetadata).not.toHaveBeenCalled();
  });

  it('should remove files that no longer exist', async () => {
    const patch = makePatch('001-ui-test.patch', [
      'browser/modules/foo/a.js',
      'browser/modules/foo/deleted.js',
    ]);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/modules/foo/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());

    // pathExists calls: engine dir, a.js (scan), deleted.js (scan), a.js (missing check)
    vi.mocked(pathExists)
      .mockResolvedValueOnce(true) // engine dir exists
      .mockResolvedValueOnce(true) // a.js exists (scan removal check)
      .mockResolvedValueOnce(false) // deleted.js does not exist (scan removal check)
      .mockResolvedValueOnce(true); // a.js exists (missing file check)

    await reExportCommand('/fake/root', ['001'], { scan: true });

    expect(info).toHaveBeenCalledWith('  - browser/modules/foo/deleted.js');
  });

  it('should not steal files claimed by another patch', async () => {
    const patch1 = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    const patch2 = makePatch('002-ui-other.patch', ['browser/modules/foo/claimed.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/modules/foo/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([
      'browser/modules/foo/claimed.js',
      'browser/modules/foo/new.js',
    ]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set(['browser/modules/foo/claimed.js']));
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true });

    // Should add new.js but NOT claimed.js
    expect(info).toHaveBeenCalledWith('  + browser/modules/foo/new.js');

    const metadataCalls = vi.mocked(updatePatchMetadata).mock.calls;
    // Find the scan update call (has filesAffected)
    const scanCall = metadataCalls.find(
      (call) => 'filesAffected' in (call[2] as Record<string, unknown>)
    );
    expect(scanCall).toBeDefined();
    const updatedFiles = (scanCall?.[2] as { filesAffected: string[] }).filesAffected;
    expect(updatedFiles).toContain('browser/modules/foo/new.js');
    expect(updatedFiles).not.toContain('browser/modules/foo/claimed.js');
  });

  it('should not scan when --scan is not passed', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], {});

    expect(getModifiedFilesInDir).not.toHaveBeenCalled();
    expect(getUntrackedFilesInDir).not.toHaveBeenCalled();
    expect(getClaimedFiles).not.toHaveBeenCalled();
  });

  it('should work with --all and --scan combined', async () => {
    const patch1 = makePatch('001-ui-test.patch', ['dir1/a.js']);
    const patch2 = makePatch('002-ui-other.patch', ['dir2/b.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));
    vi.mocked(getModifiedFilesInDir)
      .mockResolvedValueOnce(['dir1/a.js'])
      .mockResolvedValueOnce(['dir2/b.js']);
    vi.mocked(getUntrackedFilesInDir)
      .mockResolvedValueOnce(['dir1/new.js'])
      .mockResolvedValueOnce([]);
    vi.mocked(getClaimedFiles)
      .mockReturnValueOnce(new Set(['dir2/b.js'])) // for patch1: patch2 claims dir2/b.js
      .mockReturnValueOnce(new Set(['dir1/a.js', 'dir1/new.js'])); // for patch2: patch1 claims these
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', [], { all: true, scan: true });

    expect(getModifiedFilesInDir).toHaveBeenCalledTimes(2);
    expect(getUntrackedFilesInDir).toHaveBeenCalledTimes(2);
  });

  it('does not write patch content or metadata during dry-run', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { dryRun: true });

    expect(updatePatch).not.toHaveBeenCalled();
    expect(updatePatchMetadata).not.toHaveBeenCalled();
  });

  it('fails and does not write artifacts when lint finds errors', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      {
        check: 'relative-import',
        file: 'browser/modules/foo/a.js',
        message: 'bad import',
        severity: 'error',
      },
    ]);

    await expect(reExportCommand('/fake/root', ['001'], {})).rejects.toThrow(
      'All selected patches failed to re-export'
    );

    expect(updatePatch).not.toHaveBeenCalled();
    expect(updatePatchMetadata).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'ERROR [relative-import] browser/modules/foo/a.js: bad import'
    );
  });

  it('does not persist scan-discovered metadata when lint blocks re-export', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/modules/foo/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/modules/foo/new.js']);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      {
        check: 'missing-license-header',
        file: 'browser/modules/foo/new.js',
        message: 'missing license',
        severity: 'error',
      },
    ]);

    await expect(reExportCommand('/fake/root', ['001'], { scan: true })).rejects.toThrow(
      'All selected patches failed to re-export'
    );

    expect(info).toHaveBeenCalledWith('  + browser/modules/foo/new.js');
    expect(updatePatch).not.toHaveBeenCalled();
    expect(updatePatchMetadata).not.toHaveBeenCalled();
  });

  it('blocks only the lint-failing patch when re-exporting all patches', async () => {
    const firstPatch = makePatch('001-ui-first.patch', ['dir/a.js']);
    const secondPatch = makePatch('002-ui-second.patch', ['dir/b.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([firstPatch, secondPatch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(lintExportedPatch)
      .mockResolvedValueOnce([
        {
          check: 'relative-import',
          file: 'dir/a.js',
          message: 'bad import',
          severity: 'error',
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(reExportCommand('/fake/root', [], { all: true })).resolves.toBeUndefined();

    expect(updatePatch).toHaveBeenCalledTimes(1);
    expect(updatePatch).toHaveBeenCalledWith(
      '/fake/patches/002-ui-second.patch',
      expect.any(String)
    );
    expect(updatePatchMetadata).toHaveBeenCalledTimes(1);
    expect(updatePatchMetadata).toHaveBeenCalledWith(
      '/fake/patches',
      '002-ui-second.patch',
      expect.any(Object)
    );
    expect(success).toHaveBeenCalledWith('Re-exported 1 of 2 patch(es)');
  });

  it('writes artifacts and downgrades lint errors with --skip-lint', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      {
        check: 'relative-import',
        file: 'browser/modules/foo/a.js',
        message: 'bad import',
        severity: 'error',
      },
    ]);

    await expect(
      reExportCommand('/fake/root', ['001'], { skipLint: true })
    ).resolves.toBeUndefined();

    expect(updatePatch).toHaveBeenCalledTimes(1);
    expect(updatePatchMetadata).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[relative-import] browser/modules/foo/a.js: bad import');
    expect(info).toHaveBeenCalledWith('Lint: 1 error(s) downgraded to warnings (--skip-lint)');
    const lintOrder = vi.mocked(lintExportedPatch).mock.invocationCallOrder[0] ?? 0;
    const updateOrder =
      vi.mocked(updatePatch).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(lintOrder).toBeLessThan(updateOrder);
  });

  it('writes artifacts when lint returns warnings only', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      {
        check: 'missing-modification-comment',
        file: 'browser/modules/foo/a.js',
        message: 'missing marker',
        severity: 'warning',
      },
    ]);

    await expect(reExportCommand('/fake/root', ['001'], {})).resolves.toBeUndefined();

    expect(updatePatch).toHaveBeenCalledTimes(1);
    expect(updatePatchMetadata).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[missing-modification-comment] browser/modules/foo/a.js: missing marker'
    );
  });

  it('runs lint during dry-run without writing artifacts', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      {
        check: 'missing-modification-comment',
        file: 'browser/modules/foo/a.js',
        message: 'missing marker',
        severity: 'warning',
      },
    ]);

    await expect(reExportCommand('/fake/root', ['001'], { dryRun: true })).resolves.toBeUndefined();

    expect(lintExportedPatch).toHaveBeenCalledTimes(1);
    expect(updatePatch).not.toHaveBeenCalled();
    expect(updatePatchMetadata).not.toHaveBeenCalled();
  });

  it('reuses a single spinner across multiple patches', async () => {
    const patch1 = makePatch('001-ui-first.patch', ['dir/a.js']);
    const patch2 = makePatch('002-ui-second.patch', ['dir/b.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', [], { all: true, dryRun: true });

    expect(spinner).toHaveBeenCalledTimes(1);
    const handle = vi.mocked(spinner).mock.results[0]?.value as
      | { message: ReturnType<typeof vi.fn> }
      | undefined;
    expect(handle?.message).toHaveBeenCalledWith('Re-exporting 001-ui-first.patch...');
    expect(handle?.message).toHaveBeenCalledWith('Re-exporting 002-ui-second.patch...');
  });
});
