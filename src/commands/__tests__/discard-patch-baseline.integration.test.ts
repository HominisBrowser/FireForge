// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge discard` on a patch-claimed path must restore the
 * patch-applied baseline rather than pristine upstream HEAD, and must
 * re-materialize (not delete) patch-created files. A purely git-mechanical
 * discard prints "File restored to original state" while reverting engine
 * files past their owning patch and deleting patch-created files outright.
 *
 * Real temp repo. The patch queue is applied through the production
 * `applyPatchesWithContinue` path so the worktree convention (patch edits =
 * unstaged ` M`, patch creations = `??`) is authentic.
 */

import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyPatchesWithContinue } from '../../core/patch-apply.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  runGit,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { discardCommand } from '../discard.js';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  warn: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  verbose: vi.fn(),
  success: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

const TRACKED = 'browser/base/tracked.txt';
const CREATED = 'browser/base/hominis-start.html';
const UPSTREAM_CONTENT = 'upstream line\n';
const PATCHED_CONTENT = 'upstream line\nhominis line\n';
const CREATED_CONTENT = '<html>\n</html>\n';

const EDIT_PATCH = [
  `diff --git a/${TRACKED} b/${TRACKED}`,
  '--- a/' + TRACKED,
  '+++ b/' + TRACKED,
  '@@ -1 +1,2 @@',
  ' upstream line',
  '+hominis line',
  '',
].join('\n');

const CREATE_PATCH = [
  `diff --git a/${CREATED} b/${CREATED}`,
  'new file mode 100644',
  '--- /dev/null',
  `+++ b/${CREATED}`,
  '@@ -0,0 +1,2 @@',
  '+<html>',
  '+</html>',
  '',
].join('\n');

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('discard restores the patch-applied baseline', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-discard-baseline-');
    await writeFireForgeConfig(projectRoot);
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');

    await initCommittedRepo(engineDir, { [TRACKED]: UPSTREAM_CONTENT });

    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '0001-ui-edit.patch'), EDIT_PATCH);
    await writeFile(join(patchesDir, '0002-ui-create.patch'), CREATE_PATCH);
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makeMetadata('0001-ui-edit.patch', 1, [TRACKED]),
        makeMetadata('0002-ui-create.patch', 2, [CREATED]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));

    const summary = await applyPatchesWithContinue(patchesDir, engineDir);
    expect(summary.failed).toHaveLength(0);
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('restores a dirty patch-edited file to the patch-applied content, not upstream', async () => {
    await writeFiles(engineDir, { [TRACKED]: 'garbage edit\n' });

    await discardCommand(projectRoot, TRACKED, { yes: true });

    expect(await readProjectText(projectRoot, `engine/${TRACKED}`)).toBe(PATCHED_CONTENT);
    // Worktree convention preserved: patch edit stays an unstaged modification.
    const status = await runGit(engineDir, ['status', '--short']);
    expect(status).toContain(`M ${TRACKED}`);
    expect(logger.outro).toHaveBeenCalledWith(
      'File restored to patch baseline (0001-ui-edit.patch)'
    );
  });

  it('re-materializes a dirty patch-created file instead of deleting it', async () => {
    await writeFiles(engineDir, { [CREATED]: 'clobbered\n' });

    await discardCommand(projectRoot, CREATED, { yes: true });

    expect(await fileExists(join(engineDir, CREATED))).toBe(true);
    expect(await readProjectText(projectRoot, `engine/${CREATED}`)).toBe(CREATED_CONTENT);
    // Created files stay untracked, matching the post-import state.
    const status = await runGit(engineDir, ['status', '--short']);
    expect(status).toContain(`?? ${CREATED}`);
    expect(logger.outro).toHaveBeenCalledWith(
      'File re-materialized from patch baseline (0002-ui-create.patch)'
    );
  });

  it('--to-upstream restores pristine HEAD and deletes the patch-created file', async () => {
    await writeFiles(engineDir, { [TRACKED]: 'garbage edit\n' });

    await discardCommand(projectRoot, TRACKED, { yes: true, toUpstream: true });
    expect(await readProjectText(projectRoot, `engine/${TRACKED}`)).toBe(UPSTREAM_CONTENT);
    expect(logger.outro).toHaveBeenCalledWith('File restored to pristine upstream (HEAD)');

    await discardCommand(projectRoot, CREATED, { yes: true, toUpstream: true });
    expect(await fileExists(join(engineDir, CREATED))).toBe(false);
  });

  it('restores a staged patch-edited file to an unstaged patch baseline', async () => {
    await writeFiles(engineDir, { [TRACKED]: 'garbage edit\n' });
    await runGit(engineDir, ['add', TRACKED]);

    await discardCommand(projectRoot, TRACKED, { yes: true });

    expect(await readProjectText(projectRoot, `engine/${TRACKED}`)).toBe(PATCHED_CONTENT);
    const status = await runGit(engineDir, ['status', '--short']);
    // Unstaged modification (worktree column M, index clean). The other
    // line is the still-untracked patch-created file from setup.
    expect(status).toContain(` M ${TRACKED}`);
    expect(status).not.toContain(`M  ${TRACKED}`);
  });

  it('directory mode applies the per-file rule and summarizes the baselines', async () => {
    await writeFiles(engineDir, {
      [TRACKED]: 'garbage edit\n',
      [CREATED]: 'clobbered\n',
    });

    await discardCommand(projectRoot, 'browser/base', { yes: true });

    expect(await readProjectText(projectRoot, `engine/${TRACKED}`)).toBe(PATCHED_CONTENT);
    expect(await readProjectText(projectRoot, `engine/${CREATED}`)).toBe(CREATED_CONTENT);
    expect(logger.outro).toHaveBeenCalledWith(
      '2 file(s) restored: 1 to patch baseline, 1 re-materialized'
    );
  });

  it('dry-run distinguishes patch-backed and patch-created targets', async () => {
    await writeFiles(engineDir, {
      [TRACKED]: 'garbage edit\n',
      [CREATED]: 'clobbered\n',
    });

    await discardCommand(projectRoot, 'browser/base', { dryRun: true });

    const lines = logger.info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(`${TRACKED} (patch baseline: 0001-ui-edit.patch)`))).toBe(
      true
    );
    expect(
      lines.some((l) => l.includes(`${CREATED} (re-materialize from 0002-ui-create.patch)`))
    ).toBe(true);
    // Dry run stays read-only.
    expect(await readProjectText(projectRoot, `engine/${CREATED}`)).toBe('clobbered\n');
  });

  it('warns on multi-owner (conflicted) claims but still restores the cumulative baseline', async () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makeMetadata('0001-ui-edit.patch', 1, [TRACKED]),
        makeMetadata('0002-ui-create.patch', 2, [CREATED, TRACKED]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
    await writeFiles(engineDir, { [TRACKED]: 'garbage edit\n' });

    await discardCommand(projectRoot, TRACKED, { yes: true });

    expect(await readProjectText(projectRoot, `engine/${TRACKED}`)).toBe(PATCHED_CONTENT);
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('claimed by 2 patches'));
  });

  it('refuses (rather than reverting to upstream) when the manifest is unreadable', async () => {
    await writeFile(join(patchesDir, 'patches.json'), '{ not json');
    await writeFiles(engineDir, { [TRACKED]: 'garbage edit\n' });

    await expect(discardCommand(projectRoot, TRACKED, { yes: true })).rejects.toThrow(
      /patches\.json is unreadable.*--to-upstream/s
    );
    // Nothing was touched.
    expect(await readProjectText(projectRoot, `engine/${TRACKED}`)).toBe('garbage edit\n');
  });
});
