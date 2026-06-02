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
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
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
  updatePatchAndMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/patch-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/patch-manifest.js')>();
  return {
    ...actual,
    loadPatchesManifest: vi.fn(),
    getClaimedFiles: vi.fn().mockReturnValue(new Set<string>()),
    stampPatchVersions: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../core/patch-lint.js', () => ({
  lintExportedPatch: vi.fn().mockResolvedValue([]),
  detectNewFilesInDiff: vi.fn().mockReturnValue(new Set()),
  commentStyleForFile: vi.fn().mockReturnValue(null),
  resolvePatchSizeTier: vi.fn().mockReturnValue({ tier: 'general' }),
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
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

import { confirm, multiselect } from '@clack/prompts';

import { getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../../core/git-status.js';
import { updatePatchAndMetadata } from '../../core/patch-export.js';
import { lintExportedPatch } from '../../core/patch-lint.js';
import {
  getClaimedFiles,
  loadPatchesManifest,
  stampPatchVersions,
} from '../../core/patch-manifest.js';
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
    sourceEsrVersion: '140.9.0esr',
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
    vi.mocked(updatePatchAndMetadata).mockResolvedValue(undefined);
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

    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Skipped 002-ui-missing.patch: all affected files missing');
    expect(success).toHaveBeenCalledWith('Re-exported 1 of 2 patch(es)');
    expect(outro).toHaveBeenCalledWith('Re-export complete');
  });

  it('plain re-export suggests --scan-file for unowned changed sibling files', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/branding/hominis/configure.sh']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/branding/hominis/Assets.car']);

    await reExportCommand('/fake/root', ['001'], {});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('found 1 unowned changed sibling file')
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'browser/branding/hominis/Assets.car — fireforge re-export 001-ui-test.patch --scan --scan-file browser/branding/hominis/Assets.car'
      )
    );
    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
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
    expect(updatePatchAndMetadata).toHaveBeenCalledWith(
      '/fake/patches',
      '001-ui-test.patch',
      expect.any(String),
      expect.objectContaining({
        filesAffected: expect.arrayContaining([
          'browser/modules/foo/a.js',
          'browser/modules/foo/b.js',
        ]) as string[],
      }),
      undefined,
      expect.objectContaining({ command: 're-export' })
    );
  });

  it('--scan-file adds only explicit files and ignores adjacent scanned siblings', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([
      'browser/modules/foo/a.js',
      'browser/modules/foo/sibling.js',
    ]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/modules/foo/unmanaged.js']);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValueOnce(
      [
        'diff --git a/browser/modules/foo/intended.js b/browser/modules/foo/intended.js',
        '--- /dev/null',
        '+++ b/browser/modules/foo/intended.js',
        '@@ -0,0 +1 @@',
        '+content',
        '',
      ].join('\n')
    );

    await reExportCommand('/fake/root', ['001'], {
      scan: true,
      scanFiles: ['engine/browser/modules/foo/intended.js'],
    });

    expect(getModifiedFilesInDir).not.toHaveBeenCalled();
    expect(getUntrackedFilesInDir).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('  + browser/modules/foo/intended.js');

    const updates = vi.mocked(updatePatchAndMetadata).mock.calls[0]?.[3];
    expect(updates?.filesAffected).toEqual([
      'browser/modules/foo/a.js',
      'browser/modules/foo/intended.js',
    ]);
  });

  it('--scan-file rejects invalid option combinations', async () => {
    await expect(
      reExportCommand('/fake/root', ['001'], { scanFiles: ['browser/modules/foo/new.js'] })
    ).rejects.toThrow('--scan-file requires --scan');

    await expect(
      reExportCommand('/fake/root', [], {
        all: true,
        scan: true,
        scanFiles: ['browser/modules/foo/new.js'],
      })
    ).rejects.toThrow('--scan-file operates on exactly one target patch');

    await expect(
      reExportCommand('/fake/root', ['001', '002'], {
        scan: true,
        scanFiles: ['browser/modules/foo/new.js'],
      })
    ).rejects.toThrow('--scan-file operates on exactly one target patch');
  });

  it('--scan-file rejects paths that are not safe engine-relative paths', async () => {
    await expect(
      reExportCommand('/fake/root', ['001'], {
        scan: true,
        scanFiles: ['../outside.js'],
      })
    ).rejects.toThrow('must stay within engine/');
  });

  it('--scan-file rejects files claimed by another patch', async () => {
    restoreTTY = setInteractiveMode(false);
    const patch1 = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    const patch2 = makePatch('002-ui-other.patch', ['browser/modules/foo/claimed.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));
    vi.mocked(getClaimedFiles).mockReturnValue(new Set(['browser/modules/foo/claimed.js']));
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(
      reExportCommand('/fake/root', ['001'], {
        scan: true,
        scanFiles: ['browser/modules/foo/claimed.js'],
      })
    ).rejects.toThrow(/All selected patches failed to re-export/);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already claimed by another patch'));
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
  });

  it('--scan-file dry-run previews without writing', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValueOnce(
      [
        'diff --git a/browser/modules/foo/intended.js b/browser/modules/foo/intended.js',
        '--- /dev/null',
        '+++ b/browser/modules/foo/intended.js',
        '@@ -0,0 +1 @@',
        '+content',
        '',
      ].join('\n')
    );

    await reExportCommand('/fake/root', ['001'], {
      scan: true,
      scanFiles: ['browser/modules/foo/intended.js'],
      dryRun: true,
    });

    expect(info).toHaveBeenCalledWith('  + browser/modules/foo/intended.js');
    expect(info).toHaveBeenCalledWith('[dry-run] 001-ui-test.patch: 2 file(s)');
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
  });

  it('--scan-file does not require --yes for broad-looking non-interactive additions', async () => {
    restoreTTY = setInteractiveMode(false);
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValueOnce(
      [
        'diff --git a/browser/modules/foo/b.js b/browser/modules/foo/b.js',
        '--- /dev/null',
        '+++ b/browser/modules/foo/b.js',
        '@@ -0,0 +1 @@',
        '+b',
        'diff --git a/browser/modules/foo/c.js b/browser/modules/foo/c.js',
        '--- /dev/null',
        '+++ b/browser/modules/foo/c.js',
        '@@ -0,0 +1 @@',
        '+c',
        'diff --git a/browser/modules/foo/d.js b/browser/modules/foo/d.js',
        '--- /dev/null',
        '+++ b/browser/modules/foo/d.js',
        '@@ -0,0 +1 @@',
        '+d',
        'diff --git a/browser/modules/foo/e.js b/browser/modules/foo/e.js',
        '--- /dev/null',
        '+++ b/browser/modules/foo/e.js',
        '@@ -0,0 +1 @@',
        '+e',
        '',
      ].join('\n')
    );

    await reExportCommand('/fake/root', ['001'], {
      scan: true,
      scanFiles: [
        'browser/modules/foo/b.js',
        'browser/modules/foo/c.js',
        'browser/modules/foo/d.js',
        'browser/modules/foo/e.js',
      ],
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
  });

  it('--scan-file rejects explicit added files that produce no diff hunk', async () => {
    restoreTTY = setInteractiveMode(false);
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValueOnce(
      'diff --git a/browser/modules/foo/a.js b/browser/modules/foo/a.js\n+content\n'
    );

    await expect(
      reExportCommand('/fake/root', ['001'], {
        scan: true,
        scanFiles: ['browser/modules/foo/unchanged.js'],
      })
    ).rejects.toThrow(/All selected patches failed to re-export/);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('produced no diff hunks'));
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
  });

  it('surfaces an atomic write failure during scan without a partial commit', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/modules/foo/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/modules/foo/b.js']);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(updatePatchAndMetadata).mockRejectedValueOnce(new Error('write failed'));

    await expect(reExportCommand('/fake/root', ['001'], { scan: true })).rejects.toThrow(
      'All selected patches failed to re-export'
    );

    // Exactly one write attempt — body and manifest move together under one
    // lock, so a partial-commit state is not representable.
    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
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

    const metadataCalls = vi.mocked(updatePatchAndMetadata).mock.calls;
    // Find the scan update call (has filesAffected). arg[3] is the updates
    // object in updatePatchAndMetadata's (patchesDir, filename, body, updates)
    // signature.
    const scanCall = metadataCalls.find(
      (call) => 'filesAffected' in (call[3] as Record<string, unknown>)
    );
    expect(scanCall).toBeDefined();
    const updatedFiles = (scanCall?.[3] as { filesAffected: string[] }).filesAffected;
    expect(updatedFiles).toContain('browser/modules/foo/new.js');
    expect(updatedFiles).not.toContain('browser/modules/foo/claimed.js');
  });

  it('plain re-export checks siblings for suggestions without changing filesAffected', async () => {
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], {});

    expect(getModifiedFilesInDir).toHaveBeenCalledWith('/fake/engine', 'browser/modules/foo');
    expect(getUntrackedFilesInDir).toHaveBeenCalledWith('/fake/engine', 'browser/modules/foo');
    expect(getClaimedFiles).toHaveBeenCalled();
    expect(updatePatchAndMetadata).toHaveBeenCalledWith(
      '/fake/patches',
      '001-ui-test.patch',
      expect.any(String),
      expect.objectContaining({ filesAffected: ['browser/modules/foo/a.js'] }),
      undefined,
      expect.objectContaining({ command: 're-export' })
    );
  });

  it('warns when filesAffected names a path missing from disk without --scan (Finding #16)', async () => {
    // Finding #16 guardrail: re-export without --scan preserves the
    // manifest's filesAffected verbatim. If some of those paths are
    // gone (deleted locally, moved by another branch), the refreshed
    // patch body writes against a stale manifest and `verify` later
    // fails on manifest-consistency with no obvious trigger. The
    // warning alerts the operator before that happens.
    const patch = makePatch('001-ui-test.patch', [
      'browser/modules/foo/a.js',
      'browser/modules/foo/missing.js',
    ]);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(pathExists).mockImplementation((p: string) => {
      if (p.endsWith('/missing.js')) return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await reExportCommand('/fake/root', ['001'], {});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('some files in patches.json no longer exist on disk')
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Re-run with --scan'));
  });

  it('does NOT emit the stale-manifest warning when --scan is set', async () => {
    // --scan already reconciles filesAffected with the worktree, so the
    // advisory is redundant and noisy in that mode. Seed the worktree
    // with a file that exists so the re-export still produces a body
    // (otherwise all-files-missing short-circuits before any warning
    // path could run).
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set());
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true });

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('some files in patches.json no longer exist on disk')
    );
  });

  it('refuses to broaden a patch with many scan-discovered files in non-interactive mode without --yes', async () => {
    // Finding #13: pre-0.16.0 `--scan` silently pulled every sibling
    // modified/untracked file into the patch, including unrelated
    // features that merely shared a directory. The 0.16.0 gate refuses
    // the broad expansion in non-interactive mode unless the operator
    // passes --yes, so drift is visible before it lands in patches.json.
    //
    // The per-patch loop in `reExportCommand` catches the refusal, emits
    // a warn, and rolls it into the "All selected patches failed" outer
    // throw — asserting on the warn gives a stable signal regardless of
    // whether the run contained a single patch (outer throw) or a mix
    // (partial success).
    restoreTTY = setInteractiveMode(false);
    const patch = makePatch('001-infra-startup-wiring.patch', ['browser/base/content/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([
      'browser/base/content/a.js',
      'browser/base/content/b.js',
      'browser/base/content/c.js',
      'browser/base/content/d.js',
      'browser/base/content/e.js',
    ]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(reExportCommand('/fake/root', ['001'], { scan: true })).rejects.toThrow(
      /All selected patches failed to re-export/
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refusing to broaden'));
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
  });

  it('allows broad scan expansion when --yes is passed in non-interactive mode', async () => {
    restoreTTY = setInteractiveMode(false);
    const patch = makePatch('001-infra-startup-wiring.patch', ['browser/base/content/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([
      'browser/base/content/a.js',
      'browser/base/content/b.js',
      'browser/base/content/c.js',
      'browser/base/content/d.js',
      'browser/base/content/e.js',
    ]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true, yes: true });

    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
  });

  it('prompts in interactive mode before broadening and proceeds on confirm', async () => {
    restoreTTY = setInteractiveMode(true);
    const patch = makePatch('001-infra-startup-wiring.patch', ['browser/base/content/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([
      'browser/base/content/a.js',
      'browser/base/content/b.js',
      'browser/base/content/c.js',
      'browser/base/content/d.js',
      'browser/base/content/e.js',
    ]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(confirm).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true });

    expect(confirm).toHaveBeenCalled();
    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
  });

  it('skips the scan gate for small, same-directory additions (common refresh case)', async () => {
    // The threshold is deliberately lenient: <= 3 files in the same
    // directory do not prompt. A typical refresh after a small edit to
    // a couple of sibling files stays frictionless.
    restoreTTY = setInteractiveMode(false);
    const patch = makePatch('001-ui-test.patch', ['browser/modules/foo/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([
      'browser/modules/foo/a.js',
      'browser/modules/foo/b.js',
    ]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
  });

  it('allows dry-run scans without any confirmation', async () => {
    restoreTTY = setInteractiveMode(false);
    const patch = makePatch('001-infra-startup-wiring.patch', ['browser/base/content/a.js']);
    vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([
      'browser/base/content/a.js',
      'browser/base/content/b.js',
      'browser/base/content/c.js',
      'browser/base/content/d.js',
      'browser/base/content/e.js',
    ]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getClaimedFiles).mockReturnValue(new Set<string>());
    vi.mocked(pathExists).mockResolvedValue(true);

    await reExportCommand('/fake/root', ['001'], { scan: true, dryRun: true });

    // Dry-run is always allowed — the whole point is to preview the
    // expansion so the operator can decide whether to run for real.
    expect(confirm).not.toHaveBeenCalled();
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
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

    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
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

    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
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
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
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

    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
    expect(updatePatchAndMetadata).toHaveBeenCalledWith(
      '/fake/patches',
      '002-ui-second.patch',
      expect.any(String),
      expect.any(Object),
      undefined,
      expect.objectContaining({ command: 're-export' })
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

    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[relative-import] browser/modules/foo/a.js: bad import');
    expect(info).toHaveBeenCalledWith('Lint: 1 error(s) downgraded to warnings (--skip-lint)');
    const lintOrder = vi.mocked(lintExportedPatch).mock.invocationCallOrder[0] ?? 0;
    const updateOrder =
      vi.mocked(updatePatchAndMetadata).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
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

    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
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
    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
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

  describe('--stamp', () => {
    it('stamps sourceEsrVersion on every re-exported patch when the run is clean', async () => {
      const patch1 = makePatch('001-ui-first.patch', ['dir/a.js']);
      const patch2 = makePatch('002-ui-second.patch', ['dir/b.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', [], { all: true, stamp: true });

      expect(stampPatchVersions).toHaveBeenCalledTimes(1);
      expect(stampPatchVersions).toHaveBeenCalledWith(
        '/fake/patches',
        ['001-ui-first.patch', '002-ui-second.patch'],
        '140.9.0esr'
      );
      expect(success).toHaveBeenCalledWith('Stamped sourceEsrVersion=140.9.0esr on 2 patch(es)');
    });

    it('refuses to stamp when any selected patch is skipped', async () => {
      const goodPatch = makePatch('001-ui-keep.patch', ['a.js']);
      const missingPatch = makePatch('002-ui-missing.patch', ['missing.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([goodPatch, missingPatch]));
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p === '/fake/engine') return Promise.resolve(true);
        if (p.endsWith('/a.js')) return Promise.resolve(true);
        if (p.endsWith('/missing.js')) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      await reExportCommand('/fake/root', [], { all: true, stamp: true });

      expect(stampPatchVersions).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        '--stamp was requested but some patches failed or were skipped; refusing to stamp a partial set.'
      );
    });

    it('does not stamp during dry-run but announces the plan', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], { dryRun: true, stamp: true });

      expect(stampPatchVersions).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        '[dry-run] Would stamp sourceEsrVersion=140.9.0esr on 1 patch(es)'
      );
    });

    it('is a no-op when --stamp is not passed', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      expect(stampPatchVersions).not.toHaveBeenCalled();
    });
  });

  describe('lintIgnore', () => {
    it('forwards patch.lintIgnore to lintExportedPatch as an ignoreChecks set', async () => {
      const patch = makePatch('001-branding-assets.patch', ['a.js']);
      patch.lintIgnore = ['large-patch-lines', 'large-patch-files'];
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      expect(lintExportedPatch).toHaveBeenCalledTimes(1);
      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      const ignore = call?.[5];
      expect(ignore).toBeInstanceOf(Set);
      expect(ignore?.has('large-patch-lines')).toBe(true);
      expect(ignore?.has('large-patch-files')).toBe(true);
    });

    it('passes undefined when lintIgnore is absent on the patch', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      expect(call?.[5]).toBeUndefined();
    });

    it('passes undefined when lintIgnore is an empty array (no intent to suppress)', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.js']);
      patch.lintIgnore = [];
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      expect(call?.[5]).toBeUndefined();
    });
  });

  describe('tier', () => {
    it('forwards patch.tier to lintExportedPatch as the 7th arg', async () => {
      // 2026-04-21 eval: a branding patch that also touches a non-
      // allowlisted sibling (e.g. a fork-specific theme override
      // under browser/themes/<name>/) declares `tier: "branding"` in
      // patches.json so lintPatchSize applies the branding thresholds
      // on re-export. Without this forwarding, `re-export` would
      // refresh the patch against the general thresholds and refire
      // `large-patch-lines` at 3000 even when the operator had
      // explicitly declared branding shape.
      const patch = makePatch('001-branding-full.patch', [
        'browser/branding/custom/logo.png',
        'browser/themes/custom-shared/tokens.css',
      ]);
      patch.tier = 'branding';
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      expect(lintExportedPatch).toHaveBeenCalledTimes(1);
      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      expect(call?.[6]).toBe('branding');
    });

    it('passes undefined when tier is absent on the patch', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      expect(call?.[6]).toBeUndefined();
    });
  });

  describe('--tier and --lint-ignore flags', () => {
    it('writes tier="branding" into the metadata update when --tier is set', async () => {
      const patch = makePatch('001-branding-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], { tier: 'branding' });

      expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
      const updates = vi.mocked(updatePatchAndMetadata).mock.calls[0]?.[3];
      expect(updates).toMatchObject({ tier: 'branding' });
    });

    it('passes the new tier through to the lint pass on the same invocation', async () => {
      // 2026-04-25 finding #2: setting --tier branding must take effect on
      // the lint pass of the SAME re-export, not just the next one. Without
      // this pre-emption, an operator running `re-export --tier branding`
      // on a patch that crosses 15904 lines would still see a
      // `large-patch-lines` error fire under the general thresholds before
      // the new tier is even committed.
      const patch = makePatch('001-branding-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], { tier: 'branding' });

      expect(lintExportedPatch).toHaveBeenCalledTimes(1);
      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      expect(call?.[6]).toBe('branding');
    });

    it('appends --lint-ignore values to the existing lintIgnore list (union)', async () => {
      const patch = makePatch('001-branding-test.patch', ['a.js']);
      patch.lintIgnore = ['large-patch-lines'];
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {
        lintIgnore: ['large-patch-files'],
      });

      const updates = vi.mocked(updatePatchAndMetadata).mock.calls[0]?.[3];
      expect(updates?.lintIgnore).toEqual(
        expect.arrayContaining(['large-patch-lines', 'large-patch-files'])
      );
      expect(updates?.lintIgnore).toHaveLength(2);
    });

    it('de-duplicates --lint-ignore values that are already in the list', async () => {
      const patch = makePatch('001-branding-test.patch', ['a.js']);
      patch.lintIgnore = ['large-patch-lines'];
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {
        lintIgnore: ['large-patch-lines'],
      });

      const updates = vi.mocked(updatePatchAndMetadata).mock.calls[0]?.[3];
      expect(updates?.lintIgnore).toEqual(['large-patch-lines']);
    });

    it('forwards the merged lintIgnore set to the lint pass on the same invocation', async () => {
      const patch = makePatch('001-branding-test.patch', ['a.js']);
      patch.lintIgnore = ['large-patch-lines'];
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {
        lintIgnore: ['large-patch-files'],
      });

      const call = vi.mocked(lintExportedPatch).mock.calls[0];
      const ignoreSet = call?.[5];
      expect(ignoreSet).toBeInstanceOf(Set);
      expect(ignoreSet?.has('large-patch-lines')).toBe(true);
      expect(ignoreSet?.has('large-patch-files')).toBe(true);
    });

    it('rejects --tier when combined with --all', async () => {
      const patch1 = makePatch('001-a.patch', ['a.js']);
      const patch2 = makePatch('002-b.patch', ['b.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));

      await expect(
        reExportCommand('/fake/root', [], { all: true, tier: 'branding' })
      ).rejects.toThrow(/cannot be combined with --all/);

      expect(updatePatchAndMetadata).not.toHaveBeenCalled();
    });

    it('rejects --lint-ignore when combined with --all', async () => {
      const patch1 = makePatch('001-a.patch', ['a.js']);
      const patch2 = makePatch('002-b.patch', ['b.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch1, patch2]));

      await expect(
        reExportCommand('/fake/root', [], {
          all: true,
          lintIgnore: ['large-patch-files'],
        })
      ).rejects.toThrow(/cannot be combined with --all/);

      expect(updatePatchAndMetadata).not.toHaveBeenCalled();
    });

    it('does not include tier or lintIgnore in the metadata update when neither flag is passed', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.js']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await reExportCommand('/fake/root', ['001'], {});

      const updates = vi.mocked(updatePatchAndMetadata).mock.calls[0]?.[3];
      expect(updates).toBeDefined();
      expect(updates).not.toHaveProperty('tier');
      expect(updates).not.toHaveProperty('lintIgnore');
    });
  });
});
