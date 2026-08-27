// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    firefox: { version: '140.9.0esr' },
  }),
  loadState: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  // Engine-precondition ladder (assertEngineGitReady). Stubbed to the
  // healthy-engine answers so these suites test their own subject.
  isGitRepository: vi.fn(() => Promise.resolve(true)),
  isMissingHeadError: vi.fn(() => false),

  getHead: vi.fn(),
}));

vi.mock('../../core/git-status.js', () => ({
  resolveMaxUntrackedFilesPerDir: vi.fn(() => 5000),
  getDirtyFiles: vi.fn().mockResolvedValue([]),
}));

const computePatchedContentMock = vi.hoisted(() =>
  vi.fn<(p: string, e: string, f: string) => Promise<string | null>>()
);

vi.mock('../../core/patch-apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/patch-apply.js')>();
  return {
    countPatches: vi.fn(),
    discoverPatches: vi.fn().mockResolvedValue([]),
    extractAffectedFiles: vi.fn().mockReturnValue([]),
    applyPatchesWithContinue: vi.fn(),
    // Batched context delegates to the shared mock so
    // computePatchedContentMock.mockResolvedValue calls drive tests.
    createPatchedContentContext: vi.fn(() =>
      Promise.resolve({
        manifestPatches: [],
        computePatched: (file: string) => computePatchedContentMock('', '', file),
        getAffectingPatches: () => [],
        readPatchBody: vi.fn(),
      })
    ),
    // Real matcher: --until scope-set resolution must share the apply
    // loop's identifier semantics (filenames AND bare ordinals).
    matchesUntilFilename: actual.matchesUntilFilename,
    PatchError: class PatchError extends Error {},
  };
});

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(),
  checkVersionCompatibility: vi.fn().mockReturnValue(null),
  validatePatchIntegrity: vi.fn().mockResolvedValue([]),
  validatePatchesManifestConsistency: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  readText: vi.fn().mockResolvedValue(''),
}));

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
  warn: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn().mockReturnValue({
    stop: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
}));

vi.mock('../../core/test-stale-check.js', () => ({
  warnIfStaticComponentsStale: vi.fn(() => Promise.resolve()),
}));

import { confirm } from '@clack/prompts';

import { loadState, updateState } from '../../core/config.js';
import { getHead } from '../../core/git.js';
import { getDirtyFiles } from '../../core/git-status.js';
import {
  applyPatchesWithContinue,
  countPatches,
  discoverPatches,
  extractAffectedFiles,
} from '../../core/patch-apply.js';
import {
  loadPatchesManifest,
  validatePatchesManifestConsistency,
  validatePatchIntegrity,
} from '../../core/patch-manifest.js';
import { warnIfStaticComponentsStale } from '../../core/test-stale-check.js';
import { pathExists, readText } from '../../utils/fs.js';
import { error, info, outro, spinner, success, warn } from '../../utils/logger.js';
import { importCommand } from '../import.js';

function setStdinIsTTY(value: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  // import's interactivity check requires BOTH streams to be TTYs (a piped
  // stdout would render the confirm prompt into the pipe), matching
  // discard/reset — stub both.
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });

  return () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }
  };
}

