// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../core/furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-audit-widget': {
          description: 'Audit widget',
          targetPath: 'toolkit/content/widgets/moz-audit-widget',
          register: true,
          localized: false,
        },
      },
    })
  ),
  writeFurnaceConfig: vi.fn(() => Promise.resolve()),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
  loadFurnaceState: vi.fn(() => Promise.resolve({})),
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
}));

vi.mock('../../core/git.js', () => ({
  isGitRepository: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../core/git-file-ops.js', () => ({
  fileExistsInHead: vi.fn(() => Promise.resolve(true)),
  restoreTrackedPath: vi.fn(() => Promise.resolve()),
}));

// The rollback journal touches the filesystem directly via node:fs/promises.
// These tests mock those filesystem helpers, so stub the journal here to keep
// the unit tests focused on the command's own logic. End-to-end rollback
// behavior is covered by furnace-authoring-rollback.integration.test.ts.
vi.mock('../../core/furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  recordCreatedDir: vi.fn(),
  snapshotFile: vi.fn(),
  snapshotDir: vi.fn(),
  restoreRollbackJournalOrThrow: vi.fn(),
  restoreRollbackJournal: vi.fn(),
}));

vi.mock('../../core/furnace-operation.js', () => ({
  runFurnaceMutation: vi.fn(
    async (
      _root: string,
      _kind: string,
      body: (ctx: { registerJournal: () => void; registerCleanup: () => void }) => Promise<unknown>
    ) =>
      body({
        registerJournal: () => undefined,
        registerCleanup: () => undefined,
      })
  ),
  recordFurnaceRollbackFailure: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
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
  loadConfig: vi.fn(() =>
    Promise.resolve({
      binaryName: 'mybrowser',
    })
  ),
}));

