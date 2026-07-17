// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `fireforge patch move-files`, a no-write ownership
 * planner that validates a two-patch `re-export --files` repair before an
 * operator chooses to run the printed commands.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
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

  it('rejects --create without --order and --order without --create', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-source.patch', 1, ['browser/a.js'])]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-source.patch', 'new-patch', {
        file: ['browser/a.js'],
        create: true,
      })
    ).rejects.toThrow(/--create requires --order/);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-source.patch', 'new-patch', {
        file: ['browser/a.js'],
        order: 5,
      })
    ).rejects.toThrow(/--order is only valid together with --create/);
  });
});

describe('patch move-files --create', () => {
  const FILE_A = 'browser/base/content/feature.js';
  const FILE_B = 'browser/base/content/feature.css';

  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pmf-create-');
    await writeFireForgeConfig(projectRoot);
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');

    await initCommittedRepo(engineDir, {
      [FILE_A]: 'original js;\n',
      [FILE_B]: '.root { color: red; }\n',
    });
    // Worktree carries the source patch's content (precondition shared
    // with re-export/split): both files modified relative to HEAD.
    await writeFiles(engineDir, {
      [FILE_A]: 'original js;\npatched js;\n',
      [FILE_B]: '.root { color: blue; }\n',
    });

    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('creates the target patch at --order and moves the files in one transaction', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-feature.patch', 1, [FILE_A, FILE_B])]);

    await patchMoveFilesCommand(projectRoot, '001-ui-feature.patch', 'feature-styles', {
      file: [FILE_B],
      create: true,
      order: 5,
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const byName = new Map(manifest.patches.map((p) => [p.filename, p]));
    expect(byName.get('001-ui-feature.patch')?.filesAffected).toEqual([FILE_A]);
    expect(byName.get('005-ui-feature-styles.patch')?.filesAffected).toEqual([FILE_B]);
    expect(byName.get('005-ui-feature-styles.patch')?.order).toBe(5);

    const newBody = await readFile(join(patchesDir, '005-ui-feature-styles.patch'), 'utf-8');
    expect(newBody).toContain(FILE_B);
    expect(newBody).toContain('color: blue');
    expect(newBody).not.toContain(FILE_A);
    const sourceBody = await readFile(join(patchesDir, '001-ui-feature.patch'), 'utf-8');
    expect(sourceBody).toContain(FILE_A);
    expect(sourceBody).not.toContain(FILE_B);
  });

  it('re-points staged-dependency owners at the created patch', async () => {
    const helperPath = 'browser/modules/Helper.sys.mjs';
    const importerPath = 'browser/modules/Importer.sys.mjs';
    await writeFiles(engineDir, {
      [helperPath]: 'export const H = 1;\n',
      [importerPath]:
        'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const I = H;\n',
    });

    const importerMetadata: PatchMetadata = {
      ...makeMetadata('001-ui-importer.patch', 1, [importerPath]),
      stagedDependencies: {
        forwardImports: [
          {
            file: importerPath,
            specifier: 'resource:///modules/Helper.sys.mjs',
            creates: helperPath,
            owner: '002-ui-source.patch',
          },
        ],
      },
    };
    await seed(patchesDir, [
      importerMetadata,
      makeMetadata('002-ui-source.patch', 2, [FILE_A, helperPath]),
    ]);

    await patchMoveFilesCommand(projectRoot, '002-ui-source.patch', 'helper', {
      file: [helperPath],
      create: true,
      order: 5,
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const importer = manifest.patches.find((p) => p.filename === '001-ui-importer.patch');
    expect(importer?.stagedDependencies?.forwardImports?.[0]?.owner).toBe('005-ui-helper.patch');
    const source = manifest.patches.find((p) => p.filename === '002-ui-source.patch');
    expect(source?.filesAffected).toEqual([FILE_A]);
    const created = manifest.patches.find((p) => p.filename === '005-ui-helper.patch');
    expect(created?.filesAffected).toEqual([helperPath]);
  });

  it('rejects --create when the target patch already exists', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-feature.patch', 1, [FILE_A, FILE_B]),
      makeMetadata('002-ui-target.patch', 2, ['browser/b.js']),
    ]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-feature.patch', '002-ui-target.patch', {
        file: [FILE_B],
        create: true,
        order: 5,
        yes: true,
        skipLint: true,
      })
    ).rejects.toThrow(/already exists as 002-ui-target\.patch/);
  });

  it('dry-run writes nothing', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-feature.patch', 1, [FILE_A, FILE_B])]);
    const manifestBefore = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

    await patchMoveFilesCommand(projectRoot, '001-ui-feature.patch', 'feature-styles', {
      file: [FILE_B],
      create: true,
      order: 5,
      dryRun: true,
      skipLint: true,
    });

    expect(await readFile(join(patchesDir, 'patches.json'), 'utf-8')).toBe(manifestBefore);
    expect(await pathExists(join(patchesDir, '005-ui-feature-styles.patch'))).toBe(false);
  });

  it('refuses a create+move whose projected queue regresses cross-patch lint', async () => {
    // The moved importer would land at order 1, before the source patch
    // (order 2) that keeps creating the helper it imports — a forward
    // edge into an EXISTING patch, which the split machinery does not
    // auto-declare. The projected lint must refuse.
    const helperPath = 'browser/modules/Helper.sys.mjs';
    const importerPath = 'browser/modules/Importer.sys.mjs';
    await writeFiles(engineDir, {
      [helperPath]: 'export const H = 1;\n',
      [importerPath]:
        'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const I = H;\n',
    });
    await seed(patchesDir, [makeMetadata('002-ui-source.patch', 2, [importerPath, helperPath])]);

    await expect(
      patchMoveFilesCommand(projectRoot, '002-ui-source.patch', 'importer', {
        file: [importerPath],
        create: true,
        order: 1,
        yes: true,
        skipLint: true,
      })
    ).rejects.toThrow(/cross-patch lint error/);
  });
});
