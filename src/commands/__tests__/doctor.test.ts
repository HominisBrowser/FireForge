// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  configExists: vi.fn(() => Promise.resolve(true)),
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    })
  ),
  loadState: vi.fn(() => Promise.resolve({})),
  updateState: vi.fn(() => Promise.resolve()),
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../../core/git-base.js', () => ({
  ensureGit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/git.js')>();
  return {
    isGitRepository: vi.fn(() => Promise.resolve(true)),
    getHead: vi.fn(() => Promise.resolve('base-commit')),
    getCurrentBranch: vi.fn(() => Promise.resolve('firefox')),
    isMissingHeadError: actual.isMissingHeadError,
  };
});

vi.mock('../../core/git-status.js', () => ({
  getWorkingTreeStatus: vi.fn(() => Promise.resolve([])),
  expandUntrackedDirectoryEntries: vi.fn((_dir: string, entries: unknown[]) =>
    Promise.resolve(entries)
  ),
}));

vi.mock('../../core/status-classify.js', () => ({
  // Default classifier mirrors the real contract just enough for the doctor
  // tests: anything under browser/branding/ or browser/moz.configure becomes
  // `branding`; other entries become `unmanaged`. Individual tests override
  // this with a custom implementation when they need to exercise the
  // patch-backed / furnace / conflict buckets.
  classifyFiles: vi.fn(
    (
      entries: Array<{ status: string; file: string }>,
      _engineDir: string,
      _patchesDir: string,
      binaryName: string
    ) =>
      Promise.resolve(
        entries.map((entry) => {
          const isBranding =
            entry.file === 'browser/moz.configure' ||
            entry.file.startsWith(`browser/branding/${binaryName}/`);
          return {
            ...entry,
            classification: isBranding ? ('branding' as const) : ('unmanaged' as const),
          };
        })
      )
  ),
}));

vi.mock('../../core/mach.js', () => ({
  ensurePython: vi.fn(() => Promise.resolve()),
  ensureMach: vi.fn(() => Promise.resolve()),
}));

// Furnace checks default to "not a furnace project" so every existing test
// stays on the same check count — the furnace checks all skipIf when
// `furnaceConfigExists` is false. Tests that exercise the furnace path
// override these mocks individually.
vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    })
  ),
  loadFurnaceState: vi.fn(() => Promise.resolve({})),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
  // Non-furnace projects contribute no managed prefixes — mirror the
  // real helper's contract so the ownership-aware doctor check can call
  // it unconditionally.
  collectFurnaceManagedPrefixes: vi.fn(() => Promise.resolve(new Set<string>())),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve([])),
  stat: vi.fn(() => Promise.reject(new Error('not found'))),
  readFile: vi.fn(() => Promise.reject(new Error('not found'))),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-apply.js', () => ({
  applyAllComponents: vi.fn(() => Promise.resolve({ applied: [], skipped: [], errors: [] })),
}));

vi.mock('../../core/furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (_root: string, _kind: string, body: (ctx: unknown) => Promise<unknown>) =>
      body({
        registerJournal: vi.fn(),
        registerCleanup: vi.fn(),
      })
  ),
  // Required by the new `furnaceStaleLockCheck` in doctor-furnace.ts; returns
  // a stable, never-on-disk path so `pathExists` reports absent in the
  // default mock configuration (which then short-circuits the check to ok).
  getFurnaceLockPath: vi.fn((root: string) => `${root}/.fireforge/furnace.lock`),
}));

