// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `fireforge patch move-files`, a no-write ownership
 * planner that validates a two-patch `re-export --files` repair before an
 * operator chooses to run the printed commands.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { patchMoveFilesCommand } from '../patch/move-files.js';

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-05-27T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

async function seed(
  patchesDir: string,
  patches: PatchMetadata[],
  bodyByFilename: Record<string, string> = {}
): Promise<void> {
  await ensureDir(patchesDir);
  for (const patch of patches) {
    await writeFile(
      join(patchesDir, patch.filename),
      bodyByFilename[patch.filename] ?? `# stub body for ${patch.filename}\n`
    );
  }
  const manifest: PatchesManifest = { version: 1, patches };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function readManifest(patchesDir: string): Promise<PatchesManifest> {
  const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
  return JSON.parse(raw) as PatchesManifest;
}

describe('patch move-files', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pmf-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('validates a file ownership move without modifying patches.json or patch bodies', async () => {
    await seed(
      patchesDir,
      [
        makeMetadata('001-ui-source.patch', 1, ['browser/a.js', 'browser/shared.sys.mjs']),
        makeMetadata('002-ui-target.patch', 2, ['browser/b.js']),
      ],
      {
        '001-ui-source.patch': '# source body marker\n',
        '002-ui-target.patch': '# target body marker\n',
      }
    );
    await writeFiles(projectRoot, {
      'engine/browser/a.js': '',
      'engine/browser/shared.sys.mjs': '',
      'engine/browser/b.js': '',
    });
    const manifestPath = join(patchesDir, 'patches.json');
    const sourcePatchPath = join(patchesDir, '001-ui-source.patch');
    const beforeManifestMtime = (await stat(manifestPath)).mtimeMs;
    const beforePatchMtime = (await stat(sourcePatchPath)).mtimeMs;

    await patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
      file: ['browser/shared.sys.mjs'],
    });

    expect((await stat(manifestPath)).mtimeMs).toBe(beforeManifestMtime);
    expect((await stat(sourcePatchPath)).mtimeMs).toBe(beforePatchMtime);
    const manifest = await readManifest(patchesDir);
    expect(manifest.patches[0]?.filesAffected).toEqual(['browser/a.js', 'browser/shared.sys.mjs']);
    expect(manifest.patches[1]?.filesAffected).toEqual(['browser/b.js']);
  });

  it('rejects files not currently owned by the source patch', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-source.patch', 1, ['browser/a.js']),
      makeMetadata('002-ui-target.patch', 2, ['browser/b.js']),
    ]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
        file: ['browser/missing.js'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects files already owned by the target patch', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-source.patch', 1, ['browser/a.js', 'browser/shared.sys.mjs']),
      makeMetadata('002-ui-target.patch', 2, ['browser/shared.sys.mjs']),
    ]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
        file: ['browser/shared.sys.mjs'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects moves that would empty the source patch', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-source.patch', 1, ['browser/a.js']),
      makeMetadata('002-ui-target.patch', 2, ['browser/b.js']),
    ]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
        file: ['browser/a.js'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
