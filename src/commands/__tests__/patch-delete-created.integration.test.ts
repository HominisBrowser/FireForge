// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch delete` and `patch retire` with created files still on disk: the
 * summary says which files will be left unmanaged, and `--delete-created`
 * removes them with the patch.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HISTORY_LOG_PATH } from '../../core/history-log-file.js';
import {
  createTempProject,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir, pathExists } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import { patchDeleteCommand } from '../patch/delete.js';
import { patchRetireCommand } from '../patch/retire.js';

vi.mock('../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger.js')>()),
  info: vi.fn(),
}));

function meta(files: string[]): PatchMetadata {
  return {
    filename: '001-ui-widget.patch',
    order: 1,
    category: 'ui',
    name: 'widget',
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: files,
  };
}

const BODY = [
  'diff --git a/ui/New.sys.mjs b/ui/New.sys.mjs',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/ui/New.sys.mjs',
  '@@ -0,0 +1 @@',
  '+export const N = 1;',
  'diff --git a/ui/Gone.sys.mjs b/ui/Gone.sys.mjs',
  'new file mode 100644',
  'index 0000000..2222222',
  '--- /dev/null',
  '+++ b/ui/Gone.sys.mjs',
  '@@ -0,0 +1 @@',
  '+export const G = 1;',
  'diff --git a/ui/Existing.js b/ui/Existing.js',
  'index 3333333..4444444 100644',
  '--- a/ui/Existing.js',
  '+++ b/ui/Existing.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const FILES = ['ui/New.sys.mjs', 'ui/Gone.sys.mjs', 'ui/Existing.js'];

describe('patch delete / retire and created files on disk', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-delete-created-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '001-ui-widget.patch'), BODY);
    const manifest: PatchesManifest = { version: 1, patches: [meta(FILES)] };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
    await writeFiles(join(projectRoot, 'engine'), {
      'ui/New.sys.mjs': 'export const N = 1;\n',
      'ui/Existing.js': 'new\n',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    restoreTTY = setInteractiveMode(false);
    vi.mocked(info).mockClear();
  });
  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  function printed(): string {
    return vi
      .mocked(info)
      .mock.calls.map((call) => call[0])
      .join('\n');
  }

  it('names each created file still on disk in the dry run', async () => {
    await patchDeleteCommand(projectRoot, '1', { dryRun: true });

    const out = printed();
    expect(out).toContain('ui/New.sys.mjs  → created by this patch and still on disk');
    expect(out).toContain('ui/Gone.sys.mjs  → created by this patch; already gone');
    expect(out).toContain('ui/Existing.js  → will become unmanaged');
    expect(out).toContain('1 created file(s) are still on disk');
    expect(await pathExists(join(patchesDir, '001-ui-widget.patch'))).toBe(true);
  });

  it('leaves the created file in place without --delete-created', async () => {
    await patchDeleteCommand(projectRoot, '1', { yes: true });

    expect(await pathExists(join(patchesDir, '001-ui-widget.patch'))).toBe(false);
    expect(await pathExists(join(projectRoot, 'engine/ui/New.sys.mjs'))).toBe(true);
  });

  it('delete --delete-created removes only the created files still on disk', async () => {
    await patchDeleteCommand(projectRoot, '1', { yes: true, deleteCreated: true });

    expect(await pathExists(join(projectRoot, 'engine/ui/New.sys.mjs'))).toBe(false);
    expect(await pathExists(join(projectRoot, 'engine/ui/Existing.js'))).toBe(true);
    const history = JSON.parse(
      (await readFile(join(projectRoot, DEFAULT_HISTORY_LOG_PATH), 'utf8')).trim()
    ) as { args: { deletedCreatedFiles?: string[] } };
    expect(history.args.deletedCreatedFiles).toEqual(['ui/New.sys.mjs']);
  });

  it('retire --delete-created removes them too and keeps the slot', async () => {
    await patchRetireCommand(projectRoot, '1', { yes: true, deleteCreated: true });

    expect(await pathExists(join(projectRoot, 'engine/ui/New.sys.mjs'))).toBe(false);
    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf8')
    ) as PatchesManifest;
    expect(manifest.retired?.map((slot) => slot.order)).toEqual([1]);
  });

  it('a dry run with --delete-created says what it would delete and deletes nothing', async () => {
    await patchRetireCommand(projectRoot, '1', { dryRun: true, deleteCreated: true });

    expect(printed()).toContain('ui/New.sys.mjs  → created by this patch; will be deleted');
    expect(await pathExists(join(projectRoot, 'engine/ui/New.sys.mjs'))).toBe(true);
  });
});