vi.mock('../../core/furnace-validate.js', () => ({
  validateAllComponents: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock('../../core/furnace-apply-helpers.js', () => ({
  hasOverrideEngineDrift: vi.fn(() => Promise.resolve(false)),
  hasCustomEngineDrift: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/patch-apply.js', () => ({
  countPatches: vi.fn(() => Promise.resolve(1)),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  rebuildPatchesManifest: vi.fn(() =>
    Promise.resolve({ manifest: { version: 1, patches: [] }, recoveredFilenames: [] })
  ),
  validatePatchIntegrity: vi.fn(() => Promise.resolve([])),
  validatePatchesManifestConsistency: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
  readJson: vi.fn(() => Promise.reject(new Error('not found'))),
  readText: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../../utils/process.js', () => ({
  // Default to "watchman is installed" so the new check shows ok for the
  // broad swath of existing tests that don't care about watch mode. The
  // specific regression test for the missing-watchman branch overrides
  // this with mockResolvedValueOnce(undefined).
  // Doctor switched from `executableExists` (boolean) to `findExecutable`
  // (returns the resolved path or undefined) so the OK row can name the
  // path it actually found — see the 2026-04-25 eval finding where the
  // operator's interactive shell saw no watchman but doctor reported OK.
  findExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/watchman')),
  executableExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../verify.js', () => ({
  collectPatchQueueHealth: vi.fn(() =>
    Promise.resolve({
      hasPatchesDirectory: true,
      groups: [],
      errorCount: 0,
      warningCount: 0,
    })
  ),
}));

import { readdir, rm } from 'node:fs/promises';

import { configExists, loadConfig, loadState, updateState } from '../../core/config.js';
import { applyAllComponents } from '../../core/furnace-apply.js';
import { hasCustomEngineDrift, hasOverrideEngineDrift } from '../../core/furnace-apply-helpers.js';
import {
  furnaceConfigExists as checkFurnaceConfigExists,
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import { validateAllComponents } from '../../core/furnace-validate.js';
import { getCurrentBranch, getHead, isGitRepository } from '../../core/git.js';
import { ensureGit } from '../../core/git-base.js';
import { getWorkingTreeStatus } from '../../core/git-status.js';
import { ensurePython } from '../../core/mach.js';
import {
  rebuildPatchesManifest,
  validatePatchesManifestConsistency,
  validatePatchIntegrity,
} from '../../core/patch-manifest.js';
import { classifyFiles } from '../../core/status-classify.js';
import { pathExists, readJson, readText } from '../../utils/fs.js';
import { error, outro, success, warn } from '../../utils/logger.js';
import {
  DOCTOR_CHECK_ORDER,
  doctorCommand,
  registerDoctor,
  validateCheckDependencies,
} from '../doctor.js';
import type { DoctorCheckDefinition } from '../doctor-check-core.js';
import { collectPatchQueueHealth } from '../verify.js';

function createProgram(): Command {
  const program = new Command();

  registerDoctor(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

describe('doctorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    vi.mocked(loadState).mockResolvedValue({});
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(getCurrentBranch).mockResolvedValue('firefox');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([]);
    vi.mocked(validatePatchIntegrity).mockResolvedValue([]);
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValue([]);
    vi.mocked(rebuildPatchesManifest).mockResolvedValue({
      manifest: { version: 1, patches: [] },
      recoveredFilenames: [],
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(rm).mockResolvedValue(undefined);
    // Reset furnace mocks to their "project does not use furnace" defaults.
    // `clearAllMocks` clears call history but preserves implementations, so
    // a `.mockResolvedValue(true)` set in a nested describe would persist
    // into sibling tests that expect the skip path.
    vi.mocked(checkFurnaceConfigExists).mockResolvedValue(false);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({});
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(false);
    vi.mocked(hasCustomEngineDrift).mockResolvedValue(false);
    vi.mocked(validateAllComponents).mockResolvedValue(new Map());
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [],
    });
    vi.mocked(updateState).mockResolvedValue(undefined);
    vi.mocked(collectPatchQueueHealth).mockResolvedValue({
      hasPatchesDirectory: true,
      groups: [],
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('runs post-rebase registration audit when requested', async () => {
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('browser/moz.configure')) {
        return Promise.resolve('option("--with-browser-chrome-url", help=BROWSER_CHROME_URL)');
      }
      if (filePath.endsWith('browser/base/jar.mn')) {
        return Promise.resolve('content/browser/browser.xhtml');
      }
      if (filePath.endsWith('toolkit/content/customElements.js')) {
        return Promise.resolve('customElements.setElementCreationCallback("moz-dock", () => {})');
      }
      if (filePath.endsWith('toolkit/content/jar.mn')) {
        return Promise.resolve('content/global/elements/moz-dock.mjs');
      }
      return Promise.resolve('');
    });
    vi.mocked(readdir).mockResolvedValue([
      { isDirectory: () => false, isFile: () => true, name: 'browser.toml' },
    ] as never);

    const result = await doctorCommand('/project', { postRebaseAudit: true });

    expect(result.exitCode).toBe(0);
    const successMessages = vi.mocked(success).mock.calls.map(([message]) => message);
    expect(
      successMessages.some((message) => message.includes('Post-rebase registration audit'))
    ).toBe(true);
  });

  it('warns when post-rebase registration audit finds suspicious surfaces', async () => {
    vi.mocked(readText).mockResolvedValue('');

    const result = await doctorCommand('/project', { postRebaseAudit: true });

    expect(result.exitCode).toBe(0);
    const warnMessages = vi.mocked(warn).mock.calls.map(([message]) => message);
    expect(warnMessages.some((message) => message.includes('Post-rebase registration audit'))).toBe(
      true
    );
    expect(warnMessages.some((message) => message.includes('BROWSER_CHROME_URL'))).toBe(true);
  });

  it('reports a clean workspace as fully passing', async () => {
    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('All 15 checks passed!');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces warning-only runs without failing the exit code', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/content/unmanaged.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('14 passed, 1 warning');
    expect(result.exitCode).toBe(0);
  });

  it('reports a patch-backed imported queue as passing with an ownership summary', async () => {
    // Motivating case (eval 2): `fireforge import` on mybrowser applied 126
    // patches. Every dirty row was patch-backed. The old check still
    // warned "126 local changes" and told the operator to export/discard
    // /reset — advice that would have dropped the entire import.
    const patchBackedEntries = Array.from({ length: 126 }).map((_, i) => ({
      status: ' M',
      indexStatus: ' ' as const,
      worktreeStatus: 'M' as const,
      file: `browser/components/patch-backed-${i}.js`,
      isUntracked: false,
      isRenameOrCopy: false,
      isDeleted: false,
    }));
    vi.mocked(getWorkingTreeStatus).mockResolvedValue(patchBackedEntries);
    vi.mocked(classifyFiles).mockResolvedValueOnce(
      patchBackedEntries.map((entry) => ({ ...entry, classification: 'patch-backed' as const }))
    );

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('All 15 checks passed!');
    expect(
      vi.mocked(success).mock.calls.some(([message]) => message.includes('126 tool-managed'))
    ).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('reports patch-owned drift as managed, not unmanaged', async () => {
    const driftEntries = [
      {
        status: ' M',
        indexStatus: ' ' as const,
        worktreeStatus: 'M' as const,
        file: 'browser/components/sessionstore/SessionStore.sys.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ];
    vi.mocked(getWorkingTreeStatus).mockResolvedValue(driftEntries);
    vi.mocked(classifyFiles).mockResolvedValueOnce(
      driftEntries.map((entry) => ({
        ...entry,
        classification: 'patch-owned-drift' as const,
      }))
    );

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('All 15 checks passed!');
    expect(
      vi.mocked(success).mock.calls.some(([message]) => message.includes('1 tool-managed change'))
    ).toBe(true);
    expect(
      vi.mocked(success).mock.calls.some(([message]) => message.includes('patch-owned drift'))
    ).toBe(true);
    expect(
      vi.mocked(warn).mock.calls.some(([message]) => message.includes('unmanaged change'))
    ).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('surfaces cross-patch ownership conflicts via the working-tree row', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'browser/base/jar.mn',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);
    vi.mocked(classifyFiles).mockResolvedValueOnce([
      {
        status: ' M',
        file: 'browser/base/jar.mn',
        classification: 'conflict',
        claimedBy: ['010-ui-a.patch', '011-ui-b.patch'],
      },
    ]);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) => message.includes('cross-patch ownership conflict'))
    ).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('reports branding-only dirty tree as passing with an ownership summary', async () => {
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
    ]);

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('All 15 checks passed!');
    expect(
      vi.mocked(success).mock.calls.some(([message]) => message.includes('tool-managed change'))
    ).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('degrades the summary and exit code for drifted and dirty engine state', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockResolvedValue('moved-head');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'toolkit/content/unmanaged.mjs',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) =>
          message.includes('Engine working tree has 1 unmanaged change')
        )
    ).toBe(true);
    expect(
      vi.mocked(error).mock.calls.some(([message]) => message.includes('Engine state consistency'))
    ).toBe(true);
    expect(outro).toHaveBeenCalledWith('14 passed, 1 warning, 1 failed');
    expect(result.exitCode).toBe(1);
  });

  it('treats a detached HEAD at the recorded base commit as a warning, not a failure', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockResolvedValue('baseline');
    vi.mocked(getCurrentBranch).mockResolvedValue('HEAD');

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) =>
          message.includes('Engine is detached at the recorded base commit')
        )
    ).toBe(true);
    expect(outro).toHaveBeenCalledWith('15 passed, 1 warning');
    expect(result.exitCode).toBe(0);
  });

  it('warns (does not fail) when watchman is absent from PATH', async () => {
    // Eval regression: `fireforge watch` depends on watchman, but prior
    // to this check operators completed setup → download → build without
    // ever seeing that requirement. Now doctor surfaces a warning row so
    // the dependency gap is visible during the normal onboarding sweep.
    // Warning-severity (not failure) because most projects don't run
    // watch and we don't want to fail `doctor` outright for a
    // command-specific dependency.
    //
    // Use `mockImplementationOnce` rather than `mockImplementation` so the
    // override does not leak into sibling tests. `clearAllMocks` in the
    // module beforeEach clears call history but preserves mock
    // implementations, so a permanent override would turn unrelated tests'
    // accounting (warning counts, passed-checks counts) sideways.
    const { findExecutable } = await import('../../utils/process.js');
    vi.mocked(findExecutable).mockImplementationOnce((name: string) =>
      Promise.resolve(name === 'watchman' ? undefined : '/usr/local/bin/' + name)
    );

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) =>
          message.includes('watchman is not installed or not on PATH')
        )
    ).toBe(true);
    // Warning-only: the run still succeeds overall.
    expect(result.exitCode).toBe(0);
  });

  it('surfaces an unborn HEAD as an incomplete download instead of a raw git error', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockRejectedValue(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      )
    );
    vi.mocked(getCurrentBranch).mockResolvedValue('HEAD');

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) =>
          message.includes('Engine repository has no baseline commit yet')
        )
    ).toBe(true);
    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) =>
          message.includes('Skipped branch validation because the baseline commit is missing')
        )
    ).toBe(true);
    expect(
      vi
        .mocked(outro)
        .mock.calls.some(([message]) => typeof message === 'string' && message.includes('1 failed'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when fireforge.json is missing', async () => {
    vi.mocked(configExists).mockResolvedValueOnce(false);
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Config not found'));

    const result = await doctorCommand('/project');

    // Check 3 "fireforge.json exists" should fail
    expect(
      vi
        .mocked(error)
        .mock.calls.some(
          ([message]) => message.includes('fireforge.json') || message.includes('not found')
        )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when engine directory is missing', async () => {
    const originalPathExists = vi.mocked(pathExists).getMockImplementation();
    vi.mocked(pathExists).mockImplementation((p: string) => Promise.resolve(!p.includes('engine')));

    const result = await doctorCommand('/project');

    // Restore original to avoid leaking
    if (originalPathExists) {
      vi.mocked(pathExists).mockImplementation(originalPathExists);
    }

    // The summary should have at least 1 failed check
    expect(result.exitCode).toBe(1);
  });

  it('reports pending resolution state as a failure', async () => {
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: {
        patchFilename: '007-ui.patch',
        originalError: 'patch failed',
      },
    });

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) =>
          message.includes('You are currently resolving a conflict for patch 007-ui.patch.')
        )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('clears pending resolution when the queue health check is clean', async () => {
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: {
        patchFilename: '007-ui.patch',
        originalError: 'patch failed',
      },
      baseCommit: 'base-commit',
    });

    const result = await doctorCommand('/project', { clearResolution: true });

    expect(collectPatchQueueHealth).toHaveBeenCalledWith('/project');
    expect(updateState).toHaveBeenCalledWith('/project', expect.any(Function));
    const updater = vi.mocked(updateState).mock.calls.at(-1)?.[1] as (
      current: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(
      updater({
        pendingResolution: { patchFilename: 'x', originalError: 'y' },
        baseCommit: 'base-commit',
      })
    ).toEqual({ baseCommit: 'base-commit' });
    expect(result.exitCode).toBe(0);
  });

  it('does nothing for --clear-resolution when no pending resolution exists', async () => {
    const result = await doctorCommand('/project', { clearResolution: true });

    expect(collectPatchQueueHealth).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('refuses to clear pending resolution when queue health has errors', async () => {
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: {
        patchFilename: '007-ui.patch',
        originalError: 'patch failed',
      },
    });
    vi.mocked(collectPatchQueueHealth).mockResolvedValue({
      hasPatchesDirectory: true,
      groups: [],
      errorCount: 2,
      warningCount: 0,
    });

    const result = await doctorCommand('/project', { clearResolution: true });

    expect(updateState).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) =>
          message.includes('Refusing to clear pending resolution for 007-ui.patch')
        )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when git is not installed', async () => {
    vi.mocked(ensureGit).mockRejectedValueOnce(new Error('git not found'));

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('git') || message.includes('Git'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('fails early when engine exists but is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValueOnce(false);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('engine/ is not a git repository'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when Python is not found', async () => {
    vi.mocked(ensurePython).mockRejectedValueOnce(new Error('python not found'));

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('Python') || message.includes('python'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports patch integrity issues as failures', async () => {
    vi.mocked(validatePatchIntegrity).mockResolvedValueOnce([
      {
        filename: '001-ui-toolbar.patch',
        message: 'File not in source',
        targetFile: 'browser/toolbar.js',
      },
    ]);

    const result = await doctorCommand('/project');

    // The `runCheck` for Patch integrity throws when issues are found, so it becomes
    // a failed check. The error call format is: "✗ Patch integrity: ..."
    const allErrorMessages = vi.mocked(error).mock.calls.map(([msg]) => msg);
    expect(
      allErrorMessages.some(
        (message) => message.includes('Patch integrity') || message.includes('patch')
      )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports patch manifest consistency issues as failures', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'untracked-patch-file',
        filename: '001-ui-toolbar.patch',
        message: '001-ui-toolbar.patch exists on disk but is not tracked in patches.json.',
      },
    ]);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('Patch manifest consistency'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('can rebuild patches.json during doctor when repair is requested', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file exists.',
      },
    ]);
    vi.mocked(rebuildPatchesManifest).mockResolvedValueOnce({
      manifest: {
        version: 1,
        patches: [
          {
            filename: '001-ui-toolbar.patch',
            order: 1,
            category: 'ui',
            name: 'toolbar',
            description: 'Recovered',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/toolbar.js'],
          },
        ],
      },
      recoveredFilenames: ['001-ui-toolbar.patch'],
    });

    const result = await doctorCommand('/project', { repairPatchesManifest: true });

    expect(rebuildPatchesManifest).toHaveBeenCalledWith('/project/patches', '140.9.0esr');
    expect(result.exitCode).toBe(0);
    expect(
      vi.mocked(warn).mock.calls.some(([message]) => message.includes('Patch manifest consistency'))
    ).toBe(true);
    // 2026-04-21 eval (Finding #17): the repair path now surfaces a
    // per-file review warning naming each filename whose metadata was
    // reconstructed from generic defaults. Operators can't recover the
    // original description, but at least they see exactly which entries
    // need their attention.
    expect(
      vi
        .mocked(warn)
        .mock.calls.some(
          ([message]) =>
            typeof message === 'string' &&
            message.includes('Recovered manifest entry for 001-ui-toolbar.patch') &&
            message.includes('generic description')
        )
    ).toBe(true);
    // 2026-04-24 eval Finding 6: the repair warning used to tell the
    // operator to hand-edit patches.json, which contradicts the README
    // that treats the manifest as FireForge-owned. Assert that the new
    // message points at `re-export` / `export` instead and explicitly
    // warns against hand-editing.
    const repairWarnings = vi
      .mocked(warn)
      .mock.calls.map(([message]) => message)
      .filter((m): m is string => typeof m === 'string');
    const noHandEditHint = repairWarnings.find(
      (m) =>
        m.includes('Recovered manifest entry') &&
        (m.includes('re-export') ||
          m.includes('fireforge re-export') ||
          m.includes('fireforge export'))
    );
    expect(noHandEditHint).toBeDefined();
    expect(
      repairWarnings.some((m) => m.includes('Edit patches.json to restore the original'))
    ).toBe(false);
    expect(
      repairWarnings.some(
        (m) =>
          m.includes('Recovered manifest entry') && m.includes('Avoid hand-editing patches.json')
      )
    ).toBe(true);
  });

  it('reports a failed repair when rebuilding patches.json throws', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file exists.',
      },
    ]);
    vi.mocked(rebuildPatchesManifest).mockRejectedValueOnce(new Error('rebuild failed'));

    const result = await doctorCommand('/project', { repairPatchesManifest: true });

    expect(result.exitCode).toBe(1);
    expect(
      vi.mocked(error).mock.calls.some(([message]) => message.includes('rebuild failed'))
    ).toBe(true);
    expect(
      vi
        .mocked(outro)
        .mock.calls.some(([message]) => typeof message === 'string' && message.includes('1 failed'))
    ).toBe(true);
  });

  it('refuses --repair-patches-manifest when fireforge.json could not be loaded', async () => {
    // If the "fireforge.json is valid" check failed, ctx.config is
    // undefined. An earlier iteration of this code fell back to stamping
    // 'unknown' into every recovered entry's sourceEsrVersion, which is
    // hard to reverse and would silently mislead every later command.
    // The repair branch must refuse instead.
    vi.mocked(loadConfig).mockRejectedValue(new Error('syntax error in fireforge.json'));
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file exists.',
      },
    ]);

    const result = await doctorCommand('/project', { repairPatchesManifest: true });

    // rebuildPatchesManifest must NOT have been called — no 'unknown'
    // string ever reaches manifest metadata on disk.
    expect(rebuildPatchesManifest).not.toHaveBeenCalled();

    // The operator sees a clear explanation pointing at the real cause.
    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('fireforge.json could not be loaded'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('passes the real firefox version to rebuildPatchesManifest when config loads', async () => {
    // Positive counterpart to the guard test above: confirm the happy
    // path still stamps the actual version string from fireforge.json
    // rather than a fallback. If this regresses, the guard either over-
    // or under-fired, and the repair would write the wrong metadata.
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '142.0esr', product: 'firefox-esr' },
    });
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file exists.',
      },
    ]);

    await doctorCommand('/project', { repairPatchesManifest: true });

    expect(rebuildPatchesManifest).toHaveBeenCalledWith('/project/patches', '142.0esr');
    // And critically: NOT called with 'unknown'.
    expect(rebuildPatchesManifest).not.toHaveBeenCalledWith(expect.anything(), 'unknown');
  });

  it('does not add engine state consistency check when baseCommit is missing', async () => {
    // Ensure loadState returns empty (no baseCommit), overriding any prior test leakage
    vi.mocked(loadState).mockResolvedValueOnce({});

    await doctorCommand('/project');

    // Without baseCommit, "Engine state consistency" check is never added. No state-related error.
    expect(
      vi.mocked(error).mock.calls.some(([message]) => message.includes('Engine state consistency'))
    ).toBe(false);
  });

  describe('furnace checks', () => {
    // The three furnace checks skipIf when furnace.json is missing, which
    // is the default in the mock. Each test in this describe block opts
    // into the furnace path by flipping furnaceConfigExists to true.
    beforeEach(() => {
      vi.mocked(checkFurnaceConfigExists).mockResolvedValue(true);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'override card',
            basePath: 'toolkit/content/widgets/moz-card',
            baseVersion: '145.0',
          },
        },
        custom: {},
      });
      vi.mocked(loadFurnaceState).mockResolvedValue({});
      vi.mocked(hasOverrideEngineDrift).mockResolvedValue(false);
      vi.mocked(hasCustomEngineDrift).mockResolvedValue(false);
      vi.mocked(applyAllComponents).mockResolvedValue({
        applied: [],
        skipped: [],
        errors: [],
      });
    });

    it('reports all furnace checks as passing on a clean project', async () => {
      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(0);
      const successMessages = vi.mocked(success).mock.calls.map(([msg]) => msg);
      expect(successMessages.some((m) => m.includes('Furnace configuration'))).toBe(true);
      expect(successMessages.some((m) => m.includes('Furnace state consistency'))).toBe(true);
      expect(successMessages.some((m) => m.includes('Furnace engine paths'))).toBe(true);
      expect(successMessages.some((m) => m.includes('Furnace engine state'))).toBe(true);
    });

    it('"Furnace engine paths" scans tokenHostDocuments instead of browser.xhtml when configured', async () => {
      // Simulate a fork that replaced browser.xhtml with a custom chrome doc.
      // pathExists returns false for browser.xhtml (it was deleted by the
      // fork) and true for the configured host document; the check should
      // then pass without warning about the missing browser.xhtml.
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'override card',
            basePath: 'toolkit/content/widgets/moz-card',
            baseVersion: '145.0',
          },
        },
        custom: {},
        tokenHostDocuments: ['browser/base/content/mybrowser-shell.xhtml'],
      });
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p.endsWith('browser/base/content/browser.xhtml')) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(0);
      const warnMessages = vi.mocked(warn).mock.calls.map(([m]) => m);
      expect(warnMessages.some((m) => m.includes('Furnace engine paths'))).toBe(false);
      const successMessages = vi.mocked(success).mock.calls.map(([msg]) => msg);
      expect(successMessages.some((m) => m.includes('Furnace engine paths'))).toBe(true);
    });

    it('"Furnace engine paths" warns about the configured host document when it is missing', async () => {
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'override card',
            basePath: 'toolkit/content/widgets/moz-card',
            baseVersion: '145.0',
          },
        },
        custom: {},
        tokenHostDocuments: ['browser/base/content/mybrowser-shell.xhtml'],
      });
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p.endsWith('mybrowser-shell.xhtml')) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(0);
      const warnMessages = vi.mocked(warn).mock.calls.map(([m]) => m);
      expect(
        warnMessages.some(
          (m) => m.includes('Furnace engine paths') && m.includes('mybrowser-shell.xhtml')
        )
      ).toBe(true);
    });

    it('"Furnace engine paths" falls back to browser.xhtml when tokenHostDocuments is not set', async () => {
      // No tokenHostDocuments in the config — old default applies.
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p.endsWith('browser/base/content/browser.xhtml')) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(0);
      const warnMessages = vi.mocked(warn).mock.calls.map(([m]) => m);
      expect(
        warnMessages.some(
          (m) =>
            m.includes('Furnace engine paths') && m.includes('browser/base/content/browser.xhtml')
        )
      ).toBe(true);
    });

    it('fails "Furnace configuration" when furnace.json is invalid', async () => {
      vi.mocked(loadFurnaceConfig).mockRejectedValueOnce(
        new Error('Furnace config: "version" must be 1')
      );

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(1);
      expect(
        vi.mocked(error).mock.calls.some(([message]) => message.includes('furnace.json is invalid'))
      ).toBe(true);
      // Downstream checks skip when the config could not be loaded: no
      // cascading "Furnace engine state" failure on top of the config error.
      expect(
        vi.mocked(error).mock.calls.some(([message]) => message.includes('Furnace engine state'))
      ).toBe(false);
    });

    it('warns about stale furnace-state.json entries without --repair-furnace', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        appliedChecksums: {
          'override/moz-card/moz-card.css': 'abc',
          'override/moz-ghost/moz-ghost.css': 'def',
          'custom/moz-phantom/moz-phantom.mjs': 'ghi',
        },
      });

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(0);
      const warnMessages = vi.mocked(warn).mock.calls.map(([msg]) => msg);
      expect(
        warnMessages.some(
          (m) =>
            m.includes('Furnace state consistency') &&
            m.includes('moz-ghost') &&
            m.includes('moz-phantom')
        )
      ).toBe(true);
      // Without --repair-furnace, updateFurnaceState must NOT be called —
      // the read-only doctor run has to stay side-effect-free.
      expect(updateFurnaceState).not.toHaveBeenCalled();
    });

    it('clears stale furnace-state.json entries with --repair-furnace', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        appliedChecksums: {
          'override/moz-card/moz-card.css': 'abc',
          'override/moz-ghost/moz-ghost.css': 'def',
        },
      });

      await doctorCommand('/project', { repairFurnace: true });

      expect(updateFurnaceState).toHaveBeenCalledWith('/project', expect.any(Function));
      const updater = vi.mocked(updateFurnaceState).mock.calls.at(-1)?.[1];
      if (typeof updater !== 'function') throw new Error('expected updater function');
      const result = updater({
        appliedChecksums: {
          'override/moz-card/moz-card.css': 'abc',
          'override/moz-ghost/moz-ghost.css': 'def',
        },
      });
      // The in-config moz-card entry survives; the ghost is dropped.
      expect(result.appliedChecksums).toEqual({
        'override/moz-card/moz-card.css': 'abc',
      });
    });

    it('reports "Furnace lock" as passing when no lock directory is present', async () => {
      // Default `pathExists` mock returns true for every probe (see top of
      // file). Override it for the furnace-lock path so the check takes the
      // ok branch — this matches the steady-state scenario where no furnace
      // command is in flight.
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p.endsWith('furnace.lock')) return Promise.resolve(false);
        return Promise.resolve(true);
      });
      const result = await doctorCommand('/project');
      expect(result.exitCode).toBe(0);
      const successMessages = vi.mocked(success).mock.calls.map(([m]) => m);
      expect(successMessages.some((m) => m.includes('Furnace lock'))).toBe(true);
    });

    it('fails "Furnace engine state" when drift is detected', async () => {
      vi.mocked(hasOverrideEngineDrift).mockResolvedValue(true);

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(1);
      expect(
        vi
          .mocked(error)
          .mock.calls.some(
            ([message]) => message.includes('Furnace engine state') && message.includes('moz-card')
          )
      ).toBe(true);
    });

    it('fails "Furnace engine state" when a pendingRepair marker is set', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        pendingRepair: {
          operation: 'preview-teardown',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'cleanStories failed with EACCES',
        },
      });

      const result = await doctorCommand('/project');

      expect(result.exitCode).toBe(1);
      expect(
        vi
          .mocked(error)
          .mock.calls.some(
            ([message]) =>
              message.includes('Furnace engine state') && message.includes('preview-teardown')
          )
      ).toBe(true);
    });

    it('repairs engine drift with --repair-furnace by running apply and clearing the pendingRepair marker', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        pendingRepair: {
          operation: 'preview-teardown',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'cleanStories failed',
        },
      });
      vi.mocked(hasOverrideEngineDrift).mockResolvedValue(true);
      vi.mocked(applyAllComponents).mockResolvedValue({
        applied: [{ name: 'moz-card', type: 'override', filesAffected: ['moz-card.css'] }],
        skipped: [],
        errors: [],
      });

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(runFurnaceMutation).toHaveBeenCalledWith(
        '/project',
        'apply-rollback',
        expect.any(Function),
        { skipPendingRepairCheck: true }
      );
      expect(vi.mocked(applyAllComponents).mock.calls.at(-1)?.[0]).toBe('/project');
      expect(vi.mocked(applyAllComponents).mock.calls.at(-1)?.[1]).toBe(false);
      const options: unknown = vi.mocked(applyAllComponents).mock.calls.at(-1)?.[2];
      expect(options).toBeDefined();
      if (!options || typeof options !== 'object' || !('operationContext' in options)) {
        throw new Error('expected apply options with operationContext');
      }
      const operationContext = (
        options as {
          operationContext: {
            registerJournal: unknown;
            registerCleanup: unknown;
          };
        }
      ).operationContext;
      expect(typeof operationContext.registerJournal).toBe('function');
      expect(typeof operationContext.registerCleanup).toBe('function');
      // The pendingRepair marker is cleared by a rewrite, not a merge.
      // Our implementation calls updateFurnaceState with a function; the
      // returned state must not contain pendingRepair.
      expect(updateFurnaceState).toHaveBeenCalled();
      const updater = vi.mocked(updateFurnaceState).mock.calls.at(-1)?.[1];
      if (typeof updater !== 'function') throw new Error('expected updater function');
      const next = updater({
        pendingRepair: {
          operation: 'preview-teardown',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'cleanStories failed',
        },
        appliedChecksums: { 'override/moz-card/moz-card.css': 'abc' },
      });
      expect(next.pendingRepair).toBeUndefined();
      expect(next.appliedChecksums).toEqual({ 'override/moz-card/moz-card.css': 'abc' });
      // Repair is reported as a warning (not a silent pass) so operators
      // still notice that a reconciliation happened.
      expect(result.exitCode).toBe(0);
      expect(
        vi.mocked(warn).mock.calls.some(([message]) => message.includes('Furnace engine state'))
      ).toBe(true);
    });

    it('leaves the pendingRepair marker in place when repair apply fails', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        pendingRepair: {
          operation: 'preview-teardown',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'cleanStories failed',
        },
      });
      vi.mocked(hasOverrideEngineDrift).mockResolvedValue(true);
      vi.mocked(applyAllComponents).mockResolvedValue({
        applied: [],
        skipped: [],
        errors: [{ name: 'moz-card', error: 'ENOENT: engine file missing' }],
      });

      const result = await doctorCommand('/project', { repairFurnace: true });

      // applyAllComponents reported a failure; the pendingRepair marker
      // must stay set so the next doctor run re-flags the issue. The
      // clearing updateFurnaceState call must NOT happen.
      expect(runFurnaceMutation).toHaveBeenCalledWith(
        '/project',
        'apply-rollback',
        expect.any(Function),
        { skipPendingRepairCheck: true }
      );
      expect(vi.mocked(applyAllComponents).mock.calls.at(-1)?.[0]).toBe('/project');
      expect(vi.mocked(applyAllComponents).mock.calls.at(-1)?.[1]).toBe(false);
      const options: unknown = vi.mocked(applyAllComponents).mock.calls.at(-1)?.[2];
      expect(options).toBeDefined();
      if (!options || typeof options !== 'object' || !('operationContext' in options)) {
        throw new Error('expected apply options with operationContext');
      }
      const operationContext = (
        options as {
          operationContext: {
            registerJournal: unknown;
            registerCleanup: unknown;
          };
        }
      ).operationContext;
      expect(typeof operationContext.registerJournal).toBe('function');
      expect(typeof operationContext.registerCleanup).toBe('function');
      expect(updateFurnaceState).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(1);
      expect(
        vi
          .mocked(error)
          .mock.calls.some(
            ([message]) =>
              message.includes('Furnace engine state') && message.includes('Repair attempted')
          )
      ).toBe(true);
    });

    it('treats create rollback markers as authoring repairs, not generic apply rollback', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        pendingRepair: {
          operation: 'create-rollback',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'rollback failed while restoring furnace.json',
        },
      });
      vi.mocked(validateAllComponents).mockResolvedValue(new Map());

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(validateAllComponents).toHaveBeenCalledWith('/project');
      expect(runFurnaceMutation).not.toHaveBeenCalled();
      expect(applyAllComponents).not.toHaveBeenCalled();
      expect(updateFurnaceState).toHaveBeenCalled();
      const updater = vi.mocked(updateFurnaceState).mock.calls.at(-1)?.[1];
      if (typeof updater !== 'function') throw new Error('expected updater function');
      const next = updater({
        pendingRepair: {
          operation: 'create-rollback',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'rollback failed while restoring furnace.json',
        },
      });
      expect(next.pendingRepair).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(
        vi
          .mocked(warn)
          .mock.calls.some(
            ([message]) =>
              message.includes('Furnace engine state') && message.includes('create-rollback')
          )
      ).toBe(true);
    });

    it('surfaces orphaned override directories not listed in furnace.json', async () => {
      // Eval 2: a concurrent-override race left components/overrides/<name>
      // on disk but dropped its furnace.json entry. `doctor` now lists the
      // orphan so the operator sees it before the next apply fails.
      vi.mocked(checkFurnaceConfigExists).mockResolvedValue(true);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      });
      vi.mocked(readdir).mockImplementation(((
        path: string
      ): Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>> => {
        if (typeof path === 'string' && path.endsWith('overrides')) {
          return Promise.resolve([
            {
              name: 'moz-button',
              isDirectory: () => true,
              isFile: () => false,
            },
          ]);
        }
        return Promise.resolve([]);
      }) as unknown as typeof readdir);

      const result = await doctorCommand('/project');

      expect(
        vi
          .mocked(warn)
          .mock.calls.some(
            ([message]) =>
              message.includes('Furnace manifest sync') && message.includes('moz-button')
          )
      ).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('repairs orphan overrides from their override.json sidecars', async () => {
      vi.mocked(checkFurnaceConfigExists).mockResolvedValue(true);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      });
      vi.mocked(readdir).mockImplementation(((
        path: string
      ): Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>> => {
        if (typeof path === 'string' && path.endsWith('overrides')) {
          return Promise.resolve([
            {
              name: 'moz-button',
              isDirectory: () => true,
              isFile: () => false,
            },
          ]);
        }
        return Promise.resolve([]);
      }) as unknown as typeof readdir);
      vi.mocked(readJson).mockImplementation((path: string): Promise<unknown> => {
        if (typeof path === 'string' && path.endsWith('moz-button/override.json')) {
          return Promise.resolve({
            type: 'css-only',
            description: 'Recovered',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '145.0',
          });
        }
        return Promise.reject(new Error('not found'));
      });

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(vi.mocked(writeFurnaceConfig)).toHaveBeenCalled();
      const writeCall = vi.mocked(writeFurnaceConfig).mock.calls[0];
      expect(writeCall?.[0]).toBe('/project');
      const written = writeCall?.[1] as
        { overrides?: Record<string, { type?: string; description?: string }> } | undefined;
      expect(written?.overrides?.['moz-button']?.type).toBe('css-only');
      expect(written?.overrides?.['moz-button']?.description).toBe('Recovered');
      expect(result.exitCode).toBe(0);
    });

    it('deletes empty custom orphan directories during furnace repair', async () => {
      vi.mocked(checkFurnaceConfigExists).mockResolvedValue(true);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      });
      vi.mocked(readdir).mockImplementation(((
        path: string
      ): Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>> => {
        if (typeof path === 'string' && path.endsWith('components/custom')) {
          return Promise.resolve([
            {
              name: 'moz-empty',
              isDirectory: () => true,
              isFile: () => false,
            },
          ]);
        }
        if (typeof path === 'string' && path.endsWith('components/custom/moz-empty')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }) as unknown as typeof readdir);

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(rm).toHaveBeenCalledWith('/project/components/custom/moz-empty');
      expect(
        vi
          .mocked(warn)
          .mock.calls.some(([message]) =>
            message.includes('Deleted 1 empty custom orphan directory (moz-empty)')
          )
      ).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('keeps non-empty custom orphan directories for manual follow-up', async () => {
      vi.mocked(checkFurnaceConfigExists).mockResolvedValue(true);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      });
      vi.mocked(readdir).mockImplementation(((
        path: string
      ): Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>> => {
        if (typeof path === 'string' && path.endsWith('components/custom')) {
          return Promise.resolve([
            {
              name: 'moz-lived-in',
              isDirectory: () => true,
              isFile: () => false,
            },
          ]);
        }
        if (typeof path === 'string' && path.endsWith('components/custom/moz-lived-in')) {
          return Promise.resolve([
            {
              name: 'moz-lived-in.mjs',
              isDirectory: () => false,
              isFile: () => true,
            },
          ]);
        }
        return Promise.resolve([]);
      }) as unknown as typeof readdir);

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(rm).not.toHaveBeenCalledWith('/project/components/custom/moz-lived-in');
      expect(
        vi
          .mocked(warn)
          .mock.calls.some(
            ([message]) =>
              message.includes('non-empty custom orphan directory requires manual action') &&
              message.includes('moz-lived-in')
          )
      ).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('reports mixed override recovery and custom orphan cleanup together', async () => {
      vi.mocked(checkFurnaceConfigExists).mockResolvedValue(true);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      });
      vi.mocked(readdir).mockImplementation(((
        path: string
      ): Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>> => {
        if (typeof path === 'string' && path.endsWith('overrides')) {
          return Promise.resolve([
            {
              name: 'moz-button',
              isDirectory: () => true,
              isFile: () => false,
            },
          ]);
        }
        if (typeof path === 'string' && path.endsWith('components/custom')) {
          return Promise.resolve([
            {
              name: 'moz-empty',
              isDirectory: () => true,
              isFile: () => false,
            },
          ]);
        }
        if (typeof path === 'string' && path.endsWith('components/custom/moz-empty')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }) as unknown as typeof readdir);
      vi.mocked(readJson).mockImplementation((path: string): Promise<unknown> => {
        if (typeof path === 'string' && path.endsWith('moz-button/override.json')) {
          return Promise.resolve({
            type: 'css-only',
            description: 'Recovered',
            basePath: 'toolkit/content/widgets/moz-button',
            baseVersion: '145.0',
          });
        }
        return Promise.reject(new Error('not found'));
      });

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(writeFurnaceConfig).toHaveBeenCalled();
      expect(rm).toHaveBeenCalledWith('/project/components/custom/moz-empty');
      expect(
        vi
          .mocked(warn)
          .mock.calls.some(
            ([message]) =>
              message.includes('Re-registered 1 override') &&
              message.includes('Deleted 1 empty custom orphan directory')
          )
      ).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('refuses to clear authoring rollback markers while validation errors remain', async () => {
      vi.mocked(loadFurnaceState).mockResolvedValue({
        pendingRepair: {
          operation: 'override-rollback',
          timestamp: '2026-04-11T12:00:00.000Z',
          reason: 'rollback failed while restoring override files',
        },
      });
      vi.mocked(validateAllComponents).mockResolvedValue(
        new Map([
          [
            'moz-card',
            [
              {
                component: 'moz-card',
                severity: 'error',
                check: 'missing-component-dir',
                message: 'Component directory not found: components/overrides/moz-card',
              },
            ],
          ],
        ])
      );

      const result = await doctorCommand('/project', { repairFurnace: true });

      expect(validateAllComponents).toHaveBeenCalledWith('/project');
      expect(runFurnaceMutation).not.toHaveBeenCalled();
      expect(applyAllComponents).not.toHaveBeenCalled();
      expect(updateFurnaceState).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(1);
      expect(
        vi
          .mocked(error)
          .mock.calls.some(
            ([message]) =>
              message.includes('Furnace engine state') && message.includes('override-rollback')
          )
      ).toBe(true);
    });
  });

  it('pluralizes warning summaries when multiple warning checks are present', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockResolvedValue('baseline');
    vi.mocked(getCurrentBranch).mockResolvedValue('HEAD');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'browser/components/file.js',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('14 passed, 2 warnings');
    expect(result.exitCode).toBe(0);
  });
});

