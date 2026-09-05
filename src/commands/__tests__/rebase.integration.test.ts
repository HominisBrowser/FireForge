// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadState } from '../../core/config.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { getRebaseSessionPath, readRebaseSession } from '../../core/rebase-session.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  removeTempProject,
  runGit,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { escapeRegex } from '../../utils/regex.js';
import { exportCommand } from '../export.js';
import { rebaseCommand } from '../rebase/index.js';
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

async function initCommittedRepo(repoDir: string, files: Record<string, string>): Promise<void> {
  const { writeFiles: wf } = await import('../../test-utils/index.js');
  await wf(repoDir, files);
  await runGit(repoDir, ['init']);
  await runGit(repoDir, ['config', 'user.email', 'fireforge@example.test']);
  await runGit(repoDir, ['config', 'user.name', 'FireForge Tests']);
  await runGit(repoDir, ['add', '-A']);
  await runGit(repoDir, ['commit', '-m', 'initial']);
}

/**
 * Whether a rebase session file exists on disk.
 *
 * Local to these tests: production reads `readRebaseSession` once, so
 * liveness and validity come from the same read and no shared helper is
 * needed.
 */
async function sessionFileExists(projectRoot: string): Promise<boolean> {
  return await pathExists(getRebaseSessionPath(projectRoot));
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
    expect(manifestBefore?.patches[0]?.sourceEsrVersion).toBe('140.9.0esr');

    // "Upgrade" to new version by changing config
    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    // Run rebase. Patches should apply cleanly since engine is at post-patch state
    await rebaseCommand(projectRoot, { yes: true });

    // Verify version stamps updated
    const manifestAfter = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifestAfter?.patches).toHaveLength(2);
    for (const patch of manifestAfter?.patches ?? []) {
      expect(patch.sourceEsrVersion).toBe('141.0esr');
    }

    // Session should be cleared
    await expect(sessionFileExists(projectRoot)).resolves.toBe(false);
  });

  it('absorbs upstream context drift via git apply -C (fuzz-like) instead of conflicting', async () => {
    // End-to-end guard for the context-reduction path against real git.
    // The original --fuzz=N implementation could never succeed here (git
    // has no --fuzz flag), so every drifted patch surfaced as a manual
    // conflict. Only mocked unit tests kept the feature looking alive.
    const { warn } = await import('../../utils/logger.js');
    const engineDir = join(projectRoot, 'engine');
    const contextFile = [
      'line-a',
      'line-b',
      'line-c',
      'export const title = "baseline";',
      'line-d',
      'line-e',
      'line-f',
      '',
    ].join('\n');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': contextFile,
    });

    await writeFiles(engineDir, {
      'browser/base/content/browser.js': contextFile.replace('"baseline"', '"patched"'),
    });
    await exportCommand(projectRoot, ['browser/base/content/browser.js'], {
      name: 'title-patch',
      category: 'ui',
      description: 'Change title',
    });

    // Simulate the upstream Firefox update: outermost context lines drift
    // (line-a / line-f change), the patched line itself stays put. Commit
    // as the new baseline the rebase will reset to.
    await runGit(engineDir, ['checkout', '--', '.']);
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': contextFile
        .replace('line-a', 'line-a-drifted-upstream')
        .replace('line-f', 'line-f-drifted-upstream'),
    });
    await runGit(engineDir, ['add', '-A']);
    await runGit(engineDir, ['commit', '-m', 'upstream update']);

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    await rebaseCommand(projectRoot, { yes: true });

    // The patch landed despite the drift, via reduced context...
    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('applied with context reduction')
    );
    // ...the engine contains the patched line...
    const { readFile } = await import('node:fs/promises');
    const rebasedContent = await readFile(
      join(engineDir, 'browser/base/content/browser.js'),
      'utf-8'
    );
    expect(rebasedContent).toContain('"patched"');
    expect(rebasedContent).toContain('line-a-drifted-upstream');
    // ...versions were stamped and the session cleared (full success path).
    const manifestAfter = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifestAfter?.patches[0]?.sourceEsrVersion).toBe('141.0esr');
    await expect(sessionFileExists(projectRoot)).resolves.toBe(false);
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
    await runGit(engineDir, ['checkout', '--', 'browser/base/content/browser.js']);
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "upstream-changed";\n',
    });
    await runGit(engineDir, ['add', '-A']);
    await runGit(engineDir, ['commit', '-m', 'upstream change']);

    // Upgrade version
    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    // Rebase should fail on the patch (context doesn't match)
    await rebaseCommand(projectRoot, { yes: true });

    // Session should exist with failed patch
    const read = await readRebaseSession(projectRoot);
    expect(read.present).toBe(true);
    const session = read.present && read.valid ? read.session : undefined;
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
    await expect(sessionFileExists(projectRoot)).resolves.toBe(false);

    // pendingResolution should be cleared
    const stateAfter = await loadState(projectRoot);
    expect(stateAfter.pendingResolution).toBeUndefined();

    // Patch should be re-exported with new version
    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches[0]?.sourceEsrVersion).toBe('141.0esr');
  });

  it('aborts a rebase with --abort --yes and restores engine state', async () => {
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
    await runGit(engineDir, ['checkout', '--', 'browser/base/content/browser.js']);
    await writeFiles(engineDir, {
      'browser/base/content/browser.js': 'export const title = "upstream-changed";\n',
    });
    await runGit(engineDir, ['add', '-A']);
    await runGit(engineDir, ['commit', '-m', 'upstream change']);

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '141.0esr', product: 'firefox-esr' },
    });

    // Start rebase, which fails on conflict
    await rebaseCommand(projectRoot, { yes: true });
    expect(await sessionFileExists(projectRoot)).toBe(true);

    // Abort
    await rebaseCommand(projectRoot, { abort: true, yes: true });

    // Session should be cleared
    expect(await sessionFileExists(projectRoot)).toBe(false);

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

    // Don't change the version. Rebase should say "not needed"
    await rebaseCommand(projectRoot, { yes: true });

    // No session should be created
    expect(await sessionFileExists(projectRoot)).toBe(false);
  });

  it('recovers from a corrupt session file instead of wedging', async () => {
    // The wedge: with an unreadable session file, `rebase` reported that a
    // rebase was already in progress and to use --continue or --abort, and
    // both of those reported "no rebase session in progress". No CLI path
    // deleted the file and no message named it, so the only escape was
    // knowing to rm it by hand.
    const engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'export const title = "upstream";\n',
    });
    await writeFiles(projectRoot, { 'patches/patches.json': '{"version":1,"patches":[]}\n' });

    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(projectRoot, '.fireforge'), { recursive: true });
    const sessionFile = getRebaseSessionPath(projectRoot);
    await writeFile(sessionFile, '{ "startedAt": "2026-01-01", ', 'utf-8');

    // A fresh start names the file and points at --abort, rather than
    // claiming a resumable rebase is in progress.
    await expect(rebaseCommand(projectRoot, { yes: true })).rejects.toThrow(
      /cannot be read[\s\S]*--abort/
    );
    await expect(rebaseCommand(projectRoot, { yes: true })).rejects.toThrow(
      new RegExp(escapeRegex(sessionFile))
    );

    // --continue reports the corruption rather than "no session in progress".
    await expect(rebaseCommand(projectRoot, { continue: true, yes: true })).rejects.toThrow(
      /cannot be read/
    );

    // --abort is the escape hatch and must succeed against the corrupt file.
    await rebaseCommand(projectRoot, { abort: true, yes: true });
    expect(await sessionFileExists(projectRoot)).toBe(false);

    // And a fresh rebase is no longer blocked by the session check: it now
    // reaches the manifest, failing on the empty queue instead of claiming a
    // rebase is already in progress.
    await expect(rebaseCommand(projectRoot, { yes: true })).rejects.toThrow(
      /No patches found in manifest/
    );
  });
});
