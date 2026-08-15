// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `fireforge patch rename`. Pins the contract
 * that the filename change, manifest mutation, and history append
 * happen together — without these tests the only way to verify the
 * "filename is renamed on disk and the manifest stays in sync" path
 * is to drive the CLI manually, which is exactly the brittle workflow
 * this verb was added to replace.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_LOG_FILENAME } from '../../core/destructive.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import { patchRenameCommand } from '../patch/rename.js';

vi.mock('../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger.js')>()),
  info: vi.fn(),
}));

function makeMetadata(
  filename: string,
  order: number,
  filesAffected: string[],
  extras: Partial<PatchMetadata> = {}
): PatchMetadata {
  return {
    filename,
    order,
    category: 'infra',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-04-30T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
    ...extras,
  };
}

async function seed(
  patchesDir: string,
  patches: PatchMetadata[],
  bodyByFilename: Record<string, string> = {}
): Promise<void> {
  await ensureDir(patchesDir);
  for (const p of patches) {
    const body = bodyByFilename[p.filename] ?? `# stub body for ${p.filename}\n`;
    await writeFile(join(patchesDir, p.filename), body);
  }
  const manifest: PatchesManifest = { version: 1, patches };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function loadManifest(patchesDir: string): Promise<PatchesManifest> {
  const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
  return JSON.parse(raw) as PatchesManifest;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('patch rename', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pr-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  describe('--category / --order (FORGE J10)', () => {
    it('recategorises in one transaction: filename prefix + manifest row', async () => {
      await seed(patchesDir, [makeMetadata('010-infra-widget.patch', 10, ['a.js'])]);

      await patchRenameCommand(projectRoot, '010-infra-widget.patch', {
        category: 'ui',
        yes: true,
      });

      expect(await fileExists(join(patchesDir, '010-infra-widget.patch'))).toBe(false);
      expect(await fileExists(join(patchesDir, '010-ui-widget.patch'))).toBe(true);
      const manifest = await loadManifest(patchesDir);
      expect(manifest.patches[0]).toMatchObject({
        filename: '010-ui-widget.patch',
        category: 'ui',
        order: 10,
        name: 'widget',
      });
    });

    it('moves the patch to an exact unused order, preserving zero-padding', async () => {
      await seed(patchesDir, [makeMetadata('010-infra-widget.patch', 10, ['a.js'])]);

      await patchRenameCommand(projectRoot, '010-infra-widget.patch', { order: 25, yes: true });

      expect(await fileExists(join(patchesDir, '025-infra-widget.patch'))).toBe(true);
      const manifest = await loadManifest(patchesDir);
      expect(manifest.patches[0]).toMatchObject({
        filename: '025-infra-widget.patch',
        order: 25,
        category: 'infra',
      });
    });

    it('changes category, order, name, and description together', async () => {
      await seed(patchesDir, [makeMetadata('010-infra-widget.patch', 10, ['a.js'])]);

      await patchRenameCommand(projectRoot, '010-infra-widget.patch', {
        to: 'dock-widget',
        category: 'ui',
        order: 30,
        description: 'Dock widget work',
        yes: true,
      });

      const manifest = await loadManifest(patchesDir);
      expect(manifest.patches[0]).toMatchObject({
        filename: '030-ui-dock-widget.patch',
        category: 'ui',
        order: 30,
        name: 'dock-widget',
        description: 'Dock widget work',
      });
      expect(await fileExists(join(patchesDir, '030-ui-dock-widget.patch'))).toBe(true);
    });

    it('refuses an order collision with a pointer to patch reorder', async () => {
      await seed(patchesDir, [
        makeMetadata('010-infra-widget.patch', 10, ['a.js']),
        makeMetadata('020-infra-other.patch', 20, ['b.js']),
      ]);

      await expect(
        patchRenameCommand(projectRoot, '010-infra-widget.patch', { order: 20, yes: true })
      ).rejects.toThrow(/already used by 020-infra-other\.patch.*patch reorder/s);
      expect(await fileExists(join(patchesDir, '010-infra-widget.patch'))).toBe(true);
    });

    it('rejects a category outside the configured set', async () => {
      await seed(patchesDir, [makeMetadata('010-infra-widget.patch', 10, ['a.js'])]);

      await expect(
        patchRenameCommand(projectRoot, '010-infra-widget.patch', {
          category: 'nonsense',
          yes: true,
        })
      ).rejects.toThrow(/Invalid category\. Must be one of:/);
    });

    it('refuses an order change that would introduce a forward-import error', async () => {
      // 010 creates Helper.sys.mjs; 020 imports it. Moving the creator
      // after the importer must be refused with the projected error named.
      const creatorBody = [
        'diff --git a/foo/Helper.sys.mjs b/foo/Helper.sys.mjs',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/foo/Helper.sys.mjs',
        '@@ -0,0 +1,1 @@',
        '+export const H = 1;',
        '',
      ].join('\n');
      const importerBody = [
        'diff --git a/foo/A.sys.mjs b/foo/A.sys.mjs',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/foo/A.sys.mjs',
        '@@ -0,0 +1,2 @@',
        '+import { H } from "resource:///modules/Helper.sys.mjs";',
        '+export const A = H;',
        '',
      ].join('\n');
      await seed(
        patchesDir,
        [
          makeMetadata('010-infra-helper.patch', 10, ['foo/Helper.sys.mjs']),
          makeMetadata('020-infra-importer.patch', 20, ['foo/A.sys.mjs']),
        ],
        {
          '010-infra-helper.patch': creatorBody,
          '020-infra-importer.patch': importerBody,
        }
      );

      await expect(
        patchRenameCommand(projectRoot, '010-infra-helper.patch', { order: 30, yes: true })
      ).rejects.toThrow(/\[forward-import\]/);
      expect(await fileExists(join(patchesDir, '010-infra-helper.patch'))).toBe(true);
    });

    it('supports --dry-run without writing', async () => {
      await seed(patchesDir, [makeMetadata('010-infra-widget.patch', 10, ['a.js'])]);

      await patchRenameCommand(projectRoot, '010-infra-widget.patch', {
        category: 'ui',
        order: 25,
        dryRun: true,
      });

      expect(await fileExists(join(patchesDir, '010-infra-widget.patch'))).toBe(true);
      const manifest = await loadManifest(patchesDir);
      expect(manifest.patches[0]?.category).toBe('infra');
      expect(manifest.patches[0]?.order).toBe(10);
    });
  });

  it('renames the .patch file on disk and updates manifest filename + name', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-mybrowser-dock-widgets.patch', 44, ['a.js'])]);

    await patchRenameCommand(projectRoot, '0044-ui-mybrowser-dock-widgets.patch', {
      to: 'mybrowser-dock-primitive-widgets',
      yes: true,
    });

    expect(await fileExists(join(patchesDir, '0044-ui-mybrowser-dock-widgets.patch'))).toBe(false);
    expect(
      await fileExists(join(patchesDir, '0044-ui-mybrowser-dock-primitive-widgets.patch'))
    ).toBe(true);

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.filename).toBe('0044-ui-mybrowser-dock-primitive-widgets.patch');
    expect(manifest.patches[0]?.name).toBe('mybrowser-dock-primitive-widgets');
  });

  it('updates the description when --description is supplied', async () => {
    await seed(patchesDir, [
      makeMetadata('0044-ui-foo.patch', 44, ['a.js'], { description: 'old description' }),
    ]);

    await patchRenameCommand(projectRoot, '0044-ui-foo.patch', {
      to: 'foo',
      description: 'new description',
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.description).toBe('new description');
  });

  it('rejects empty descriptions when patchPolicy requires descriptions', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        requireDescription: true,
        ranges: [{ from: 1, to: 99, category: 'ui' }],
      },
    });
    await seed(patchesDir, [makeMetadata('044-ui-foo.patch', 44, ['a.js'], { category: 'ui' })]);

    await expect(
      patchRenameCommand(projectRoot, '044-ui-foo.patch', { to: 'bar', yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(await fileExists(join(patchesDir, '044-ui-foo.patch'))).toBe(true);
    expect(await fileExists(join(patchesDir, '044-ui-bar.patch'))).toBe(false);
  });

  it('accepts a supplied non-empty description when policy requires one', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        requireDescription: true,
        ranges: [{ from: 1, to: 99, category: 'ui' }],
      },
    });
    await seed(patchesDir, [makeMetadata('044-ui-foo.patch', 44, ['a.js'], { category: 'ui' })]);

    await patchRenameCommand(projectRoot, '044-ui-foo.patch', {
      to: 'bar',
      description: 'documented rename',
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.filename).toBe('044-ui-bar.patch');
    expect(manifest.patches[0]?.description).toBe('documented rename');
  });

  it('leaves description unchanged when --description is omitted', async () => {
    await seed(patchesDir, [
      makeMetadata('0044-ui-foo.patch', 44, ['a.js'], { description: 'keep me' }),
    ]);

    await patchRenameCommand(projectRoot, '0044-ui-foo.patch', { to: 'bar', yes: true });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.description).toBe('keep me');
  });

  it('preserves the existing ordinal and category prefix', async () => {
    // Operator should never accidentally lose ordering through a rename
    // — the tiebreaker (`(owner.order === entry.order && owner.filename
    // > entry.filename)`) in forward-import depends on it.
    await seed(patchesDir, [makeMetadata('0123-privacy-old-name.patch', 123, ['a.js'])]);

    await patchRenameCommand(projectRoot, '0123-privacy-old-name.patch', {
      to: 'new name with spaces!!',
      yes: true,
    });

    expect(await fileExists(join(patchesDir, '0123-privacy-new-name-with-spaces.patch'))).toBe(
      true
    );
    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.filename).toBe('0123-privacy-new-name-with-spaces.patch');
  });

  it('--dry-run does not rename the file or update the manifest', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-foo.patch', 44, ['a.js'])]);

    await patchRenameCommand(projectRoot, '0044-ui-foo.patch', {
      to: 'bar',
      dryRun: true,
      yes: true,
    });

    expect(await fileExists(join(patchesDir, '0044-ui-foo.patch'))).toBe(true);
    expect(await fileExists(join(patchesDir, '0044-ui-bar.patch'))).toBe(false);
    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.filename).toBe('0044-ui-foo.patch');
  });

  it('refuses when the new filename collides with an existing patch', async () => {
    await seed(patchesDir, [
      makeMetadata('0044-ui-foo.patch', 44, ['a.js']),
      makeMetadata('0044-ui-bar.patch', 44, ['b.js']),
    ]);

    await expect(
      patchRenameCommand(projectRoot, '0044-ui-foo.patch', { to: 'bar', yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    // Both files must remain in place.
    expect(await fileExists(join(patchesDir, '0044-ui-foo.patch'))).toBe(true);
    expect(await fileExists(join(patchesDir, '0044-ui-bar.patch'))).toBe(true);
  });

  it('refuses when --to sanitises to the empty string', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-foo.patch', 44, ['a.js'])]);

    await expect(
      patchRenameCommand(projectRoot, '0044-ui-foo.patch', { to: '!!!', yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('refuses when --to is missing', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-foo.patch', 44, ['a.js'])]);

    await expect(
      patchRenameCommand(projectRoot, '0044-ui-foo.patch', { yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('refuses when the patch identifier does not resolve', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-foo.patch', 44, ['a.js'])]);

    await expect(
      patchRenameCommand(projectRoot, '9999-missing.patch', { to: 'foo', yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('refuses to rename a legacy filename without the canonical prefix', async () => {
    await seed(patchesDir, [
      // Legacy "001-name.patch" shape, no category — splitPatchFilename
      // returns null and the command refuses rather than guess.
      {
        ...makeMetadata('001-foo.patch', 1, ['a.js']),
        filename: '001-foo.patch',
      },
    ]);

    await expect(
      patchRenameCommand(projectRoot, '001-foo.patch', { to: 'bar', yes: true })
    ).rejects.toBeInstanceOf(GeneralError);
  });

  it('reports a no-op when name and description already match', async () => {
    await seed(patchesDir, [
      makeMetadata('0044-ui-foo.patch', 44, ['a.js'], {
        name: 'foo',
        description: 'static',
      }),
    ]);

    // No-op should resolve cleanly without raising.
    await expect(
      patchRenameCommand(projectRoot, '0044-ui-foo.patch', {
        to: 'foo',
        description: 'static',
        yes: true,
      })
    ).resolves.toBeUndefined();

    expect(await fileExists(join(patchesDir, '0044-ui-foo.patch'))).toBe(true);
  });

  it('repairs a double-suffixed filename when --to carries a .patch extension (FORGE F9)', async () => {
    await seed(patchesDir, [
      makeMetadata('0348-ui-editor-panels-patch.patch', 348, ['a.js'], {
        name: 'editor-panels-patch',
      }),
    ]);

    await patchRenameCommand(projectRoot, '0348-ui-editor-panels-patch.patch', {
      to: '348-ui-editor-panels.patch',
      yes: true,
    });

    expect(await fileExists(join(patchesDir, '0348-ui-editor-panels-patch.patch'))).toBe(false);
    expect(await fileExists(join(patchesDir, '0348-ui-editor-panels.patch'))).toBe(true);

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.filename).toBe('0348-ui-editor-panels.patch');
  });

  it('explains why a rename is a no-op instead of a bare "(no-op)" (FORGE F9)', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-foo.patch', 44, ['a.js'], { name: 'foo' })]);

    await patchRenameCommand(projectRoot, '0044-ui-foo.patch', { to: 'foo', yes: true });

    const messages = vi.mocked(info).mock.calls.map((call) => call[0]);
    expect(messages.some((m) => m.includes('nothing to change'))).toBe(true);
    expect(messages.some((m) => m.includes('slug of "foo" is "foo"'))).toBe(true);
  });

  it('appends a history entry on success', async () => {
    await seed(patchesDir, [makeMetadata('0044-ui-foo.patch', 44, ['a.js'])]);

    await patchRenameCommand(projectRoot, '0044-ui-foo.patch', {
      to: 'bar',
      description: 'baz',
      yes: true,
    });

    const historyPath = join(patchesDir, HISTORY_LOG_FILENAME);
    const history = await readFile(historyPath, 'utf-8');
    interface HistoryRecord {
      operation: string;
      args: {
        oldFilename: string;
        newFilename: string;
        oldName: string;
        newName: string;
        oldDescription?: string;
        newDescription?: string;
      };
    }
    const entry = JSON.parse(history.trim()) as HistoryRecord;
    expect(entry.operation).toBe('patch-rename');
    expect(entry.args.oldFilename).toBe('0044-ui-foo.patch');
    expect(entry.args.newFilename).toBe('0044-ui-bar.patch');
    expect(entry.args.newName).toBe('bar');
    expect(entry.args.newDescription).toBe('baz');
  });
});
