// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadState } from '../../core/config.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { hasActiveRebaseSession, loadRebaseSession } from '../../core/rebase-session.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  git,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { rebaseCommand } from '../rebase.js';
import { setupCommand } from '../setup.js';

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

async function initCommittedRepo(repoDir: string, files: Record<string, string>): Promise<void> {
  const { writeFiles: wf } = await import('../../test-utils/index.js');
  await wf(repoDir, files);
  await git(repoDir, ['init']);
  await git(repoDir, ['config', 'user.email', 'fireforge@example.test']);
  await git(repoDir, ['config', 'user.name', 'FireForge Tests']);
  await git(repoDir, ['add', '-A']);
  await git(repoDir, ['commit', '-m', 'initial']);
}

describe('rebase integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-rebase-integration-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('rebases a clean two-patch stack with version stamp update', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
      'browser/modules/moz.build': 'DIRS += ["newtab"]\n',
    });

    // Export patch 1
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Change title',
    });

    // Export patch 2
    await writeFiles(engineDir, {
      'browser/modules/moz.build': 'DIRS += ["newtab"]\nDIRS += ["mybrowser"]\n',
    });
    await exportCommand(projectRoot, ['browser/modules/moz.build'], {
      name: 'build-dirs',
      category: 'infra',
      description: 'Add mybrowser dir',
    });

    // Verify patches are at current version
    const manifestBefore = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifestBefore?.patches).toHaveLength(2);
    expect(manifestBefore?.patches[0]?.sourceEsrVersion).toBe('140.0esr');

    // "Upgrade" to new version by changing config
    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    // Run rebase — patches should apply cleanly since engine is at post-patch state
    await rebaseCommand(projectRoot, { force: true });

    // Verify version stamps updated
    const manifestAfter = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifestAfter?.patches).toHaveLength(2);
    for (const patch of manifestAfter?.patches ?? []) {
      expect(patch.sourceEsrVersion).toBe('141.0esr');
    }

    // Session should be cleared
    await expect(hasActiveRebaseSession(projectRoot)).resolves.toBe(false);
  });

  it('pauses on a conflicting patch and resumes with --continue', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    // Export a patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Change title',
    });

    // Create a conflicting upstream change: commit a different modification
    // Reset to baseline first, then make a different change
    await git(engineDir, ['checkout', '--', 'browser/base/content/browser.js']);
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "upstream-changed";\n',
    });
    await git(engineDir, ['add', '-A']);
    await git(engineDir, ['commit', '-m', 'upstream change']);

    // Upgrade version
    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    // Rebase — should fail on the patch (context doesn't match)
    await rebaseCommand(projectRoot, { force: true });

    // Session should exist with failed patch
    const session = await loadRebaseSession(projectRoot);
    expect(session).not.toBeNull();
    expect(session?.patches[0]?.status).toBe('failed');

    // pendingResolution should be set
    const state = await loadState(projectRoot);
    expect(state.pendingResolution).toBeDefined();
    expect(state.pendingResolution?.patchFilename).toContain('title-patch');

    // "Fix" the conflict by applying the intended change
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });

    // Continue the rebase
    await rebaseCommand(projectRoot, { continue: true });

    // Session should be cleared (rebase complete)
    await expect(hasActiveRebaseSession(projectRoot)).resolves.toBe(false);

    // pendingResolution should be cleared
    const stateAfter = await loadState(projectRoot);
    expect(stateAfter.pendingResolution).toBeUndefined();

    // Patch should be re-exported with new version
    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches[0]?.sourceEsrVersion).toBe('141.0esr');
  });

  it('aborts a rebase with --abort --force and restores engine state', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    // Export a patch
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Change title',
    });

    // Create conflict
    await git(engineDir, ['checkout', '--', 'browser/base/content/browser.js']);
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "upstream-changed";\n',
    });
    await git(engineDir, ['add', '-A']);
    await git(engineDir, ['commit', '-m', 'upstream change']);

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    // Start rebase — fails on conflict
    await rebaseCommand(projectRoot, { force: true });
    expect(await hasActiveRebaseSession(projectRoot)).toBe(true);

    // Abort
    await rebaseCommand(projectRoot, { abort: true, force: true });

    // Session should be cleared
    expect(await hasActiveRebaseSession(projectRoot)).toBe(false);

    // pendingResolution should be cleared
    const state = await loadState(projectRoot);
    expect(state.pendingResolution).toBeUndefined();
  });

  it('skips rebase when patches already match the current version', async () => {
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "baseline";\n',
    });

    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "patched";\n',
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Change title',
    });

    // DON'T change the version — rebase should say "not needed"
    await rebaseCommand(projectRoot, { force: true });

    // No session should be created
    expect(await hasActiveRebaseSession(projectRoot)).toBe(false);
  });
});