describe('importCommand drift handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'base-commit' });
    vi.mocked(getHead).mockResolvedValue('drifted-head');
    vi.mocked(countPatches).mockResolvedValue(1);
    vi.mocked(getDirtyFiles).mockResolvedValue([]);
    computePatchedContentMock.mockResolvedValue('');
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
    ]);
    vi.mocked(extractAffectedFiles).mockReturnValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
    ]);
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(applyPatchesWithContinue).mockResolvedValue({
      total: 1,
      succeeded: [
        {
          patch: { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
          success: true,
        },
      ],
      failed: [],
      skipped: [],
    });
  });

  it('cancels in non-interactive mode without --force', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await expect(importCommand('/fake/root')).rejects.toThrow(
        /Re-run with --yes to accept the drift, or --force to also bypass the patch-integrity gate/
      );
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('still cancels in non-interactive mode with --continue but without --force', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await expect(importCommand('/fake/root', { continue: true })).rejects.toThrow(
        /Re-run with --yes to accept the drift, or --force to also bypass the patch-integrity gate/
      );
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('proceeds in non-interactive mode with --force', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await importCommand('/fake/root', { force: true });
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', {
      continueOnFailure: false,
      untilFilename: undefined,
    });
    expect(warn).toHaveBeenCalledWith(
      'Engine HEAD has drifted from base commit. Continuing because --force was provided in non-interactive mode.'
    );
  });

  it('proceeds in non-interactive mode with both --force and --continue', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await importCommand('/fake/root', { force: true, continue: true });
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', {
      continueOnFailure: true,
      untilFilename: undefined,
    });
  });

  it('still prompts in interactive mode when drift is detected', async () => {
    const restoreTTY = setStdinIsTTY(true);
    vi.mocked(confirm).mockResolvedValue(false);

    try {
      await importCommand('/fake/root');
    } finally {
      restoreTTY();
    }

    expect(confirm).toHaveBeenCalled();
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith('Import cancelled by user');
  });

  it('skips prompt in interactive mode with --force when drift is detected', async () => {
    const restoreTTY = setStdinIsTTY(true);

    try {
      await importCommand('/fake/root', { force: true });
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', {
      continueOnFailure: false,
      untilFilename: undefined,
    });
    expect(warn).toHaveBeenCalledWith(
      'Engine HEAD has drifted from base commit. Continuing because --force was provided.'
    );
  });

  it('allows already materialized patch-backed files without requiring --force', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(1);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
    ]);
    vi.mocked(extractAffectedFiles).mockReturnValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
    ]);
    vi.mocked(getDirtyFiles).mockResolvedValue(['browser/modules/mybrowser/FlushManager.sys.mjs']);
    computePatchedContentMock.mockResolvedValue('patched-content\n');
    vi.mocked(readText).mockResolvedValue('patched-content\n');
    vi.mocked(pathExists).mockResolvedValue(true);

    await importCommand('/fake/root');

    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', {
      continueOnFailure: false,
      untilFilename: undefined,
    });
    expect(info).toHaveBeenCalledWith(
      'Patch-touched files already match the stored patch stack — no engine resync needed before re-applying.'
    );
  });

  it('runs the components.conf staleness advisory after a successful import', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await importCommand('/fake/root');

    expect(applyPatchesWithContinue).toHaveBeenCalled();
    expect(warnIfStaticComponentsStale).toHaveBeenCalledWith('/fake/root', '/fake/engine');
  });

  it('skips the staleness advisory on --dry-run', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await importCommand('/fake/root', { dryRun: true });

    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
    expect(warnIfStaticComponentsStale).not.toHaveBeenCalled();
  });

  it('still blocks unmanaged dirty files without --force', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(1);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
    ]);
    vi.mocked(extractAffectedFiles).mockReturnValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
    ]);
    vi.mocked(getDirtyFiles).mockResolvedValue(['browser/modules/mybrowser/FlushManager.sys.mjs']);
    computePatchedContentMock.mockResolvedValue('patched-content\n');
    vi.mocked(readText).mockResolvedValue('patched-content\n// local drift\n');
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(importCommand('/fake/root')).rejects.toThrow(
      'Uncommitted changes in patch-touched files. Commit or stash them first, or use --force.'
    );

    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('  browser/modules/mybrowser/FlushManager.sys.mjs');
  });

  it('summarizes unmanaged dirty files before overwriting them with --force', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(2);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
      { filename: '002-ui-sidebar.patch', path: '/fake/patches/002.patch', order: 2 },
    ]);
    vi.mocked(extractAffectedFiles)
      .mockReturnValueOnce(['browser/modules/mybrowser/FlushManager.sys.mjs'])
      .mockReturnValueOnce(['browser/components/sidebar/sidebar.css']);
    vi.mocked(getDirtyFiles).mockResolvedValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
      'browser/components/sidebar/sidebar.css',
    ]);
    computePatchedContentMock
      .mockResolvedValueOnce('patched-content\n')
      .mockResolvedValueOnce(':root { color: blue; }\n');
    vi.mocked(readText).mockImplementation((targetPath) => {
      if (targetPath === '/fake/engine/browser/modules/mybrowser/FlushManager.sys.mjs') {
        return Promise.resolve('patched-content\n// local drift\n');
      }
      if (targetPath === '/fake/engine/browser/components/sidebar/sidebar.css') {
        return Promise.resolve(':root { color: red; }\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(importCommand('/fake/root', { force: true })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '--force will overwrite 2 unmanaged changes in patch-touched files:'
    );
    expect(warn).toHaveBeenCalledWith('  browser/components/sidebar/sidebar.css');
    expect(warn).toHaveBeenCalledWith('  browser/modules/mybrowser/FlushManager.sys.mjs');
    expect(warn).toHaveBeenCalledWith(
      'Patch reapplication may restore these paths to the engine baseline before reapplying patches.'
    );
  });

  it('refuses to import when patches.json disagrees with on-disk patch files', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'untracked-patch-file',
        filename: '001-ui-test.patch',
        message: '001-ui-test.patch exists on disk but is not tracked in patches.json.',
      },
    ]);

    await expect(importCommand('/fake/root', { force: true })).rejects.toThrow(
      'Patch manifest consistency check failed'
    );

    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('returns early when the patches directory does not exist', async () => {
    vi.mocked(loadState).mockResolvedValue({});
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(targetPath !== '/fake/patches')
    );

    await expect(importCommand('/fake/root')).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('No patches directory found. Nothing to import.');
    expect(outro).toHaveBeenCalledWith('Import complete (no patches)');
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('warns about patch integrity issues and proceeds when --force is set', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(validatePatchIntegrity).mockResolvedValueOnce([
      {
        filename: '001-ui-test.patch',
        message: 'references a file that is no longer present in HEAD',
        targetFile: null,
      },
    ]);

    await expect(importCommand('/fake/root', { force: true })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('\nPatch integrity issues detected:');
    expect(warn).toHaveBeenCalledWith(
      '  001-ui-test.patch: references a file that is no longer present in HEAD'
    );
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', {
      continueOnFailure: false,
      untilFilename: undefined,
    });
  });

  it('refuses to import in non-interactive mode when integrity issues are detected and --force is not set', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(validatePatchIntegrity).mockResolvedValueOnce([
      {
        filename: '001-ui-test.patch',
        message: 'references a file that is no longer present in HEAD',
        targetFile: null,
      },
    ]);

    await expect(importCommand('/fake/root')).rejects.toThrow(
      /Refusing to import while 1 patch integrity issue/
    );

    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('reports auto-resolved patches and successful import summaries', async () => {
    const spinnerHandle = {
      message: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(spinner).mockReturnValue(spinnerHandle);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(applyPatchesWithContinue).mockResolvedValueOnce({
      total: 2,
      succeeded: [
        {
          patch: { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
          success: true,
          autoResolved: true,
        },
        {
          patch: { filename: '002-ui-followup.patch', path: '/fake/patches/002.patch', order: 2 },
          success: true,
        },
      ],
      failed: [],
      skipped: [],
    });

    await expect(importCommand('/fake/root')).resolves.toBeUndefined();

    expect(spinnerHandle.stop).toHaveBeenCalledWith('Applied 2 patches (1 auto-resolved)');
    expect(success).toHaveBeenCalledWith('  001-ui-test.patch (auto-resolved)');
    expect(success).toHaveBeenCalledWith('  002-ui-followup.patch');
    expect(outro).toHaveBeenCalledWith('All patches applied successfully!');
  });

  it('shows a generic spinner error when patch application throws a non-PatchError', async () => {
    const spinnerHandle = {
      message: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(spinner).mockReturnValue(spinnerHandle);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(applyPatchesWithContinue).mockRejectedValueOnce(new Error('git blew up'));

    await expect(importCommand('/fake/root')).rejects.toThrow('git blew up');

    expect(spinnerHandle.error).toHaveBeenCalledWith('Patch application failed');
    expect(spinnerHandle.stop).not.toHaveBeenCalled();
  });

  it('persists pending resolution state when patch application fails', async () => {
    const state = { baseCommit: 'base-commit' };
    vi.mocked(loadState).mockResolvedValue(state);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(applyPatchesWithContinue).mockResolvedValueOnce({
      total: 2,
      succeeded: [],
      failed: [
        {
          patch: { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
          success: false,
          error: 'context mismatch',
          conflictingFiles: ['browser/modules/mybrowser/FlushManager.sys.mjs'],
        },
      ],
      skipped: [{ filename: '002-ui-followup.patch', path: '/fake/patches/002.patch', order: 2 }],
    });

    await expect(importCommand('/fake/root')).rejects.toThrow('Failed to apply 1 patch(es)');

    // updateState is called with a transactional updater function. Invoke it
    // with a freshly-loaded state to verify the shape of the write, since
    // the caller-captured state must NOT flow into the write path.
    expect(updateState).toHaveBeenCalledTimes(1);
    const [root, updater] = vi.mocked(updateState).mock.calls[0] ?? [];
    expect(root).toBe('/fake/root');
    expect(typeof updater).toBe('function');
    const applied = (updater as (current: typeof state) => typeof state)({
      baseCommit: 'base-commit-refreshed',
    });
    expect(applied).toEqual({
      baseCommit: 'base-commit-refreshed',
      pendingResolution: {
        patchFilename: '001-ui-test.patch',
        originalError: 'context mismatch',
      },
    });

    expect(error).toHaveBeenCalledWith('\nFailed: 001-ui-test.patch');
    expect(warn).toHaveBeenCalledWith('\n1 patch(es) were skipped:');
    expect(info).toHaveBeenCalledWith('\nResolution Instructions:');
  });

  it('scopes --until to skip integrity issues on out-of-range later patches', async () => {
    // With `--until 001-foo.patch`, an integrity problem on 002-bar.patch
    // must not block the import: `validatePatchIntegrity` scans every patch,
    // so the returned issues are filtered to the `--until` range and a
    // broken later patch does not prevent replaying an earlier good subset.
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(2);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-foo.patch',
          name: 'foo',
          order: 1,
          category: 'ui',
          description: '',
          filesAffected: ['a.js'],
          createdAt: '2026-04-20T00:00:00Z',
          sourceEsrVersion: '140.9.0esr',
        },
        {
          filename: '002-bar.patch',
          name: 'bar',
          order: 2,
          category: 'ui',
          description: '',
          filesAffected: ['b.js'],
          createdAt: '2026-04-20T00:00:00Z',
          sourceEsrVersion: '140.9.0esr',
        },
      ],
    });
    vi.mocked(validatePatchIntegrity).mockResolvedValue([
      {
        filename: '002-bar.patch',
        message: 'manifest mismatch',
        targetFile: null,
      },
    ]);
    vi.mocked(applyPatchesWithContinue).mockResolvedValue({
      total: 1,
      succeeded: [
        {
          patch: { filename: '001-foo.patch', path: '/fake/patches/001-foo.patch', order: 1 },
          success: true,
        },
      ],
      failed: [],
      skipped: [],
    });

    await expect(importCommand('/fake/root', { until: '001-foo.patch' })).resolves.toBeUndefined();

    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', {
      continueOnFailure: false,
      untilFilename: '001-foo.patch',
    });
  });

  it('still blocks --until when the in-range patch itself has an integrity issue', async () => {
    // Defensive complement to the scoping test: if the failing patch IS in
    // the `--until` range, the integrity block still fires. Without this, the
    // filter above would accidentally be a blanket suppression.
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(2);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-foo.patch',
          name: 'foo',
          order: 1,
          category: 'ui',
          description: '',
          filesAffected: ['a.js'],
          createdAt: '2026-04-20T00:00:00Z',
          sourceEsrVersion: '140.9.0esr',
        },
        {
          filename: '002-bar.patch',
          name: 'bar',
          order: 2,
          category: 'ui',
          description: '',
          filesAffected: ['b.js'],
          createdAt: '2026-04-20T00:00:00Z',
          sourceEsrVersion: '140.9.0esr',
        },
      ],
    });
    vi.mocked(validatePatchIntegrity).mockResolvedValue([
      {
        filename: '001-foo.patch',
        message: 'references a missing file',
        targetFile: null,
      },
    ]);

    await expect(importCommand('/fake/root', { until: '001-foo.patch' })).rejects.toThrow(
      /Refusing to import while 1 patch integrity issue/
    );
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('resolves a bare-ordinal --until so in-range integrity issues still block', async () => {
    // `--until 5` matching FILENAMES only makes the scope set come back
    // empty — integrity issues inside the range are silently dropped,
    // dry-run previews "0 patches", and the apply loop (whose matcher
    // accepts ordinals) applies 1..5 anyway.
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(2);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-foo.patch',
          name: 'foo',
          order: 1,
          category: 'ui',
          description: '',
          filesAffected: ['a.js'],
          createdAt: '2026-04-20T00:00:00Z',
          sourceEsrVersion: '140.9.0esr',
        },
        {
          filename: '002-bar.patch',
          name: 'bar',
          order: 2,
          category: 'ui',
          description: '',
          filesAffected: ['b.js'],
          createdAt: '2026-04-20T00:00:00Z',
          sourceEsrVersion: '140.9.0esr',
        },
      ],
    });
    vi.mocked(validatePatchIntegrity).mockResolvedValue([
      {
        filename: '001-foo.patch',
        message: 'references a missing file',
        targetFile: null,
      },
    ]);

    await expect(importCommand('/fake/root', { until: '1' })).rejects.toThrow(
      /Refusing to import while 1 patch integrity issue/
    );
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });
});
