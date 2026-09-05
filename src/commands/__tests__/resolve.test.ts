// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, loadState, updateState } from '../../core/config.js';
import { isGitRepository } from '../../core/git.js';
import { getStagedDiffForFiles } from '../../core/git-diff.js';
import { stageFiles, unstageFiles } from '../../core/git-file-ops.js';
import { updatePatchAndMetadata } from '../../core/patch-export.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { nativePath } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import { resolveCommand } from '../resolve.js';

/** Options object `updatePatchAndMetadata` is called with, for matcher casts. */
type UpdateArgs = Parameters<typeof updatePatchAndMetadata>[0];

/**
 * Returns a minimal unified-diff body that `extractAffectedFiles` parses into
 * the supplied file list. `resolve` derives `filesAffected` from the diff
 * content itself, so the mock has to supply a real diff shape rather than a
 * bare placeholder string.
 */
function fakeUnifiedDiff(files: string[]): string {
  return files
    .map(
      (file) =>
        `diff --git a/${file} b/${file}\nindex 0..1 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`
    )
    .join('');
}

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
  loadState: vi.fn(),
  updateState: vi.fn(),
  loadConfig: vi.fn(),
}));
vi.mock('../../core/git.js');
vi.mock('../../core/git-diff.js');
vi.mock('../../core/git-file-ops.js');
vi.mock('../../core/patch-export.js');
vi.mock('../../core/patch-manifest.js');
vi.mock('../../utils/fs.js');
vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn().mockReturnValue({
    stop: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('@clack/prompts');

describe('resolveCommand', () => {
  const projectRoot = '/fake/root';

  const originalIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate interactive terminal for resolve command
    // resolve requires BOTH streams to be TTYs (piped stdout would render
    // the confirm prompt into the pipe) — stub both.
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test',
      vendor: 'Test',
      appId: 'test',
      binaryName: 'test',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
  });

  it('should exit if no pending resolution', async () => {
    vi.mocked(loadState).mockResolvedValue({});
    await resolveCommand(projectRoot);
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it('should successfully resolve a patch', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    const diff = fakeUnifiedDiff(['file1.js']);
    vi.mocked(getStagedDiffForFiles).mockResolvedValue(diff);

    await resolveCommand(projectRoot);

    expect(stageFiles).toHaveBeenCalledWith(expect.any(String), ['file1.js']);
    expect(updatePatchAndMetadata).toHaveBeenCalledWith({
      patchesDir: expect.any(String) as string,
      filename: patchFilename,
      newContent: diff,
      updates: expect.objectContaining({
        filesAffected: ['file1.js'],
        sourceEsrVersion: '140.9.0esr',
      }) as UpdateArgs['updates'],
      onCommitted: undefined,
      policyGate: undefined,
      // `resolve` honours `--wait-lock`: it rewrites a patch body and its
      // metadata under the patch-directory lock.
      lockOptions: expect.objectContaining({ command: 'resolve' }) as UpdateArgs['lockOptions'],
    });
    // updateState is called with a transactional updater that deletes
    // pendingResolution; exercise the updater to confirm the delete.
    expect(updateState).toHaveBeenCalledWith(projectRoot, expect.any(Function));
    const updater = vi.mocked(updateState).mock.calls.at(-1)?.[1] as (
      current: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(updater({ pendingResolution: { patchFilename: 'x', originalError: 'y' } })).toEqual({});
  });

  it('should fail if no changes detected', async () => {
    const patchFilename = '001-test.patch';
    const pendingResolution = { patchFilename, originalError: 'error' };
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution,
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(getStagedDiffForFiles).mockResolvedValue('');

    await resolveCommand(projectRoot);

    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      'No patch update was generated from the staged diff. Pending resolution was left intact so you can retry. To discard the resolution state, delete the "pendingResolution" key from state.json.'
    );
    expect(unstageFiles).toHaveBeenCalledWith(expect.any(String), ['file1.js']);
  });

  it('persists missing-files metadata only after writing the refreshed patch', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js', 'file2.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(
        targetPath.endsWith('file1.js') || !targetPath.includes(nativePath('/fake/engine/'))
      )
    );
    const diff = fakeUnifiedDiff(['file1.js']);
    vi.mocked(getStagedDiffForFiles).mockResolvedValue(diff);

    await resolveCommand(projectRoot);

    expect(stageFiles).toHaveBeenCalledWith(expect.any(String), ['file1.js']);
    expect(updatePatchAndMetadata).toHaveBeenCalledTimes(1);
    expect(updatePatchAndMetadata).toHaveBeenCalledWith({
      patchesDir: expect.any(String) as string,
      filename: patchFilename,
      newContent: diff,
      updates: expect.objectContaining({
        filesAffected: ['file1.js'],
        sourceEsrVersion: '140.9.0esr',
      }) as UpdateArgs['updates'],
      onCommitted: undefined,
      policyGate: undefined,
      // `resolve` honours `--wait-lock`: it rewrites a patch body and its
      // metadata under the patch-directory lock.
      lockOptions: expect.objectContaining({ command: 'resolve' }) as UpdateArgs['lockOptions'],
    });
  });

  it('refuses to resolve when the patch file is missing on disk', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    // Engine and engine files exist; the patch file itself does not.
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(!targetPath.endsWith('001-test.patch'))
    );

    await expect(resolveCommand(projectRoot)).rejects.toThrow(
      /Patch file 001-test\.patch is missing on disk/
    );

    expect(updatePatchAndMetadata).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
  });

  it('does not mutate the manifest when patch rewriting fails', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js', 'file2.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(
        targetPath.endsWith('file1.js') || !targetPath.includes(nativePath('/fake/engine/'))
      )
    );
    vi.mocked(getStagedDiffForFiles).mockResolvedValue(fakeUnifiedDiff(['file1.js']));
    vi.mocked(updatePatchAndMetadata).mockRejectedValue(new Error('disk full'));

    await expect(resolveCommand(projectRoot)).rejects.toThrow('disk full');

    expect(updateState).not.toHaveBeenCalled();
  });

  it('derives filesAffected from the diff body even when all files remain on disk', async () => {
    // A manual fix can eliminate every hunk for a file while the file still
    // exists on disk. Keeping the stale `filesAffected` because
    // `activeFiles.length === existingFiles.length` then fails the next
    // import's patch-manifest consistency check; `filesAffected` is
    // recomputed from the diff itself every time.
    //
    // Reset updatePatchAndMetadata explicitly: `vi.clearAllMocks()` only
    // clears recorded calls, not the rejected implementation a preceding
    // test installed.
    vi.mocked(updatePatchAndMetadata).mockReset();
    vi.mocked(updatePatchAndMetadata).mockResolvedValue(true);
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js', 'file2.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    // The staged diff only contains file1.js; file2.js's hunks were
    // dropped by the manual fix but the file itself still exists.
    const diff = fakeUnifiedDiff(['file1.js']);
    vi.mocked(getStagedDiffForFiles).mockResolvedValue(diff);

    await resolveCommand(projectRoot);

    expect(updatePatchAndMetadata).toHaveBeenCalledWith({
      patchesDir: expect.any(String) as string,
      filename: patchFilename,
      newContent: diff,
      updates: expect.objectContaining({
        filesAffected: ['file1.js'],
        sourceEsrVersion: '140.9.0esr',
      }) as UpdateArgs['updates'],
      onCommitted: undefined,
      policyGate: undefined,
      // `resolve` honours `--wait-lock`: it rewrites a patch body and its
      // metadata under the patch-directory lock.
      lockOptions: expect.objectContaining({ command: 'resolve' }) as UpdateArgs['lockOptions'],
    });
  });

  describe('non-interactive --yes flag', () => {
    const patchFilename = '001-test.patch';

    beforeEach(() => {
      vi.mocked(loadState).mockResolvedValue({
        pendingResolution: { patchFilename, originalError: 'error' },
      });
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: patchFilename,
            filesAffected: ['file1.js'],
            order: 1,
            category: 'ui',
            name: 'test',
            description: '',
            createdAt: '',
            sourceEsrVersion: '128.0esr',
          },
        ],
      });
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getStagedDiffForFiles).mockResolvedValue(fakeUnifiedDiff(['file1.js']));
    });

    it('still refuses in non-interactive mode without --yes', async () => {
      process.stdin.isTTY = false;
      try {
        await expect(resolveCommand(projectRoot)).rejects.toThrow(/non-interactive mode/i);
      } finally {
        process.stdin.isTTY = true;
      }
    });

    it('completes in non-interactive mode when --yes is passed', async () => {
      // Scripted recovery flows hit the unconditional TTY refusal even after
      // the operator has manually merged; `--yes` lets the same flow
      // continue without forcing them back into a terminal.
      process.stdin.isTTY = false;
      try {
        await resolveCommand(projectRoot, { yes: true });
      } finally {
        process.stdin.isTTY = true;
      }

      // Confirmation prompt must not have fired (that would require a TTY anyway).
      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      // The refresh still ran — `updatePatchAndMetadata` is the
      // observable effect of a completed resolve.
      expect(updatePatchAndMetadata).toHaveBeenCalled();
    });

    it('skips the confirmation prompt even in a TTY when --yes is passed', async () => {
      process.stdin.isTTY = true;
      await resolveCommand(projectRoot, { yes: true });
      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      expect(updatePatchAndMetadata).toHaveBeenCalled();
    });

    it('surfaces clearer two-step continuation messaging on success', async () => {
      // The info line must name the second-step command and say explicitly
      // that resolve does not continue the queue itself — help text reading
      // "...and continue" implies a one-step flow.
      process.stdin.isTTY = false;
      try {
        await resolveCommand(projectRoot, { yes: true });
      } finally {
        process.stdin.isTTY = true;
      }

      const infoCalls = vi.mocked(info).mock.calls.map((call) => call[0]);
      expect(
        infoCalls.some((msg) => /resume the queue/.test(msg) && /fireforge import/.test(msg))
      ).toBe(true);
    });
  });
});
