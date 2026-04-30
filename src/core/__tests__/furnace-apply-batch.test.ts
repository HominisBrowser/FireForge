// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../config.js', () => ({
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
  // `applyAllComponents` reads fireforge.json only for the optional
  // `markerComment` field. Tests do not exercise it, so resolve to an empty
  // shape — the code path also tolerates a rejection.
  loadConfig: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  restoreRollbackJournalOrThrow: vi.fn(() => Promise.resolve()),
  snapshotFile: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace-registration.js', () => ({
  addJarMnEntries: vi.fn(() => Promise.resolve()),
  addLocaleFtlJarMnEntry: vi.fn(() => Promise.resolve(0)),
  removeJarMnEntries: vi.fn(() => Promise.resolve()),
  removeLocaleFtlJarMnEntry: vi.fn(() => Promise.resolve()),
  removeCustomElementRegistration: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: '/project/furnace.json',
    componentsDir: '/project/components',
    overridesDir: '/project/components/overrides',
    customDir: '/project/components/custom',
    furnaceState: '/project/.fireforge/furnace-state.json',
  })),
  loadFurnaceConfig: vi.fn(),
  loadFurnaceState: vi.fn(),
  saveFurnaceState: vi.fn(),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace-apply-helpers.js', () => ({
  applyCustomComponent: vi.fn(),
  applyOverrideComponent: vi.fn(),
  computeComponentChecksums: vi.fn(),
  // Default: no files were deleted, so undeploy paths stay quiet. Tests
  // that exercise the undeploy branch override these per-call.
  diffDeletedFiles: vi.fn(() => []),
  extractComponentChecksums: vi.fn(),
  getOverrideEngineTargetPath: vi.fn(
    (engineDir: string, config: { basePath: string }, fileName: string) =>
      fileName.endsWith('.ftl')
        ? `${engineDir}/toolkit/locales/en-US/toolkit/global/${fileName}`
        : `${engineDir}/${config.basePath}/${fileName}`
  ),
  hasComponentChanged: vi.fn(),
  hasCustomEngineDrift: vi.fn(() => Promise.resolve(false)),
  hasOverrideEngineDrift: vi.fn(() => Promise.resolve(false)),
  prefixChecksums: vi.fn(),
  undeployCustomFiles: vi.fn(() => Promise.resolve([])),
  undeployOverrideFiles: vi.fn(() => Promise.resolve({ restored: [], removed: [] })),
}));

import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { loadConfig } from '../config.js';
import { applyAllComponents } from '../furnace-apply.js';
import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  diffDeletedFiles,
  extractComponentChecksums,
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
  prefixChecksums,
  undeployCustomFiles,
  undeployOverrideFiles,
} from '../furnace-apply-helpers.js';
import { loadFurnaceConfig, loadFurnaceState, updateFurnaceState } from '../furnace-config.js';
import {
  addJarMnEntries,
  removeCustomElementRegistration,
  removeJarMnEntries,
} from '../furnace-registration.js';
import { restoreRollbackJournalOrThrow } from '../furnace-rollback.js';

