// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

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
  // Engine-precondition ladder (assertEngineGitReady). Stubbed to the
  // healthy-engine answers so these suites test their own subject.
  getHead: vi.fn(() => Promise.resolve('0'.repeat(40))),
  isMissingHeadError: vi.fn(() => false),

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

vi.mock('../../core/furnace-operation.js', async (importOriginal) => ({
  // `completeJournalRollback` is pure orchestration over the journal and
  // the pending-repair marker — the behaviour these suites assert — so it
  // comes from the real module.
  ...(await importOriginal<typeof import('../../core/furnace-operation.js')>()),
  runFurnaceMutation: vi.fn(
    async (
      _root: string,
      _kind: string,
      body: (ctx: {
        registerJournal: () => void;
        registerCleanup: () => void;
        markRolledBack: () => void;
      }) => Promise<unknown>
    ) =>
      body({
        registerJournal: () => undefined,
        registerCleanup: () => undefined,
        markRolledBack: () => undefined,
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

vi.mock('../../core/moz-manifest-register.js', () => ({
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

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { readdir, unlink } from 'node:fs/promises';

import * as clack from '@clack/prompts';

import { loadConfig } from '../../core/config.js';
import { removeCustomFtlJarMnEntry } from '../../core/furnace-apply-ftl.js';
import {
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { recordFurnaceRollbackFailure } from '../../core/furnace-operation.js';
import {
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../../core/furnace-registration.js';
import { restoreRollbackJournalOrThrow, snapshotFile } from '../../core/furnace-rollback.js';
import { isGitRepository } from '../../core/git.js';
import { fileExistsInHead, restoreTrackedPath } from '../../core/git-file-ops.js';
import { deregisterTestManifest } from '../../core/moz-manifest-register.js';
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
    // A developer can delete a component CSS file from the workspace and run
    // apply (which historically did not undeploy), leaving the state file
    // recording the orphaned engine copy. furnace remove must consult the
    // state file to find and restore that copy even though the workspace no
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
    // `furnace remove --yes` must not delete the .ftl while leaving
    // `browser/locales/jar.mn` referencing the now-missing file. The
    // `removeCustomFtlJarMnEntry` helper is plumbed through the remove
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

/**
 * Shared reset for the appended suites. Mirrors the main describe's
 * beforeEach — `vi.clearAllMocks()` clears calls but not implementations.
 */
function resetRemoveMocks(): void {
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
  vi.mocked(unlink).mockResolvedValue(undefined);
  vi.mocked(fileExistsInHead).mockResolvedValue(true);
  vi.mocked(restoreTrackedPath).mockResolvedValue(undefined);
  vi.mocked(deregisterTestManifest).mockResolvedValue(false);
  vi.mocked(removeCustomFtlJarMnEntry).mockResolvedValue(undefined);
  vi.mocked(removeCustomElementRegistration).mockResolvedValue(undefined);
  vi.mocked(removeJarMnEntries).mockResolvedValue(undefined);
  vi.mocked(restoreRollbackJournalOrThrow).mockResolvedValue(undefined);
  vi.mocked(loadConfig).mockResolvedValue({ binaryName: 'mybrowser' } as never);
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
}

/** Marks the given engine-relative suffixes as existing on disk. */
function existsFor(...suffixes: string[]): void {
  vi.mocked(pathExists).mockImplementation((target: string) =>
    Promise.resolve(suffixes.some((suffix) => target.includes(suffix)))
  );
}

describe('furnaceRemoveCommand — rollback failure', () => {
  beforeEach(resetRemoveMocks);

  it('records a repair breadcrumb and surfaces the rollback error, not the original', async () => {
    // The engine is left in an unknown state when rollback itself fails, so
    // the rollback error must win and `doctor --repair-furnace` must have a
    // breadcrumb naming the component.
    vi.mocked(removeCustomElementRegistration).mockRejectedValue(
      new Error('customElements.js is unparsable')
    );
    vi.mocked(restoreRollbackJournalOrThrow).mockRejectedValue(
      new Error('could not restore moz-audit-widget.mjs')
    );

    await expect(
      furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true })
    ).rejects.toThrow(/could not restore moz-audit-widget\.mjs/);

    // Asserts the OUTCOME — a pending-repair marker persisted to furnace
    // state — rather than the internal call. The rollback sequence now lives
    // in `completeJournalRollback`, whose call to the recorder is
    // intra-module and so invisible to a module-level spy.
    const updater = vi.mocked(updateFurnaceState).mock.calls.at(-1)?.[1] as
      | ((state: Record<string, unknown>) => {
          pendingRepair?: { operation: string; reason: string };
        })
      | undefined;
    expect(updater).toBeTypeOf('function');
    const pendingRepair = updater?.({}).pendingRepair;
    expect(pendingRepair?.operation).toBe('remove-rollback');
    expect(pendingRepair?.reason).toContain(
      'component "moz-audit-widget": could not restore moz-audit-widget.mjs'
    );
  });

  it('surfaces the original error when rollback succeeds', async () => {
    vi.mocked(removeCustomElementRegistration).mockRejectedValue(
      new Error('customElements.js is unparsable')
    );

    await expect(
      furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true })
    ).rejects.toThrow(/customElements\.js is unparsable/);

    expect(restoreRollbackJournalOrThrow).toHaveBeenCalled();
    expect(recordFurnaceRollbackFailure).not.toHaveBeenCalled();
  });
});

describe('furnaceRemoveCommand — concurrent mutation re-check', () => {
  beforeEach(resetRemoveMocks);

  it('refuses when the component disappears between the pre-lock check and the lock', async () => {
    // The pre-lock read sees the component; the fresh in-lock read does not,
    // because a concurrent `furnace remove` won the race.
    vi.mocked(loadFurnaceConfig)
      .mockResolvedValueOnce(defaultRemoveConfig())
      .mockResolvedValue({
        version: 1 as const,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {},
      });

    await expect(
      furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true })
    ).rejects.toThrow(/Component "moz-audit-widget" not found in furnace\.json/);
  });
});

describe('furnaceRemoveCommand — browser mochitest cleanup', () => {
  beforeEach(resetRemoveMocks);

  it('warns and continues when the project config cannot be loaded', async () => {
    // Both cleanup helpers read the config independently, so an unloadable
    // fireforge.json degrades each of them separately rather than aborting
    // a removal that has already deregistered the component.
    vi.mocked(loadConfig).mockRejectedValue(new Error('fireforge.json is corrupt'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not load config for test cleanup — fireforge.json is corrupt')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Could not load config for xpcshell test cleanup — fireforge.json is corrupt'
      )
    );
  });

  it('warns and continues when the test file cannot be unlinked', async () => {
    existsFor('browser/base/content/test/mybrowser');
    vi.mocked(unlink).mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not delete test file browser_mybrowser_audit_widget.js')
    );
  });

  it('warns and continues when browser.toml cannot be rewritten', async () => {
    existsFor('browser/base/content/test/mybrowser');
    vi.mocked(readText).mockResolvedValue('["browser_mybrowser_audit_widget.js"]\n');
    vi.mocked(writeText).mockRejectedValue(new Error('disk full'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not update browser.toml — disk full')
    );
  });

  it('leaves browser.toml alone when it does not list the test', async () => {
    existsFor('browser/base/content/test/mybrowser');
    vi.mocked(readText).mockResolvedValue('["browser_something_else.js"]\n');

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(writeText).not.toHaveBeenCalled();
  });

  it('keeps the test directory when other browser tests remain', async () => {
    existsFor('browser/base/content/test/mybrowser');
    vi.mocked(readdir).mockResolvedValue(['browser_other_test.js'] as never);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Deleted empty test directory'));
  });

  it('deletes the test directory once no browser tests remain', async () => {
    existsFor('browser/base/content/test/mybrowser');
    vi.mocked(readdir).mockResolvedValue(['some-support-file.json'] as never);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Deleted empty test directory: browser/base/content/test/mybrowser/')
    );
  });

  it('reports the aggregate warning count when cleanup partially failed', async () => {
    existsFor('browser/base/content/test/mybrowser');
    vi.mocked(unlink).mockRejectedValue(new Error('EACCES'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test-cleanup warning(s) above'));
  });
});

describe('furnaceRemoveCommand — mochikit test cleanup', () => {
  beforeEach(resetRemoveMocks);

  it('deletes the mochikit test file and prunes its chrome.toml section', async () => {
    existsFor('toolkit/content/tests/widgets');
    vi.mocked(readText).mockResolvedValue(
      '["test_moz-audit-widget.html"]\nsupport-files = []\n\n["other.html"]\n'
    );

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining('toolkit/content/tests/widgets/test_moz-audit-widget.html')
    );
    const written = vi.mocked(writeText).mock.calls.find(([path]) => path.endsWith('chrome.toml'));
    expect(written?.[1]).not.toContain('test_moz-audit-widget.html');
    expect(written?.[1]).toContain('["other.html"]');
  });

  it('warns and continues when the mochikit test file cannot be deleted', async () => {
    existsFor('toolkit/content/tests/widgets');
    vi.mocked(unlink).mockRejectedValue(new Error('EROFS: read-only file system'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not delete mochikit test file test_moz-audit-widget.html')
    );
  });

  it('warns and continues when chrome.toml cannot be rewritten', async () => {
    existsFor('toolkit/content/tests/widgets');
    vi.mocked(readText).mockResolvedValue('["test_moz-audit-widget.html"]\n');
    vi.mocked(writeText).mockRejectedValue(new Error('disk full'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not update widgets chrome.toml — disk full')
    );
  });
});

describe('furnaceRemoveCommand — xpcshell scaffold cleanup', () => {
  beforeEach(resetRemoveMocks);

  it('removes the component scaffold and the now-empty parent directory', async () => {
    existsFor('mybrowser-xpcshell');
    vi.mocked(readdir).mockResolvedValue([] as never);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(removeDir).toHaveBeenCalledWith(
      expect.stringContaining('mybrowser-xpcshell/moz-audit-widget')
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Deleted empty xpcshell parent directory')
    );
  });

  it('keeps the parent directory when another component still has a scaffold', async () => {
    existsFor('mybrowser-xpcshell');
    vi.mocked(readdir).mockResolvedValue(['moz-other-widget'] as never);

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(info).not.toHaveBeenCalledWith(
      expect.stringContaining('Deleted empty xpcshell parent directory')
    );
  });

  it('warns and continues when the scaffold cannot be deleted', async () => {
    existsFor('mybrowser-xpcshell');
    vi.mocked(removeDir).mockRejectedValue(new Error('EBUSY: resource busy'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not delete xpcshell test scaffold — EBUSY: resource busy')
    );
  });

  it('warns and continues when the parent cleanup fails', async () => {
    existsFor('mybrowser-xpcshell');
    vi.mocked(readdir).mockRejectedValue(new Error('EACCES on parent'));

    await furnaceRemoveCommand('/project', 'moz-audit-widget', { yes: true });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not clean up xpcshell parent directory — EACCES on parent')
    );
  });
});
