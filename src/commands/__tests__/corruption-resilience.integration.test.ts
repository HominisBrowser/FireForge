// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadState } from '../../core/config.js';
import { validatePatchesManifestConsistency } from '../../core/patch-manifest.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { importCommand } from '../import.js';
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

describe('corruption resilience integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-corruption-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('import detects corrupted patches.json and refuses to apply', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    // Export a valid patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Patch',
    });

    // Corrupt patches.json with invalid JSON
    await writeFiles(projectRoot, {
      'patches/patches.json': '{ invalid json <<< truncated',
    });

    // Reset engine
    const { runGit } = await import('../../test-utils/index.js');
    await runGit(engineDir, ['checkout', '--', 'browser/base/content/browser.js']);

    // Import should fail due to manifest corruption
    await expect(importCommand(projectRoot, {})).rejects.toThrow();
  });

  it('export refuses to run over a corrupted patches.json and leaves it untouched', async () => {
    // `loadPatchesManifest` collapsing "corrupt" into "absent" makes an
    // export over a hand-mangled patches.json rebuild the manifest
    // containing ONLY the new patch — silently destroying every other
    // patch's metadata — and a failing export's rollback then deletes
    // patches.json outright, because the "before" state looked absent.
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
      'browser/base/content/other.js': 'export const other = 1;\n',
    });

    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Patch',
    });

    const corruptContent = '{ invalid json <<< hand-edit typo';
    await writeFiles(projectRoot, {
      'patches/patches.json': corruptContent,
    });

    // A second export must abort with the typed corruption error...
    await writeFiles(engineDir, {
      'browser/base/content/other.js': 'export const other = 2;\n',
    });
    await expect(
      exportCommand(projectRoot, ['browser/base/content/other.js'], {
        name: 'other-patch',
        category: 'ui',
        description: 'Second patch',
      })
    ).rejects.toThrow(/patches\.json exists but could not be parsed/);

    // ...and the corrupt manifest must still be on disk, byte-identical —
    // neither rebuilt-as-empty nor deleted by a rollback.
    const manifestAfter = await readProjectText(projectRoot, 'patches/patches.json');
    expect(manifestAfter).toBe(corruptContent);
  });

  it('validatePatchesManifestConsistency detects invalid manifest JSON', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    // Export a valid patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Patch',
    });

    // Corrupt the manifest
    await writeFiles(projectRoot, {
      'patches/patches.json': '{{{not json',
    });

    const issues = await validatePatchesManifestConsistency(join(projectRoot, 'patches'));
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]?.code).toBe('manifest-invalid');
  });

  it('validatePatchesManifestConsistency detects missing manifest with patches on disk', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    // Export a valid patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Patch',
    });

    // Delete the manifest but leave the patch file
    const { rm } = await import('node:fs/promises');
    await rm(join(projectRoot, 'patches/patches.json'));

    const issues = await validatePatchesManifestConsistency(join(projectRoot, 'patches'));
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]?.code).toBe('manifest-missing');
  });

  it('validatePatchesManifestConsistency detects filesAffected mismatch', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    // Export a valid patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Patch',
    });

    // Tamper: change filesAffected to a wrong value
    const manifestContent = await readProjectText(projectRoot, 'patches/patches.json');
    const manifest = JSON.parse(manifestContent) as { patches: Array<{ filesAffected: string[] }> };
    const firstPatch = manifest.patches[0];
    if (firstPatch) firstPatch.filesAffected = ['browser/nonexistent/file.js'];
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify(manifest, null, 2) + '\n',
    });

    const issues = await validatePatchesManifestConsistency(join(projectRoot, 'patches'));
    expect(issues.some((i) => i.code === 'files-affected-mismatch')).toBe(true);
  });

  it('state.json loads cleanly after setup with no corruption', async () => {
    // Fresh project state should load without issues
    const state = await loadState(projectRoot);
    expect(state).toBeDefined();
    expect(state.pendingResolution).toBeUndefined();
  });

  it('corrupted state.json is recovered gracefully', async () => {
    // Write partial/corrupted state
    await writeFiles(projectRoot, {
      '.fireforge/state.json': '{ "baseCommit": "abc123", "bogus',
    });

    // loadState should recover — it sanitizes and quarantines corrupt state
    const state = await loadState(projectRoot);
    // Should return a valid state object (recovered or default)
    expect(state).toBeDefined();
  });
});