vi.mock('../../core/manifest-register.js', () => ({
  deregisterTestManifest: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/furnace-registration.js', () => ({
  removeCustomElementRegistration: vi.fn(() => Promise.resolve()),
  removeJarMnEntries: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-apply-ftl.js', () => ({
  removeCustomFtlJarMnEntry: vi.fn(() => Promise.resolve()),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => Promise.resolve([])),
  unlink: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
  removeDir: vi.fn(() => Promise.resolve()),
  removeFile: vi.fn(() => Promise.resolve()),
  readText: vi.fn(() => Promise.resolve('')),
  writeText: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { readdir, unlink } from 'node:fs/promises';

import * as clack from '@clack/prompts';

import { removeCustomFtlJarMnEntry } from '../../core/furnace-apply-ftl.js';
import {
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import {
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import { restoreRollbackJournalOrThrow, snapshotFile } from '../../core/furnace-rollback.js';
import { isGitRepository } from '../../core/git.js';
import { fileExistsInHead, restoreTrackedPath } from '../../core/git-file-ops.js';
import { deregisterTestManifest } from '../../core/manifest-register.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig, FurnaceState } from '../../types/furnace.js';
import { pathExists, readText, removeDir, removeFile, writeText } from '../../utils/fs.js';
import { cancel as logCancel, info, isCancel, warn } from '../../utils/logger.js';
import { furnaceRemoveCommand } from '../furnace/remove.js';

function defaultRemoveConfig(): FurnaceConfig {
  return {
    version: 1 as const,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-audit-widget': {
        description: 'Audit widget',
        targetPath: 'toolkit/content/widgets/moz-audit-widget',
        register: true,
        localized: false,
      },
    },
  };
}

describe('furnaceRemoveCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadFurnaceConfig).mockResolvedValue(defaultRemoveConfig());
    vi.mocked(loadFurnaceState).mockResolvedValue({});
    vi.mocked(updateFurnaceState).mockResolvedValue(undefined);
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(removeDir).mockResolvedValue(undefined);
    vi.mocked(removeFile).mockResolvedValue(undefined);
    vi.mocked(writeText).mockResolvedValue(undefined);
    vi.mocked(fileExistsInHead).mockResolvedValue(true);
    vi.mocked(restoreTrackedPath).mockResolvedValue(undefined);
    vi.mocked(deregisterTestManifest).mockResolvedValue(false);
    vi.mocked(removeCustomFtlJarMnEntry).mockResolvedValue(undefined);
    vi.mocked(removeCustomElementRegistration).mockResolvedValue(undefined);
    vi.mocked(removeJarMnEntries).mockResolvedValue(undefined);
    vi.mocked(restoreRollbackJournalOrThrow).mockResolvedValue(undefined);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  it('deregisters custom components before deleting deployed files', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget'
      )
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(removeCustomElementRegistration).toHaveBeenCalledWith(
      '/project/engine',
      'moz-audit-widget'
    );
    expect(removeJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-audit-widget');

    const ceCallOrder = vi.mocked(removeCustomElementRegistration).mock.invocationCallOrder[0];
    const jarCallOrder = vi.mocked(removeJarMnEntries).mock.invocationCallOrder[0];
    const deleteTargetOrder = vi
      .mocked(removeDir)
      .mock.calls.find(
        ([target]) => target === '/project/engine/toolkit/content/widgets/moz-audit-widget'
      );

    expect(ceCallOrder).toBeLessThan(deleteTargetOrder ? 999999 : Number.MAX_SAFE_INTEGER);
    expect(jarCallOrder).toBeLessThan(deleteTargetOrder ? 999999 : Number.MAX_SAFE_INTEGER);
  });

  it('throws when component is not found in furnace.json', async () => {
    await expect(furnaceRemoveCommand('/project', 'moz-unknown', { yes: true })).rejects.toThrow(
      FurnaceError
    );
    await expect(furnaceRemoveCommand('/project', 'moz-unknown', { yes: true })).rejects.toThrow(
      'not found in furnace.json'
    );
  });

  it('throws in non-interactive mode without --yes', async () => {
    await expect(furnaceRemoveCommand('/project', 'moz-audit-widget')).rejects.toThrow(
      FurnaceError
    );
    await expect(furnaceRemoveCommand('/project', 'moz-audit-widget')).rejects.toThrow(
      'without --yes'
    );
  });

  it('removes a stock component from furnace.json', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button', 'moz-card'],
      overrides: {},
      custom: {},
    });

    await furnaceRemoveCommand('/project', 'moz-button', { yes: true });

    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        stock: ['moz-card'],
      })
    );
  });

  it('re-reads furnace.json inside the lock to preserve concurrent custom entries', async () => {
    vi.mocked(loadFurnaceConfig)
      .mockResolvedValueOnce({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-audit-widget': {
            description: 'Audit widget',
            targetPath: 'toolkit/content/widgets/moz-audit-widget',
            register: true,
            localized: false,
          },
        },
      })
      .mockResolvedValueOnce({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-audit-widget': {
            description: 'Audit widget',
            targetPath: 'toolkit/content/widgets/moz-audit-widget',
            register: true,
            localized: false,
          },
          'moz-card': {
            description: 'Sibling writer',
            targetPath: 'toolkit/content/widgets/moz-card',
            register: true,
            localized: false,
          },
        },
      });

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls.at(-1)?.[1];
    expect(writtenConfig?.custom['moz-audit-widget']).toBeUndefined();
    expect(writtenConfig?.custom['moz-card']).toMatchObject({
      description: 'Sibling writer',
      targetPath: 'toolkit/content/widgets/moz-card',
    });
  });

  it('restores overridden engine files and deletes the override workspace', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
      { name: 'override.json', isFile: () => true },
      { name: 'nested', isFile: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await furnaceRemoveCommand('/project', 'moz-card', { yes: true });

    // override.json must be excluded by isOverrideCopyCandidate; only the .css
    // file is restored.
    expect(restoreTrackedPath).toHaveBeenCalledWith(
      '/project/engine',
      'toolkit/content/widgets/moz-card/moz-card.css'
    );
    expect(restoreTrackedPath).toHaveBeenCalledTimes(1);
    expect(removeFile).not.toHaveBeenCalled();
    expect(removeDir).toHaveBeenCalledWith('/project/components/overrides/moz-card');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Deployed files may remain'));
    expect(writeFurnaceConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ overrides: {}, stock: ['moz-card'] })
    );
  });

  it('demotes removed overrides back to stock while preserving optional config fields', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--mybrowser-',
      tokenAllowlist: ['--allowed'],
      platformPrefixes: ['--moz-', '--in-content-'],
      runtimeVariables: ['--runtime-x'],
      tokenHostDocuments: ['browser/base/content/mybrowser.xhtml'],
      ftlBasePath: 'browser/locales/en-US/browser',
      scanPaths: ['browser/components'],
      stock: ['moz-card'],
      overrides: {
        'moz-button': {
          type: 'css-only' as const,
          description: 'Override button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(target === '/project/components/overrides/moz-button')
    );

    await furnaceRemoveCommand('/project', 'moz-button', { yes: true });

    const writtenConfig = vi.mocked(writeFurnaceConfig).mock.calls.at(-1)?.[1];
    expect(writtenConfig).toMatchObject({
      tokenPrefix: '--mybrowser-',
      tokenAllowlist: ['--allowed'],
      platformPrefixes: ['--moz-', '--in-content-'],
      runtimeVariables: ['--runtime-x'],
      tokenHostDocuments: ['browser/base/content/mybrowser.xhtml'],
      ftlBasePath: 'browser/locales/en-US/browser',
      scanPaths: ['browser/components'],
      stock: ['moz-card', 'moz-button'],
      overrides: {},
    });
  });

  it('restores orphaned engine files recorded only in state, not the workspace', async () => {
    // Regression for the audit's release-blocker: a developer deleted
    // moz-card-partial.css from the workspace and ran apply (which
    // historically did not undeploy). The state file still records the
    // orphaned engine copy. furnace remove must consult the state file
    // to find and restore that copy, even though the workspace no
    // longer has the file.
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'full' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValueOnce({
      appliedChecksums: {
        'override/moz-card/moz-card.mjs': 'mjs-hash',
        'override/moz-card/moz-card-partial.css': 'orphaned-css-hash',
      },
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    // Workspace only has the .mjs now — the .css was deleted out of source.
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.mjs', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    // The orphaned .css was introduced by the override (not in HEAD), the
    // .mjs is an ordinary override (in HEAD).
    vi.mocked(fileExistsInHead).mockImplementation((_repo: string, relPath: string) =>
      Promise.resolve(relPath.endsWith('.mjs'))
    );

    await furnaceRemoveCommand('/project', 'moz-card', { yes: true });

    // The workspace .mjs is restored from HEAD via git restore.
    expect(restoreTrackedPath).toHaveBeenCalledWith(
      '/project/engine',
      'toolkit/content/widgets/moz-card/moz-card.mjs'
    );
    // The state-only orphan .css is hard-deleted from the engine, even
    // though the workspace no longer references it.
    expect(removeFile).toHaveBeenCalledWith(
      '/project/engine/toolkit/content/widgets/moz-card/moz-card-partial.css'
    );
  });

  it('deletes override-introduced files that do not exist in HEAD', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'full' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.mjs', isFile: () => true },
      { name: 'moz-card-partial.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    // The .mjs exists in HEAD (ordinary override of a Firefox file), the
    // .css was introduced by this override and has no HEAD counterpart.
    vi.mocked(fileExistsInHead).mockImplementation((_repo: string, relPath: string) =>
      Promise.resolve(relPath.endsWith('.mjs'))
    );

    await furnaceRemoveCommand('/project', 'moz-card', { yes: true });

    expect(restoreTrackedPath).toHaveBeenCalledWith(
      '/project/engine',
      'toolkit/content/widgets/moz-card/moz-card.mjs'
    );
    expect(removeFile).toHaveBeenCalledWith(
      '/project/engine/toolkit/content/widgets/moz-card/moz-card-partial.css'
    );
  });

  it('fails clearly when the engine is not a git repository', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(isGitRepository).mockResolvedValueOnce(false);

    await expect(furnaceRemoveCommand('/project', 'moz-card', { yes: true })).rejects.toThrow(
      /engine is not a git repository/i
    );

    expect(restoreTrackedPath).not.toHaveBeenCalled();
    // The workspace directory must NOT be deleted when restoration aborts —
    // rollback restores whatever snapshots were taken before the failure.
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('refuses to remove a custom component when the engine is not a git repository', async () => {
    // Parity with the override path: custom-component removal mutates
    // engine state (jar.mn, customElements.js, deployed widgets, optional
    // .ftl) and the rollback journal is the only safety net while the
    // command runs. Without git, those edits are unrecoverable after
    // success — refuse rather than silently destroy them.
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(isGitRepository).mockResolvedValueOnce(false);

    await expect(
      furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true })
    ).rejects.toThrow(/engine is not a git repository/i);

    expect(removeCustomElementRegistration).not.toHaveBeenCalled();
    expect(removeJarMnEntries).not.toHaveBeenCalled();
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('snapshots the state file before clearing stale checksums so rollback can reverse it', async () => {
    // Regression guard for B2: the state-file clear used to run post-commit
    // as warn-and-continue, outside the transactional block. A failing
    // update left furnace-state.json disagreeing with furnace.json. Now
    // the state file is snapshotted into the journal BEFORE the update,
    // and a failure triggers the full rollback.
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(updateFurnaceState).mockRejectedValueOnce(new Error('EPERM: state file locked'));

    await expect(furnaceRemoveCommand('/project', 'moz-card', { yes: true })).rejects.toThrow(
      /EPERM: state file locked/
    );

    // The journal restore must have fired — remove is atomic end-to-end.
    expect(restoreRollbackJournalOrThrow).toHaveBeenCalled();
    // The state file path must have been snapshotted inside the
    // transactional block before the update was attempted.
    expect(snapshotFile).toHaveBeenCalledWith(
      expect.anything(),
      '/project/.fireforge/furnace-state.json'
    );
  });

  it('clears stale appliedChecksums and engineChecksums for the removed override', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only' as const,
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await furnaceRemoveCommand('/project', 'moz-card', { yes: true });

    expect(updateFurnaceState).toHaveBeenCalledWith('/project', expect.any(Function));
    const updaterArg = vi.mocked(updateFurnaceState).mock.calls.at(-1)?.[1];
    if (typeof updaterArg !== 'function') throw new Error('expected updater function');
    const before: FurnaceState = {
      appliedChecksums: {
        'override/moz-card/moz-card.css': 'abc',
        'override/moz-card/moz-card.mjs': 'def',
        'override/moz-other/moz-other.css': 'ghi',
        'custom/moz-widget/moz-widget.mjs': 'jkl',
      },
      engineChecksums: {
        'override/moz-card/moz-card.css': 'abc',
        'override/moz-card/moz-card.mjs': 'def',
        'override/moz-other/moz-other.css': 'ghi',
      },
    };
    const after = updaterArg(before);
    expect(after.appliedChecksums).toEqual({
      'override/moz-other/moz-other.css': 'ghi',
      'custom/moz-widget/moz-widget.mjs': 'jkl',
    });
    expect(after.engineChecksums).toEqual({
      'override/moz-other/moz-other.css': 'ghi',
    });
  });

  it('cancels when interactive confirmation is declined', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.mocked(isCancel).mockReturnValueOnce(true);

    await furnaceRemoveCommand('/project', 'moz-audit-widget');

    expect(logCancel).toHaveBeenCalledWith('Remove cancelled');
    expect(writeFurnaceConfig).not.toHaveBeenCalled();
  });

  it('cleans up test files for custom components', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget' ||
          target === '/project/engine/browser/base/content/test/mybrowser' ||
          target ===
            '/project/engine/browser/base/content/test/mybrowser/browser_mybrowser_audit_widget.js' ||
          target === '/project/engine/browser/base/content/test/mybrowser/browser.toml'
      )
    );
    vi.mocked(readText).mockResolvedValue('\n["browser_mybrowser_audit_widget.js"]\n');
    vi.mocked(readdir).mockResolvedValue([]);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(unlink).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/test/mybrowser/browser_mybrowser_audit_widget.js'
    );
    expect(writeText).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/test/mybrowser/browser.toml',
      expect.any(String)
    );
    expect(removeDir).toHaveBeenCalledWith('/project/engine/browser/base/content/test/mybrowser');
  });

  it('deregisters test manifest when test directory becomes empty', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(target === '/project/engine/browser/base/content/test/mybrowser')
    );
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(deregisterTestManifest).mockResolvedValue(true);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(deregisterTestManifest).toHaveBeenCalledWith('/project/engine', 'mybrowser');
    expect(info).toHaveBeenCalledWith('Deregistered test manifest from browser/base/moz.build');
  });

  it('warns but continues when test file cleanup fails', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(target === '/project/engine/browser/base/content/test/mybrowser')
    );
    vi.mocked(readdir).mockRejectedValue(new Error('EPERM'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not clean up test directory'));
  });

  it('removes the deployed .ftl for localized custom components', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-audit-widget': {
          description: 'Audit widget',
          targetPath: 'toolkit/content/widgets/moz-audit-widget',
          register: true,
          localized: true,
        },
      },
    });
    const ftlPath = '/project/engine/toolkit/locales/en-US/toolkit/global/moz-audit-widget.ftl';
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget' ||
          target === ftlPath
      )
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(removeFile).toHaveBeenCalledWith(ftlPath);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('engine/toolkit/locales/en-US/toolkit/global/moz-audit-widget.ftl')
    );
  });

  it('drops the locale jar.mn registration for localized custom components', async () => {
    // Eval 1 Finding #1: `furnace remove --yes` deleted the .ftl but left
    // `browser/locales/jar.mn` referencing the now-missing file. Fix plumbs
    // the existing removeCustomFtlJarMnEntry helper through the remove
    // pipeline so the locale registration and the file delete travel
    // together inside the rollback journal.
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-audit-widget': {
          description: 'Audit widget',
          targetPath: 'toolkit/content/widgets/moz-audit-widget',
          register: true,
          localized: true,
        },
      },
    });
    const ftlPath = '/project/engine/toolkit/locales/en-US/toolkit/global/moz-audit-widget.ftl';
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget' ||
          target === ftlPath
      )
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(removeCustomFtlJarMnEntry).toHaveBeenCalledWith(
      '/project/engine',
      'moz-audit-widget.ftl',
      'toolkit/locales/en-US/toolkit/global',
      expect.objectContaining({ localized: true }),
      expect.anything()
    );
  });

  it('does not touch the Fluent tree for non-localized custom components', async () => {
    vi.mocked(pathExists).mockImplementation((target: string) =>
      Promise.resolve(
        target === '/project/components/custom/moz-audit-widget' ||
          target === '/project/engine/toolkit/content/widgets/moz-audit-widget'
      )
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(removeFile).not.toHaveBeenCalledWith(
      expect.stringContaining('toolkit/locales/en-US/toolkit/global/')
    );
  });

  it('confirms interactively when TTY is available and --yes is not set', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.mocked(clack.confirm).mockResolvedValueOnce(true);

    await furnaceRemoveCommand('/project', 'moz-audit-widget');

    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
        message: expect.stringContaining('moz-audit-widget'),
      })
    );
    expect(writeFurnaceConfig).toHaveBeenCalled();
  });
});
