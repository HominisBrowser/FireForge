// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch move-files --create` keeps staged-dependency declarations in step
 * with the files it moves: registration owners are re-pointed like
 * forward-import owners, a declaration whose declaring file moved goes with
 * it, and one the move makes unused is dropped and named. Also pins that the
 * gap rule refuses before any lint runs.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as exportShared from '../../commands/export-shared.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import * as logger from '../../utils/logger.js';
import { patchMoveFilesCommand } from '../patch/move-files.js';

const FILE_A = 'browser/base/content/feature.js';
const IMPORTER = 'browser/modules/Importer.sys.mjs';
const LATER = 'browser/modules/Later.sys.mjs';
const IMPORT_LINE = 'import { L } from "resource:///modules/Later.sys.mjs";';

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: 'd',
    createdAt: '2026-05-27T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

function newFileDiff(path: string, content: string): string {
  const lines = content.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

async function seed(
  patchesDir: string,
  patches: Array<{ metadata: PatchMetadata; body: string }>
): Promise<void> {
  await ensureDir(patchesDir);
  for (const patch of patches) {
    await writeFile(join(patchesDir, patch.metadata.filename), patch.body);
  }
  const manifest: PatchesManifest = { version: 1, patches: patches.map((p) => p.metadata) };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function readManifest(patchesDir: string): Promise<PatchesManifest> {
  return JSON.parse(await readFile(join(patchesDir, 'patches.json'), 'utf8')) as PatchesManifest;
}

describe('patch move-files --create staged-dependency upkeep', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;
  const importerBody = `${IMPORT_LINE}\nexport const I = L;`;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pmf-staged-');
    await writeFireForgeConfig(projectRoot);
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { [FILE_A]: 'original js;\n' });
    await writeFiles(engineDir, {
      [FILE_A]: 'original js;\npatched js;\n',
      [IMPORTER]: `${importerBody}\n`,
      [LATER]: 'export const L = 1;\n',
    });
    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  /** 002 owns FILE_A and the importer (which imports a module 009 creates). */
  async function seedForwardImport(): Promise<void> {
    await seed(patchesDir, [
      {
        metadata: {
          ...meta('002-ui-source.patch', 2, [FILE_A, IMPORTER]),
          stagedDependencies: {
            forwardImports: [
              {
                file: IMPORTER,
                specifier: 'resource:///modules/Later.sys.mjs',
                creates: LATER,
                owner: '009-ui-later.patch',
                reason: 'staged',
              },
            ],
          },
        },
        body: newFileDiff(IMPORTER, importerBody),
      },
      {
        metadata: meta('009-ui-later.patch', 9, [LATER]),
        body: newFileDiff(LATER, 'export const L = 1;'),
      },
    ]);
  }

  it('moves a declaration with its declaring file when the edge stays forward', async () => {
    await seedForwardImport();
    const infos: string[] = [];
    vi.spyOn(logger, 'info').mockImplementation((message: string) => {
      infos.push(message);
    });

    await patchMoveFilesCommand(projectRoot, '002-ui-source.patch', 'importer', {
      file: [IMPORTER],
      create: true,
      order: 5,
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const source = manifest.patches.find((p) => p.filename === '002-ui-source.patch');
    expect(source?.stagedDependencies).toBeUndefined();
    const created = manifest.patches.find((p) => p.filename === '005-ui-importer.patch');
    expect(created?.stagedDependencies?.forwardImports).toEqual([
      expect.objectContaining({ file: IMPORTER, owner: '009-ui-later.patch', reason: 'staged' }),
    ]);
    expect(infos.join('\n')).toContain(
      'staged-dependency declarations moved from 002-ui-source.patch to 005-ui-importer.patch (1):'
    );
  });

  it('drops and names a declaration the move made unused', async () => {
    await seedForwardImport();
    const infos: string[] = [];
    vi.spyOn(logger, 'info').mockImplementation((message: string) => {
      infos.push(message);
    });

    // Order 12 lands after 009, so the import is no longer forward.
    await patchMoveFilesCommand(projectRoot, '002-ui-source.patch', 'importer', {
      file: [IMPORTER],
      create: true,
      order: 12,
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    for (const patch of manifest.patches) expect(patch.stagedDependencies).toBeUndefined();
    const text = infos.join('\n');
    expect(text).toContain('dropped because the move made them unused (1):');
    expect(text).toContain(`002-ui-source.patch → 012-ui-importer.patch: ${IMPORTER} imports`);
    const history = await readFile(join(patchesDir, '..', '.fireforge', 'history.jsonl'), 'utf8');
    expect(history).toContain('"droppedDeclarations"');
  });

  it('re-points registration owners whose creates path moved', async () => {
    const jar = 'browser/base/jar.mn';
    await writeFiles(engineDir, { [jar]: '  content/later.js\n' });
    await seed(patchesDir, [
      {
        metadata: {
          ...meta('001-ui-jar.patch', 1, [jar]),
          stagedDependencies: {
            registrations: [
              { file: jar, line: 'content/later.js', creates: LATER, owner: '002-ui-source.patch' },
            ],
          },
        },
        body: newFileDiff(jar, '  content/later.js'),
      },
      {
        metadata: meta('002-ui-source.patch', 2, [FILE_A, LATER]),
        body: newFileDiff(LATER, 'export const L = 1;'),
      },
    ]);

    await patchMoveFilesCommand(projectRoot, '002-ui-source.patch', 'later', {
      file: [LATER],
      create: true,
      order: 5,
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const holder = manifest.patches.find((p) => p.filename === '001-ui-jar.patch');
    expect(holder?.stagedDependencies?.registrations?.[0]?.owner).toBe('005-ui-later.patch');
  });

  it('refuses an --order past a gap before any lint runs', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: { ranges: [{ from: 1, to: 99, category: 'ui' }], allowGaps: false },
    });
    await seed(patchesDir, [
      {
        metadata: meta('001-ui-source.patch', 1, [FILE_A, IMPORTER]),
        body: newFileDiff(IMPORTER, importerBody),
      },
      {
        metadata: meta('002-ui-later.patch', 2, [LATER]),
        body: newFileDiff(LATER, 'export const L = 1;'),
      },
    ]);
    const lintSpy = vi.spyOn(exportShared, 'runPatchLint');

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-source.patch', 'importer', {
        file: [IMPORTER],
        create: true,
        order: 9,
        yes: true,
      })
    ).rejects.toThrow(/\[numeric-gap\][\s\S]*orders are contiguous within a range/);
    expect(lintSpy).not.toHaveBeenCalled();
  });
});
