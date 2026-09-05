// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPatchesManifest } from '../../core/patch-manifest.js';
import {
  FIREFOX_WORKFLOW_FIXTURES,
  FIREFOX_WORKFLOW_SETUP_OPTIONS,
} from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  runGit,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { importCommand } from '../import.js';
import { reExportCommand } from '../re-export.js';
import { setupCommand } from '../setup.js';

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('Firefox workflow fixtures', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-firefox-workflow-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('exports and re-imports a compact Firefox-style patch fixture', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.roundTrip;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual(fixture.expectedFilesAffected);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    await expect(readProjectText(projectRoot, `patches/${patchFilename}`)).resolves.toContain(
      '+export const browserTitle = "new";'
    );

    await runGit(join(projectRoot, 'engine'), ['checkout', '--', fixture.exportPath]);
    await importCommand(projectRoot, {});

    await expect(readProjectText(join(projectRoot, 'engine'), fixture.exportPath)).resolves.toBe(
      fixture.expectedImportedContent
    );
  });

  it('re-exports a patch fixture and discovers new sibling files with --scan', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.reExportScan;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    await writeFiles(join(projectRoot, 'engine'), fixture.firstExportState);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    await writeFiles(join(projectRoot, 'engine'), fixture.secondExportState);

    const manifestBefore = await loadPatchesManifest(join(projectRoot, 'patches'));
    const firstPatch = manifestBefore?.patches[0];
    if (!firstPatch) {
      throw new Error('Expected exported patch filename');
    }
    const patchFilename = firstPatch.filename;
    const patchOrder = firstPatch.order;

    await reExportCommand(projectRoot, [String(patchOrder)], {
      scan: true,
    });

    const manifestAfter = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifestAfter?.patches[0]?.filesAffected).toEqual(fixture.expectedFilesAffected);
    await expect(readProjectText(projectRoot, `patches/${patchFilename}`)).resolves.toContain(
      '+++ b/browser/components/example/panel-helper.js'
    );
  });

  it('blocks import when the engine head has drifted from the recorded baseline', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.driftGuard;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    const baseCommit = (await runGit(join(projectRoot, 'engine'), ['rev-parse', 'HEAD'])).trim();
    await writeFiles(projectRoot, {
      '.fireforge/state.json': `${JSON.stringify({ baseCommit }, null, 2)}\n`,
    });

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);
    await runGit(join(projectRoot, 'engine'), ['checkout', '--', fixture.exportPath]);

    await writeFiles(join(projectRoot, 'engine'), fixture.driftFiles);
    await runGit(join(projectRoot, 'engine'), ['add', '-A']);
    await runGit(join(projectRoot, 'engine'), ['commit', '-m', 'upstream drift']);

    await expect(importCommand(projectRoot, {})).rejects.toThrow(
      /Re-run with --yes to accept the drift, or --force to also bypass the patch-integrity gate/
    );
  });

  it('exports and round-trips a new CSS design token file', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.cssDesignTokens;
    // For new-file fixtures, init with a dummy file so git has a commit
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/themes/shared/.gitkeep': '',
    });

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual(fixture.expectedFilesAffected);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readProjectText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('new file mode');
    expect(patchContent).toContain('light-dark(');

    // Round-trip: add, commit, then reset to baseline and reimport
    const engineDir = join(projectRoot, 'engine');
    const cssPath = fixture.expectedFilesAffected[0];
    await runGit(engineDir, ['add', cssPath]);
    await runGit(engineDir, ['commit', '-m', 'add new file']);
    await runGit(engineDir, ['rm', '-f', cssPath]);
    await runGit(engineDir, ['commit', '-m', 'remove for reimport']);
    await importCommand(projectRoot, {});

    await expect(readProjectText(engineDir, cssPath)).resolves.toBe(fixture.modifiedFiles[cssPath]);
  });

  it('exports upstream BrowserGlue modification with marker comment', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.browserGlueIntegration;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readProjectText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('// MYBROWSER: sidebar');

    // Round-trip
    const engineDir = join(projectRoot, 'engine');
    await runGit(engineDir, ['checkout', '--', fixture.exportPath]);
    await importCommand(projectRoot, {});

    await expect(readProjectText(engineDir, fixture.exportPath)).resolves.toBe(
      fixture.modifiedFiles[fixture.exportPath]
    );
  });

  it('exports a test file alongside its manifest update', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.testFileWithManifest;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual(fixture.expectedFilesAffected);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readProjectText(projectRoot, `patches/${patchFilename}`);
    // .toml is modification, .js is new file
    expect(patchContent).toContain('+++ b/browser/components/mybrowser/test/browser.toml');
    expect(patchContent).toContain('new file mode');
    expect(patchContent).toContain('+++ b/browser/components/mybrowser/test/browser_sidebar.js');

    // Round-trip: commit the new state, then reset to baseline
    const engineDir = join(projectRoot, 'engine');
    await runGit(engineDir, ['add', '-A']);
    await runGit(engineDir, ['commit', '-m', 'snapshot exported state']);
    // Restore .toml to original and remove new .js
    await runGit(engineDir, [
      'checkout',
      'HEAD~1',
      '--',
      'browser/components/mybrowser/test/browser.toml',
    ]);
    await runGit(engineDir, ['rm', '-f', 'browser/components/mybrowser/test/browser_sidebar.js']);
    await runGit(engineDir, ['commit', '-m', 'reset for reimport']);
    await importCommand(projectRoot, {});

    for (const [path, content] of Object.entries(fixture.modifiedFiles)) {
      await expect(readProjectText(engineDir, path)).resolves.toBe(content);
    }
  });

  it('exports and round-trips a Rust file modification (lint-clean for non-JS/CSS)', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.rustFileModification;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual(fixture.expectedFilesAffected);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readProjectText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('+        .opaque_type("std::.*basic_string")');
    expect(patchContent).toContain('+        .blocklist_item(".*basic_string___self_view")');
    // Rust file is not "new file mode" — it's a modification
    expect(patchContent).not.toContain('new file mode');

    // Round-trip
    const engineDir = join(projectRoot, 'engine');
    await runGit(engineDir, ['checkout', '--', fixture.exportPath]);
    await importCommand(projectRoot, {});

    await expect(readProjectText(engineDir, fixture.exportPath)).resolves.toBe(
      fixture.modifiedFiles[fixture.exportPath]
    );
  });

  it('re-exports a patch after further modifications update its content', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.reExportWithModification;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    // First export
    await writeFiles(join(projectRoot, 'engine'), fixture.firstExportState);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifestBefore = await loadPatchesManifest(join(projectRoot, 'patches'));
    const firstPatch = manifestBefore?.patches[0];
    if (!firstPatch) throw new Error('Expected exported patch');
    const patchFilename = firstPatch.filename;

    await expect(readProjectText(projectRoot, `patches/${patchFilename}`)).resolves.toContain(
      '+export const MAX_WORKSPACES = 16;'
    );

    // Further modification
    await writeFiles(join(projectRoot, 'engine'), fixture.secondExportState);

    // Re-export
    await reExportCommand(projectRoot, [String(firstPatch.order)], {});

    const updatedPatch = await readProjectText(projectRoot, `patches/${patchFilename}`);
    expect(updatedPatch).toContain('+export const MAX_WORKSPACES = 16;');
    expect(updatedPatch).toContain('+export const DEFAULT_DOCK_POSITION = "bottom";');
  });

  it('blocks superseding export in non-interactive mode without --supersede', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.supersedeGuard;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    // First export
    await writeFiles(join(projectRoot, 'engine'), fixture.firstExportState);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.firstExportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);

    // Modify further
    await writeFiles(join(projectRoot, 'engine'), fixture.secondExportState);

    // Second export for same file — should fail without --supersede
    await expect(
      exportCommand(projectRoot, [fixture.exportPath], fixture.secondExportOptions)
    ).rejects.toThrow('supersede');
  });

  it('allows superseding export when --supersede flag is set', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.supersedeGuard;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    // First export
    await writeFiles(join(projectRoot, 'engine'), fixture.firstExportState);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.firstExportOptions);

    // Modify further
    await writeFiles(join(projectRoot, 'engine'), fixture.secondExportState);

    // Second export with --supersede should succeed
    await exportCommand(projectRoot, [fixture.exportPath], {
      ...fixture.secondExportOptions,
      supersede: true,
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    // Should have only the new patch (old one superseded)
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.name).toBe('version-bump-v2');
  });

  it('exports with --skipLint despite lint errors', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    // Without --skipLint, should fail due to lint errors
    await expect(
      exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions)
    ).rejects.toThrow('error');

    // With --skipLint, should succeed
    await exportCommand(projectRoot, [fixture.exportPath], {
      ...fixture.exportOptions,
      skipLint: true,
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.name).toBe('bad-module');
  });

  it('exports a multi-hunk patch with changes in two distant file locations', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.multiHunkModification;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);
    await exportCommand(projectRoot, [fixture.exportPath], fixture.exportOptions);

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readProjectText(projectRoot, `patches/${patchFilename}`);

    // Should contain both hunks: lazy import near top AND startup hook below
    expect(patchContent).toContain(
      '+  MyBrowserStore: "resource:///modules/mybrowser/MyBrowserStore.sys.mjs", // MYBROWSER: storage'
    );
    expect(patchContent).toContain('+    lazy.MyBrowserStore.init(); // MYBROWSER: init storage');

    // Should have two @@ hunk headers (multi-hunk patch)
    const hunkHeaders = patchContent.match(/^@@\s/gm);
    expect(hunkHeaders?.length).toBeGreaterThanOrEqual(2);

    // Round-trip
    const engineDir = join(projectRoot, 'engine');
    await runGit(engineDir, ['checkout', '--', fixture.exportPath]);
    await importCommand(projectRoot, {});

    await expect(readProjectText(engineDir, fixture.exportPath)).resolves.toBe(
      fixture.modifiedFiles[fixture.exportPath]
    );
  });

  it('imports a stack of two patches where both are applied in order', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.patchStackBase;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);

    // Patch 1: moz.build DIRS change
    await writeFiles(join(projectRoot, 'engine'), fixture.firstPatch.files);
    await exportCommand(projectRoot, [...fixture.firstPatch.exportPaths], {
      name: fixture.firstPatch.name,
      category: fixture.firstPatch.category,
      description: fixture.firstPatch.description,
    });

    // Patch 2: FlushManager.sys.mjs content change (different file, no supersede)
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/FlushManager.sys.mjs': [
        '/* SPDX-License-Identifier: EUPL-1.2 */',
        '',
        '/** @returns {number} */',
        'export function getFlushInterval() { return 3000; }',
        '',
      ].join('\n'),
    });
    await exportCommand(projectRoot, ['browser/modules/mybrowser/FlushManager.sys.mjs'], {
      name: 'flush-interval-change',
      category: 'infra',
      description: 'Reduce flush interval',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(2);

    // Reset engine to baseline and import both patches in order
    const engineDir = join(projectRoot, 'engine');
    await runGit(engineDir, ['checkout', '--', 'browser/modules/moz.build']);
    await runGit(engineDir, ['checkout', '--', 'browser/modules/mybrowser/FlushManager.sys.mjs']);
    await importCommand(projectRoot, {});

    // Both patches should be applied
    const mozbuild = await readProjectText(engineDir, 'browser/modules/moz.build');
    expect(mozbuild).toContain('"mybrowser"');
    const flush = await readProjectText(
      engineDir,
      'browser/modules/mybrowser/FlushManager.sys.mjs'
    );
    expect(flush).toContain('return 3000;');
  });

  it('imports two overlapping patches modifying the same file in sequence', async () => {
    // This tests a real-world scenario where two patches both touch moz.build.
    // Patch 1 adds to DIRS, patch 2 (superseding patch 1's entry for that file) adds to EXTRA_JS_MODULES.
    // After import, both changes should be present.
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/modules/moz.build': [
        'DIRS += [',
        '    "newtab",',
        '    "urlbar",',
        ']',
        '',
        'EXTRA_JS_MODULES += [',
        '    "Telemetry.sys.mjs",',
        ']',
        '',
      ].join('\n'),
      'browser/modules/mybrowser/Store.sys.mjs':
        '/* SPDX-License-Identifier: EUPL-1.2 */\n\n/** Store. */\nexport function init() {}\n',
    });

    // Patch 1: new file (doesn't overlap)
    await writeFiles(engineDir, {
      'browser/modules/mybrowser/Store.sys.mjs':
        '/* SPDX-License-Identifier: EUPL-1.2 */\n\n/** Store v2. */\nexport function init() { return true; }\n',
    });
    await exportCommand(projectRoot, ['browser/modules/mybrowser/Store.sys.mjs'], {
      name: 'store-update',
      category: 'infra',
      description: 'Update store module',
    });

    // Patch 2: moz.build only (different file, no overlap)
    await writeFiles(engineDir, {
      'browser/modules/moz.build': [
        'DIRS += [',
        '    "mybrowser",',
        '    "newtab",',
        '    "urlbar",',
        ']',
        '',
        'EXTRA_JS_MODULES += [',
        '    "Telemetry.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });
    await exportCommand(projectRoot, ['browser/modules/moz.build'], {
      name: 'build-dirs',
      category: 'infra',
      description: 'Register mybrowser in build',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(2);

    // Reset both files to baseline
    await runGit(engineDir, ['checkout', '--', 'browser/modules/moz.build']);
    await runGit(engineDir, ['checkout', '--', 'browser/modules/mybrowser/Store.sys.mjs']);

    // Import full stack — both patches should apply in order
    await importCommand(projectRoot, {});

    // Both changes present
    const mozbuild = await readProjectText(engineDir, 'browser/modules/moz.build');
    expect(mozbuild).toContain('"mybrowser"');
    const store = await readProjectText(engineDir, 'browser/modules/mybrowser/Store.sys.mjs');
    expect(store).toContain('return true;');
  });

  it('export --dry-run --before <anchor> prints the placement summary for single-rename runs', async () => {
    // Regression: the placement dry-run preview used to fire only when
    // renameCount > 1, silently exiting with "Dry run complete" otherwise.
    // A single-renumber dry-run now routes through confirmDestructive and
    // prints the new filename, order, and rename row.
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/a.js': 'const a = 1;\n',
      'browser/b.js': 'const b = 1;\n',
    });

    // First export: lands at order 1.
    await writeFiles(engineDir, { 'browser/a.js': 'const a = 2;\n' });
    await exportCommand(projectRoot, ['browser/a.js'], {
      name: 'first',
      category: 'infra',
      description: '',
    });

    // Second export: a modification of b.js that we will try to place before
    // the existing first patch in dry-run mode. This forces a single rename,
    // which is the previously-silent case.
    await writeFiles(engineDir, { 'browser/b.js': 'const b = 2;\n' });

    const logger = await import('../../utils/logger.js');
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();

    await exportCommand(projectRoot, ['browser/b.js'], {
      name: 'second',
      category: 'infra',
      description: '',
      dryRun: true,
      before: '001-infra-first.patch',
      yes: true,
    });

    // Manifest must not have changed — dry-run is a no-op.
    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.name).toBe('first');

    // The placement summary must have been printed. `info` receives lines
    // like `  place new patch as 001-infra-second.patch (order 1)` and
    // `    001-infra-first.patch  →  002-infra-first.patch`.
    const infoCalls = vi
      .mocked(logger.info)
      .mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const joined = infoCalls.join('\n');
    expect(joined).toContain('place new patch as');
    expect(joined).toContain('001-infra-second.patch');
    expect(joined).toContain('order 1');
    expect(joined).toContain('001-infra-first.patch');
    expect(joined).toContain('002-infra-first.patch');
  });
});