describe('applyAllComponents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'));

    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {
        'moz-panel': {
          description: 'Custom panel',
          targetPath: 'browser/components/panel',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({
      appliedChecksums: {
        'override:moz-card:old.css': 'old-hash',
      },
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(extractComponentChecksums).mockReturnValue({ 'old.css': 'old-hash' });
    vi.mocked(prefixChecksums).mockImplementation((checksums, type, name) => {
      return Object.fromEntries(
        Object.entries(checksums).map(([file, hash]) => [`${type}:${name}:${file}`, hash])
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) =>
      Promise.resolve(filePath !== '/project/engine')
    );

    await expect(applyAllComponents('/project')).rejects.toThrow(FurnaceError);
    await expect(applyAllComponents('/project')).rejects.toThrow('Run "fireforge download" first');
    expect(applyOverrideComponent).not.toHaveBeenCalled();
    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('aggregates dry-run actions without change detection or state persistence', async () => {
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.css'],
      actions: [
        {
          component: 'moz-card',
          action: 'copy',
          source: 'components/overrides/moz-card/moz-card.css',
          target: 'engine/toolkit/content/widgets/moz-card/moz-card.css',
          description: 'Copy override CSS',
        },
      ],
    });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [
        {
          component: 'moz-panel',
          action: 'register-ce',
          description: 'Register custom element',
        },
      ],
    });

    const result = await applyAllComponents('/project', true);

    expect(result).toEqual({
      applied: [
        {
          name: 'moz-card',
          type: 'override',
          filesAffected: ['toolkit/content/widgets/moz-card/moz-card.css'],
        },
        {
          name: 'moz-panel',
          type: 'custom',
          filesAffected: ['browser/components/panel/moz-panel.mjs'],
        },
      ],
      skipped: [],
      errors: [],
      actions: [
        {
          component: 'moz-card',
          action: 'copy',
          source: 'components/overrides/moz-card/moz-card.css',
          target: 'engine/toolkit/content/widgets/moz-card/moz-card.css',
          description: 'Copy override CSS',
        },
        {
          component: 'moz-panel',
          action: 'register-ce',
          description: 'Register custom element',
        },
      ],
    });
    expect(hasComponentChanged).not.toHaveBeenCalled();
    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(restoreRollbackJournalOrThrow).not.toHaveBeenCalled();
  });

  it('skips unchanged overrides, stores new custom checksums, and persists updated state', async () => {
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'panel.mjs': 'new-hash' });

    const result = await applyAllComponents('/project');

    expect(result).toEqual({
      applied: [
        {
          name: 'moz-panel',
          type: 'custom',
          filesAffected: ['browser/components/panel/moz-panel.mjs'],
        },
      ],
      skipped: [{ name: 'moz-card', reason: 'No changes since last apply' }],
      errors: [],
    });
    expect(extractComponentChecksums).toHaveBeenCalledWith(
      { 'override:moz-card:old.css': 'old-hash' },
      'override',
      'moz-card'
    );
    expect(prefixChecksums).toHaveBeenCalledWith({ 'old.css': 'old-hash' }, 'override', 'moz-card');
    expect(prefixChecksums).toHaveBeenCalledWith(
      { 'panel.mjs': 'new-hash' },
      'custom',
      'moz-panel'
    );
    expect(updateFurnaceState).toHaveBeenCalledWith('/project', {
      appliedChecksums: {
        'override:moz-card:old.css': 'old-hash',
        'custom:moz-panel:panel.mjs': 'new-hash',
      },
      engineChecksums: {
        'override:moz-card:old.css': 'old-hash',
        'custom:moz-panel:panel.mjs': 'new-hash',
      },
      lastApply: '2026-04-07T12:00:00.000Z',
    });
    expect(restoreRollbackJournalOrThrow).not.toHaveBeenCalled();
  });

  it('applies custom components with step errors but does not persist their checksums', async () => {
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.css'],
      actions: [],
    });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [{ step: 'register', error: 'already present' }],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValueOnce({ 'moz-card.css': 'override-hash' });

    const result = await applyAllComponents('/project');

    expect(result.applied).toEqual([
      {
        name: 'moz-card',
        type: 'override',
        filesAffected: ['toolkit/content/widgets/moz-card/moz-card.css'],
      },
      {
        name: 'moz-panel',
        type: 'custom',
        filesAffected: ['browser/components/panel/moz-panel.mjs'],
        stepErrors: [{ step: 'register', error: 'already present' }],
      },
    ]);
    // computeComponentChecksums is called once per non-skipped component
    // (override and custom). The custom's checksums are computed but not
    // stored, because stepErrors trigger rollback before persistence.
    expect(computeComponentChecksums).toHaveBeenCalledTimes(2);
    // Step errors trigger rollback — state is NOT persisted
    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(restoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      expect.any(Object),
      'Furnace apply failed'
    );
  });

  it('re-applies an override whose checksums match but whose engine copy has drifted', async () => {
    // Scenario: reset --force wiped the engine, but furnace-state.json still
    // holds the previous checksums. hasComponentChanged returns false (source
    // unchanged), but hasOverrideEngineDrift returns true because the engine
    // file is missing. The override must be re-applied, not skipped.
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(hasOverrideEngineDrift).mockResolvedValueOnce(true);
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.css'],
      actions: [],
    });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'moz-card.css': 'hash' });

    const result = await applyAllComponents('/project');

    expect(hasOverrideEngineDrift).toHaveBeenCalledWith(
      '/project/engine',
      '/project/components/overrides/moz-card',
      expect.objectContaining({ type: 'css-only' }),
      'toolkit/locales/en-US/toolkit/global',
      expect.any(Object)
    );
    expect(result.applied).toContainEqual(
      expect.objectContaining({ name: 'moz-card', type: 'override' })
    );
    expect(result.skipped).not.toContainEqual(expect.objectContaining({ name: 'moz-card' }));
    expect(applyOverrideComponent).toHaveBeenCalled();
  });

  it('re-applies a custom component whose registration has drifted from the engine', async () => {
    // Scenario: the engine's customElements.js or jar.mn has been reset but
    // the workspace source files are unchanged. hasComponentChanged returns
    // false; hasCustomEngineDrift returns true; apply must re-run.
    vi.mocked(hasComponentChanged).mockResolvedValue(false);
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(false);
    vi.mocked(hasCustomEngineDrift).mockResolvedValueOnce(true);
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [],
    });
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'panel.mjs': 'hash' });

    const result = await applyAllComponents('/project');

    expect(hasCustomEngineDrift).toHaveBeenCalledWith(
      '/project',
      'moz-panel',
      '/project/components/custom/moz-panel',
      expect.objectContaining({ register: true }),
      'toolkit/locales/en-US/toolkit/global'
    );
    expect(result.applied).toContainEqual(
      expect.objectContaining({ name: 'moz-panel', type: 'custom' })
    );
    expect(result.skipped).not.toContainEqual(expect.objectContaining({ name: 'moz-panel' }));
  });

  it('still honours the fast path when source and engine are both in sync', async () => {
    // Regression guard: drift detection must NOT fire when the engine
    // actually matches source. Both components are unchanged and drift-free;
    // both should skip.
    vi.mocked(hasComponentChanged).mockResolvedValue(false);
    vi.mocked(hasOverrideEngineDrift).mockResolvedValue(false);
    vi.mocked(hasCustomEngineDrift).mockResolvedValue(false);

    const result = await applyAllComponents('/project');

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'moz-card', reason: 'No changes since last apply' },
      { name: 'moz-panel', reason: 'No changes since last apply' },
    ]);
    expect(applyOverrideComponent).not.toHaveBeenCalled();
    expect(applyCustomComponent).not.toHaveBeenCalled();
  });

  it('undeploys files removed from a custom component workspace and re-syncs jar.mn', async () => {
    // Scenario: previous apply deployed { panel.mjs, panel.css }. The
    // developer has since deleted panel.css. The new apply should remove
    // panel.css from the engine and drop its jar.mn entry, but NOT
    // deregister the customElement (the .mjs is still present).
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(extractComponentChecksums).mockReturnValueOnce({}).mockReturnValueOnce({
      'moz-panel.mjs': 'old-mjs',
      'moz-panel.css': 'old-css',
    });
    vi.mocked(computeComponentChecksums).mockResolvedValue({
      'moz-panel.mjs': 'new-mjs',
    });
    vi.mocked(diffDeletedFiles).mockReturnValueOnce(['moz-panel.css']);
    vi.mocked(undeployCustomFiles).mockResolvedValue(['browser/components/panel/moz-panel.css']);
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.mjs'],
      stepErrors: [],
      actions: [],
    });

    const result = await applyAllComponents('/project');

    expect(undeployCustomFiles).toHaveBeenCalledWith(
      '/project/engine',
      expect.objectContaining({ register: true }),
      ['moz-panel.css'],
      'toolkit/locales/en-US/toolkit/global',
      expect.any(Object)
    );
    // jar.mn must be re-synced (remove all + re-add live entries) so the
    // stale CSS entry does not survive into the engine.
    expect(removeJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-panel');
    expect(addJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-panel', ['moz-panel.mjs']);
    // The .mjs is still present, so customElements registration is NOT
    // touched. Only the deletion of the .mjs itself should trigger that.
    expect(removeCustomElementRegistration).not.toHaveBeenCalled();
    const panel = result.applied.find((entry) => entry.name === 'moz-panel');
    expect(panel?.type).toBe('custom');
    expect(panel?.filesAffected).toEqual(
      expect.arrayContaining([
        'browser/components/panel/moz-panel.css',
        'browser/components/panel/moz-panel.mjs',
      ])
    );
  });

  it('deregisters the customElement when the .mjs source file is deleted', async () => {
    // Edge case: developer deleted moz-panel.mjs from the workspace
    // without running `furnace remove`. Re-apply must drop the dangling
    // customElements registration so the runtime does not import a
    // missing module.
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(extractComponentChecksums)
      .mockReturnValueOnce({})
      .mockReturnValueOnce({ 'moz-panel.mjs': 'old-mjs', 'moz-panel.css': 'old-css' });
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'moz-panel.css': 'css-hash' });
    vi.mocked(diffDeletedFiles).mockReturnValueOnce(['moz-panel.mjs']);
    vi.mocked(undeployCustomFiles).mockResolvedValue(['browser/components/panel/moz-panel.mjs']);
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['browser/components/panel/moz-panel.css'],
      stepErrors: [],
      actions: [],
    });

    await applyAllComponents('/project');

    expect(removeCustomElementRegistration).toHaveBeenCalledWith('/project/engine', 'moz-panel');
    expect(removeJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-panel');
    expect(addJarMnEntries).toHaveBeenCalledWith('/project/engine', 'moz-panel', ['moz-panel.css']);
  });

  it('undeploys files removed from an override component workspace', async () => {
    // Scenario: previous apply deployed { moz-card.mjs, moz-card.css } as
    // a `full` override. Developer deleted moz-card.css. Re-apply must
    // restore moz-card.css from HEAD via undeployOverrideFiles.
    vi.mocked(hasComponentChanged).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(extractComponentChecksums)
      .mockReturnValueOnce({ 'moz-card.mjs': 'old-mjs', 'moz-card.css': 'old-css' })
      .mockReturnValueOnce({});
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'moz-card.mjs': 'new-mjs' });
    vi.mocked(diffDeletedFiles).mockReturnValueOnce(['moz-card.css']);
    vi.mocked(undeployOverrideFiles).mockResolvedValue({
      restored: ['toolkit/content/widgets/moz-card/moz-card.css'],
      removed: [],
    });
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-card/moz-card.mjs'],
      actions: [],
    });

    const result = await applyAllComponents('/project');

    expect(undeployOverrideFiles).toHaveBeenCalledWith(
      '/project/engine',
      expect.objectContaining({ type: 'css-only' }),
      ['moz-card.css'],
      'toolkit/locales/en-US/toolkit/global',
      expect.any(Object)
    );
    const card = result.applied.find((entry) => entry.name === 'moz-card');
    expect(card?.type).toBe('override');
    expect(card?.filesAffected).toEqual(
      expect.arrayContaining([
        'toolkit/content/widgets/moz-card/moz-card.css',
        'toolkit/content/widgets/moz-card/moz-card.mjs',
      ])
    );
  });

  it('emits undeploy actions in dry-run mode without mutating the engine', async () => {
    // Dry-run plan output must include the undeploy actions so users can
    // see exactly what apply will do, without actually deleting or
    // restoring anything.
    vi.mocked(extractComponentChecksums)
      .mockReturnValueOnce({ 'moz-card.mjs': 'old-mjs', 'moz-card.css': 'old-css' })
      .mockReturnValueOnce({ 'moz-panel.mjs': 'old-mjs' });
    vi.mocked(computeComponentChecksums)
      .mockResolvedValueOnce({ 'moz-card.mjs': 'old-mjs' })
      .mockResolvedValueOnce({});
    vi.mocked(diffDeletedFiles)
      .mockReturnValueOnce(['moz-card.css'])
      .mockReturnValueOnce(['moz-panel.mjs']);
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: [],
      actions: [],
    });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: [],
      stepErrors: [],
      actions: [],
    });

    const result = await applyAllComponents('/project', true);

    // Real undeploy must NOT run in dry-run.
    expect(undeployCustomFiles).not.toHaveBeenCalled();
    expect(undeployOverrideFiles).not.toHaveBeenCalled();
    expect(removeJarMnEntries).not.toHaveBeenCalled();

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'moz-card',
          action: 'undeploy-restore',
        }),
        expect.objectContaining({
          component: 'moz-panel',
          action: 'undeploy-remove',
        }),
        expect.objectContaining({
          component: 'moz-panel',
          action: 'unregister-jar',
        }),
        expect.objectContaining({
          component: 'moz-panel',
          action: 'unregister-ce',
        }),
      ])
    );
  });

  it('collects missing-directory and apply errors without aborting the batch', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) => {
      if (filePath === '/project/components/overrides/moz-card') {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(applyCustomComponent).mockRejectedValue(new Error('copy failed'));

    const result = await applyAllComponents('/project');

    expect(result).toEqual({
      applied: [],
      skipped: [],
      errors: [
        {
          name: 'moz-card',
          error: 'Component directory not found: components/overrides/moz-card',
        },
        {
          name: 'moz-panel',
          error: 'copy failed',
        },
      ],
      rolledBack: true,
    });
    // Errors trigger rollback — state is NOT persisted
    expect(updateFurnaceState).not.toHaveBeenCalled();
    expect(restoreRollbackJournalOrThrow).toHaveBeenCalledWith(
      expect.any(Object),
      'Furnace apply failed'
    );
  });

  it('rejects custom components that compose unknown references at apply time', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: false,
          localized: false,
          composes: ['moz-button', 'moz-ghost'],
        },
      },
    });
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(applyOverrideComponent).mockResolvedValue({
      affectedPaths: [],
    });

    const result = await applyAllComponents('/project');

    /* eslint-disable @typescript-eslint/no-unsafe-assignment --
     * vitest's `expect.objectContaining` returns `any`; the matcher itself
     * is correctly typed but the inner object slot is not. */
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'moz-widget',
          error: expect.stringContaining('moz-ghost'),
        }),
      ])
    );
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    expect(applyCustomComponent).not.toHaveBeenCalled();
  });

  it('applies custom components whose composes references are all known', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: ['moz-button'],
      overrides: {},
      custom: {
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: false,
          localized: false,
          composes: ['moz-button'],
        },
      },
    });
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(computeComponentChecksums).mockResolvedValue({ 'moz-widget.mjs': 'abc' });
    vi.mocked(applyCustomComponent).mockResolvedValue({
      affectedPaths: ['toolkit/content/widgets/moz-widget/moz-widget.mjs'],
      stepErrors: [],
    });

    const result = await applyAllComponents('/project');

    expect(result.errors).toHaveLength(0);
    expect(applyCustomComponent).toHaveBeenCalled();
  });

  describe('markerComment defaulting (Finding 6)', () => {
    it('defaults markerComment to binaryName.toUpperCase() when fireforge.json omits it', async () => {
      // Pre-fix: when an operator's `fireforge.json` did not set
      // `markerComment`, the furnace apply phase passed `undefined`
      // through to `addCustomElementRegistration`, so the inserted
      // lines in `customElements.js` carried no `// FRESHFORGE:`
      // marker. The patch-lint rule `lintModificationComments` keys on
      // `${binaryName.toUpperCase()}:` and therefore flagged every
      // furnace-emitted edit as missing the marker on the next
      // `lint`/`export` round-trip.
      vi.mocked(loadConfig).mockResolvedValueOnce({
        binaryName: 'freshforge',
      } as unknown as Awaited<ReturnType<typeof loadConfig>>);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'ff-',
        stock: [],
        overrides: {},
        custom: {
          'ff-panel': {
            description: 'Panel',
            targetPath: 'browser/components/panel',
            register: true,
            localized: false,
          },
        },
      });
      vi.mocked(hasComponentChanged).mockResolvedValue(true);
      vi.mocked(applyCustomComponent).mockResolvedValue({
        affectedPaths: ['browser/components/panel/ff-panel.mjs'],
        stepErrors: [],
      });

      await applyAllComponents('/project');

      expect(applyCustomComponent).toHaveBeenCalledWith(
        expect.anything(),
        'ff-panel',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { markerComment: 'FRESHFORGE' }
      );
    });

    it('honours an explicit markerComment from fireforge.json over the binaryName default', async () => {
      // An operator who has set `markerComment: "FRESHFORGE-CUSTOM"`
      // (or any other string) explicitly must keep that value — the
      // binaryName fallback is a default, not an override.
      vi.mocked(loadConfig).mockResolvedValueOnce({
        binaryName: 'freshforge',
        markerComment: 'FRESHFORGE-CUSTOM',
      } as unknown as Awaited<ReturnType<typeof loadConfig>>);
      vi.mocked(loadFurnaceConfig).mockResolvedValue({
        version: 1,
        componentPrefix: 'ff-',
        stock: [],
        overrides: {},
        custom: {
          'ff-panel': {
            description: 'Panel',
            targetPath: 'browser/components/panel',
            register: true,
            localized: false,
          },
        },
      });
      vi.mocked(hasComponentChanged).mockResolvedValue(true);
      vi.mocked(applyCustomComponent).mockResolvedValue({
        affectedPaths: ['browser/components/panel/ff-panel.mjs'],
        stepErrors: [],
      });

      await applyAllComponents('/project');

      expect(applyCustomComponent).toHaveBeenCalledWith(
        expect.anything(),
        'ff-panel',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { markerComment: 'FRESHFORGE-CUSTOM' }
      );
    });
  });
});