describe('registerDoctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    vi.mocked(loadState).mockResolvedValue({});
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(getCurrentBranch).mockResolvedValue('firefox');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([]);
    vi.mocked(validatePatchIntegrity).mockResolvedValue([]);
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValue([]);
    vi.mocked(rebuildPatchesManifest).mockResolvedValue({
      manifest: { version: 1, patches: [] },
      recoveredFilenames: [],
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(checkFurnaceConfigExists).mockResolvedValue(false);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({});
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(false);
    vi.mocked(hasCustomEngineDrift).mockResolvedValue(false);
    vi.mocked(applyAllComponents).mockResolvedValue({
      applied: [],
      skipped: [],
      errors: [],
    });
  });

  it('routes parsed CLI options through the registered action', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValue([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'manifest drift',
      },
    ]);

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'doctor', '--repair-patches-manifest']);

    expect(rebuildPatchesManifest).toHaveBeenCalledWith('/project/patches', '140.9.0esr');
    expect(process.exitCode).toBeUndefined();
  });

  it('sets process.exitCode when the registered action reports a failure', async () => {
    vi.mocked(configExists).mockResolvedValue(false);

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'doctor']);

    expect(process.exitCode).toBe(1);
  });
});

/**
 * Pins the exact order of the declarative doctor check registry.
 *
 * The order matters for reasons beyond presentation: later checks read
 * state that earlier checks populate via the shared DoctorCheckContext.
 * In particular, "fireforge.json is valid" writes `ctx.config`, and
 * "Patch manifest consistency" reads `ctx.config?.firefox.version` to
 * stamp a rebuilt manifest during a repair run. Silently swapping those
 * two would still produce a passing suite on a fresh clone (the repair
 * path is rarely exercised), which is exactly the kind of bug this test
 * is meant to catch. If you legitimately need to reorder, update this
 * list and the dependency comment on DOCTOR_CHECKS at the same time.
 */
