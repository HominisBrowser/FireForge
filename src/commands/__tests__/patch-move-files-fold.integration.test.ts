// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch move-files` as one tool for a split: the declarations it
 * writes carry a reason, `--scan-file` adopts new unowned files into the
 * destination in the same transaction, `--retire-empty` folds a whole
 * patch into another and retires its slot, and a size refusal names the
 * tier change that caused it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir, pathExists } from '../../utils/fs.js';
import { patchMoveFilesCommand } from '../patch/move-files.js';

const IMPORTER = 'browser/modules/Importer.sys.mjs';
const HELPER = 'browser/modules/Helper.sys.mjs';
const OTHER = 'browser/modules/Other.sys.mjs';
const SEAM = 'browser/modules/Seam.sys.mjs';
const HELPER_SPECIFIER = 'resource:///modules/Helper.sys.mjs';
const IMPORTER_BODY = `import { H } from "${HELPER_SPECIFIER}";\nexport const I = H;`;

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: 'd',
    createdAt: '2026-10-22T00:00:00.000Z',
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

describe('patch move-files as one tool for a split', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pmf-fold-');
    await writeFireForgeConfig(projectRoot);
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { 'README.txt': 'engine\n' });
    await writeFiles(engineDir, {
      [IMPORTER]: `${IMPORTER_BODY}\n`,
      [HELPER]: 'export const H = 1;\n',
      [OTHER]: 'export const O = 1;\n',
      [SEAM]: 'export const S = 1;\n',
    });
    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('records a reason on the forward declaration a move creates', async () => {
    await seed(patchesDir, [
      {
        metadata: meta('001-ui-source.patch', 1, [HELPER, IMPORTER]),
        body: newFileDiff(IMPORTER, IMPORTER_BODY) + newFileDiff(HELPER, 'export const H = 1;'),
      },
      { metadata: meta('002-ui-target.patch', 2, [OTHER]), body: newFileDiff(OTHER, 'x') },
    ]);

    await patchMoveFilesCommand(projectRoot, '001', '002', {
      file: [HELPER],
      yes: true,
      skipLint: true,
    });

    const source = (await readManifest(patchesDir)).patches.find((p) => p.order === 1);
    expect(source?.stagedDependencies?.forwardImports).toEqual([
      {
        file: IMPORTER,
        specifier: HELPER_SPECIFIER,
        creates: HELPER,
        owner: '002-ui-target.patch',
        reason: '001-ui-source.patch → 002-ui-target.patch by patch move-files',
      },
    ]);
  });

  it('--scan-file adopts a new unowned file into the destination in the same transaction', async () => {
    await seed(patchesDir, [
      {
        metadata: meta('001-ui-source.patch', 1, [IMPORTER, OTHER]),
        body: newFileDiff(IMPORTER, IMPORTER_BODY) + newFileDiff(OTHER, 'x'),
      },
      { metadata: meta('002-ui-target.patch', 2, [HELPER]), body: newFileDiff(HELPER, 'x') },
    ]);

    await patchMoveFilesCommand(projectRoot, '001', '002', {
      file: [OTHER],
      scanFile: [`engine/${SEAM}`],
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    expect(manifest.patches.find((p) => p.order === 1)?.filesAffected).toEqual([IMPORTER]);
    expect(manifest.patches.find((p) => p.order === 2)?.filesAffected).toEqual([
      HELPER,
      OTHER,
      SEAM,
    ]);
    const targetBody = await readFile(join(patchesDir, '002-ui-target.patch'), 'utf8');
    expect(targetBody).toContain(`+++ b/${SEAM}`);
    const sourceBody = await readFile(join(patchesDir, '001-ui-source.patch'), 'utf8');
    expect(sourceBody).not.toContain(SEAM);
  });

  it('--scan-file refuses an owned or missing file before anything is written', async () => {
    await seed(patchesDir, [
      {
        metadata: meta('001-ui-source.patch', 1, [IMPORTER, OTHER]),
        body: newFileDiff(IMPORTER, IMPORTER_BODY) + newFileDiff(OTHER, 'x'),
      },
      { metadata: meta('002-ui-target.patch', 2, [HELPER]), body: newFileDiff(HELPER, 'x') },
    ]);
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');
    const move = (scanFile: string): Promise<void> =>
      patchMoveFilesCommand(projectRoot, '001', '002', {
        file: [OTHER],
        scanFile: [scanFile],
        yes: true,
        skipLint: true,
      });

    await expect(move(IMPORTER)).rejects.toThrow(/already owned by 001-ui-source\.patch/);
    await expect(move('browser/modules/Missing.sys.mjs')).rejects.toThrow(/not found in engine/);
    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
  });

  describe('--retire-empty', () => {
    async function seedFold(): Promise<void> {
      await seed(patchesDir, [
        {
          metadata: {
            ...meta('001-ui-importer.patch', 1, [IMPORTER]),
            stagedDependencies: {
              forwardImports: [
                {
                  file: IMPORTER,
                  specifier: HELPER_SPECIFIER,
                  creates: HELPER,
                  owner: '002-ui-tests.patch',
                  reason: 'staged',
                },
              ],
            },
          },
          body: newFileDiff(IMPORTER, IMPORTER_BODY),
        },
        {
          metadata: meta('002-ui-tests.patch', 2, [HELPER]),
          body: newFileDiff(HELPER, 'export const H = 1;'),
        },
        { metadata: meta('003-ui-subject.patch', 3, [OTHER]), body: newFileDiff(OTHER, 'x') },
      ]);
    }

    it('without the flag, a move that empties the source refuses and names it', async () => {
      await seedFold();
      await expect(
        patchMoveFilesCommand(projectRoot, '002', '003', {
          file: [HELPER],
          yes: true,
          skipLint: true,
        })
      ).rejects.toThrow(/--retire-empty/);
    });

    it('re-points the declarations the source owns and retires its slot', async () => {
      await seedFold();

      await patchMoveFilesCommand(projectRoot, '002', '003', {
        file: [HELPER],
        retireEmpty: true,
        yes: true,
        skipLint: true,
      });

      const manifest = await readManifest(patchesDir);
      expect(manifest.patches.map((p) => p.filename)).toEqual([
        '001-ui-importer.patch',
        '003-ui-subject.patch',
      ]);
      expect(manifest.retired).toEqual([
        expect.objectContaining({ order: 2, filename: '002-ui-tests.patch', category: 'ui' }),
      ]);
      expect(await pathExists(join(patchesDir, '002-ui-tests.patch'))).toBe(false);
      expect(manifest.patches[0]?.stagedDependencies?.forwardImports?.[0]?.owner).toBe(
        '003-ui-subject.patch'
      );
      expect(manifest.patches[1]?.filesAffected).toEqual([HELPER, OTHER]);
      const subjectBody = await readFile(join(patchesDir, '003-ui-subject.patch'), 'utf8');
      expect(subjectBody).toContain(`+++ b/${HELPER}`);
    });

    it('refuses the flag on a move that leaves the source files', async () => {
      await seed(patchesDir, [
        {
          metadata: meta('001-ui-source.patch', 1, [OTHER, SEAM]),
          body: newFileDiff(OTHER, 'x') + newFileDiff(SEAM, 'x'),
        },
        { metadata: meta('002-ui-target.patch', 2, [HELPER]), body: newFileDiff(HELPER, 'x') },
      ]);
      await expect(
        patchMoveFilesCommand(projectRoot, '001', '002', {
          file: [OTHER],
          retireEmpty: true,
          yes: true,
          skipLint: true,
        })
      ).rejects.toThrow(/would\s+keep|applies only/);
    });
  });

  it('names the tier change when a move leaves the source a test-only patch above the test ceiling', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchLint: { patchSizeThresholds: { test: { lines: { notice: 2, warning: 4, error: 8 } } } },
    });
    const product = 'browser/t/product.txt';
    const fixture = 'browser/t/test/fixture.txt';
    const fixtureLines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    await writeFiles(engineDir, {
      [product]: 'p\n',
      [fixture]: `${fixtureLines.join('\n')}\n`,
      'browser/t/kept.txt': 'k\n',
    });
    await seed(patchesDir, [
      {
        metadata: meta('001-ui-source.patch', 1, [fixture, product]),
        body: newFileDiff(product, 'p') + newFileDiff(fixture, fixtureLines.join('\n')),
      },
      {
        metadata: meta('002-ui-target.patch', 2, ['browser/t/kept.txt']),
        body: newFileDiff('browser/t/kept.txt', 'k'),
      },
    ]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001', '002', { file: [product], yes: true })
    ).rejects.toThrow(
      /the source becomes test tier \(it was general tier\): \d+ lines against 8\. Move its test files out/
    );
  });
});
