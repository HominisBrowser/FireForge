// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import * as prompts from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadState, saveState } from '../../core/config.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  git,
  initCommittedRepo,
  readText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { importCommand } from '../import.js';
import { resolveCommand } from '../resolve.js';
import { setupCommand } from '../setup.js';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  note: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
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

describe('resolve integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject('fireforge-resolve-integration-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('resolves a multi-file conflict and updates the patch', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "old";\n',
      'browser/modules/sidebar.js': 'export const visible = false;\n',
    });

    // Export a multi-file patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
      'browser/modules/sidebar.js': 'export const visible = true;\n',
    });
    await exportCommand(
      projectRoot,
      ['browser/base/content/browser.js', 'browser/modules/sidebar.js'],
      { name: 'multi-file-change', category: 'ui', description: 'Two-file patch' }
    );

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();

    // Reset engine, introduce a conflicting upstream change, then try to import
    await git(engineDir, ['checkout', '--', '.']);
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "upstream";\n',
    });
    await git(engineDir, ['add', '-A']);
    await git(engineDir, ['commit', '-m', 'upstream change']);

    // Import fails — sets pendingResolution
    await expect(importCommand(projectRoot, { force: true })).rejects.toThrow();

    const stateBefore = await loadState(projectRoot);
    expect(stateBefore.pendingResolution).toBeDefined();
    expect(stateBefore.pendingResolution?.patchFilename).toBe(patchFilename);

    // Manually fix both files (simulating user resolution)
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
      'browser/modules/sidebar.js': 'export const visible = true;\n',
    });

    // Resolve
    await resolveCommand(projectRoot);

    // pendingResolution cleared
    const stateAfter = await loadState(projectRoot);
    expect(stateAfter.pendingResolution).toBeUndefined();

    // Patch updated — should contain both files
    const patchContent = await readText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('+++ b/browser/base/content/browser.js');
    expect(patchContent).toContain('+++ b/browser/modules/sidebar.js');
  });

  it('resolves with a partially deleted file and updates filesAffected', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "old";\n',
      'browser/modules/sidebar.js': 'export const visible = false;\n',
    });

    // Export multi-file patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
      'browser/modules/sidebar.js': 'export const visible = true;\n',
    });
    await exportCommand(
      projectRoot,
      ['browser/base/content/browser.js', 'browser/modules/sidebar.js'],
      { name: 'multi-file', category: 'ui', description: 'Two files' }
    );

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    const patchFilename = manifest?.patches[0]?.filename;

    // Set up pendingResolution manually (simulating a failed import)
    const state = await loadState(projectRoot);
    state.pendingResolution = {
      patchFilename: patchFilename ?? '',
      originalError: 'Simulated conflict',
    };
    await saveState(projectRoot, state);

    // Delete one of the affected files (simulating upstream removal)
    await git(engineDir, ['rm', '-f', 'browser/modules/sidebar.js']);
    await git(engineDir, ['commit', '-m', 'remove sidebar']);

    // Fix the remaining file
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "resolved";\n',
    });

    // Resolve — should update filesAffected to only the surviving file
    await resolveCommand(projectRoot);

    const stateAfter = await loadState(projectRoot);
    expect(stateAfter.pendingResolution).toBeUndefined();

    const manifestAfter = await loadPatchesManifest(join(projectRoot, 'patches'));
    const updatedPatch = manifestAfter?.patches.find((p) => p.filename === patchFilename);
    expect(updatedPatch?.filesAffected).toEqual(['browser/base/content/browser.js']);
  });

  it('exits cleanly when no pending resolution exists', async () => {
    restoreTTY = setInteractiveMode(true);
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "ok";\n',
    });

    // No pending resolution — should exit cleanly
    await expect(resolveCommand(projectRoot)).resolves.toBeUndefined();
  });
});