describe('DOCTOR_CHECK_ORDER', () => {
  it('matches the expected declarative order', () => {
    expect(DOCTOR_CHECK_ORDER).toEqual([
      'Git installed',
      'Python supported by mach',
      'fireforge.json exists',
      'fireforge.json is valid',
      'Engine directory exists',
      'Pending Resolution',
      'Engine is git repository',
      'mach available',
      'Watchman available',
      'Patches directory exists',
      'Patches found',
      'Patch manifest consistency',
      'Patch integrity',
      'Post-rebase registration audit',
      'Furnace configuration',
      'Furnace state consistency',
      'Furnace jar.mn registrations',
      'Furnace engine paths',
      'Furnace Storybook backend',
      'Furnace lock',
      'Furnace engine state',
      'Furnace component validation',
      'Furnace manifest sync',
      'Configs directory exists',
    ]);
  });

  it('runs "fireforge.json is valid" before any consumer of ctx.config', () => {
    // Context-populating checks must come before the checks that read
    // from them. `ctx.config` is set by "fireforge.json is valid" and
    // read by "Patch manifest consistency" during a repair run.
    const configProducer = DOCTOR_CHECK_ORDER.indexOf('fireforge.json is valid');
    const manifestConsumer = DOCTOR_CHECK_ORDER.indexOf('Patch manifest consistency');
    expect(configProducer).toBeGreaterThanOrEqual(0);
    expect(manifestConsumer).toBeGreaterThan(configProducer);
  });

  it('has no duplicate check names (each name is pinned in the exact-order assertion)', () => {
    const seen = new Set<string>();
    for (const name of DOCTOR_CHECK_ORDER) {
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
  });
});

describe('validateCheckDependencies', () => {
  const stubCheck = (name: string, dependsOn?: string[]): DoctorCheckDefinition =>
    ({
      name,
      section: 'Dependencies',
      run: () => Promise.resolve([]),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
    }) as DoctorCheckDefinition;

  it('accepts a valid forward-only dependency chain', () => {
    const checks: DoctorCheckDefinition[] = [
      stubCheck('a'),
      stubCheck('b', ['a']),
      stubCheck('c', ['a', 'b']),
    ];
    expect(() => {
      validateCheckDependencies(checks);
    }).not.toThrow();
  });

  it('rejects a check that references a dependency that does not exist', () => {
    const checks: DoctorCheckDefinition[] = [stubCheck('a'), stubCheck('b', ['missing'])];
    expect(() => {
      validateCheckDependencies(checks);
    }).toThrow(/does not appear earlier/);
  });

  it('rejects a check that references a later dependency (forward ordering)', () => {
    const checks: DoctorCheckDefinition[] = [stubCheck('a', ['b']), stubCheck('b')];
    expect(() => {
      validateCheckDependencies(checks);
    }).toThrow(/does not appear earlier/);
  });

  it('rejects a self-referential dependency', () => {
    const checks: DoctorCheckDefinition[] = [stubCheck('a', ['a'])];
    expect(() => {
      validateCheckDependencies(checks);
    }).toThrow(/does not appear earlier/);
  });
});
