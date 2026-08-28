// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration coverage for `fireforge patch split`. Real
 * git repo so the diff-generation path runs; exercises the one-transaction
 * contract: shrink + new-patch creation + staged-dependency owner rewrites,
 * with dry-run and rollback.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPatchQueueContext, lintPatchQueue } from '../../core/patch-lint.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
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
import { patchSplitCommand } from '../patch/split.js';

const fsControls = vi.hoisted(() => ({ failManifestWrites: 0 }));

vi.mock('../../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/fs.js')>();
  return {
    ...actual,
    writeJson: vi.fn(async (path: string, data: unknown) => {
      if (fsControls.failManifestWrites > 0 && path.endsWith('patches.json')) {
        fsControls.failManifestWrites -= 1;
        throw new Error('simulated manifest write failure');
      }
      return actual.writeJson(path, data);
    }),
  };
});

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'infra',
    name: 'test',
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

async function seedManifest(
  patchesDir: string,
  patches: Array<{ metadata: PatchMetadata; body: string }>
): Promise<void> {
  await ensureDir(patchesDir);
  for (const p of patches) {
    await writeFile(join(patchesDir, p.metadata.filename), p.body);
  }
  const manifest: PatchesManifest = {
    version: 1,
    patches: patches.map((p) => p.metadata),
  };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function readManifest(patchesDir: string): Promise<PatchesManifest> {
  return JSON.parse(await readFile(join(patchesDir, 'patches.json'), 'utf-8')) as PatchesManifest;
}

const FILE_A = 'browser/base/content/feature.js';
const FILE_B = 'browser/base/content/feature.css';

describe('patch split integration', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    fsControls.failManifestWrites = 0;
    projectRoot = await createTempProject('ff-split-');
    await writeFireForgeConfig(projectRoot);
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');

    await initCommittedRepo(engineDir, {
      [FILE_A]: 'original js;\n',
      [FILE_B]: '.root { color: red; }\n',
    });
    // Worktree carries the source patch's content (precondition shared
    // with re-export): both files modified relative to HEAD.
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

  it('splits files into a new patch placed after the source by default', async () => {
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
      { metadata: makeMetadata('002-infra-later.patch', 2, ['unrelated.txt']), body: '(stale)' },
    ]);

    await patchSplitCommand(projectRoot, '001-infra-feature.patch', {
      files: [FILE_B],
      name: 'feature-styles',
      yes: true,
      skipLint: true,
    });

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual([
      '001-infra-feature.patch',
      '002-infra-feature-styles.patch',
      '003-infra-later.patch',
    ]);

    const sourceBody = await readFile(join(patchesDir, '001-infra-feature.patch'), 'utf-8');
    expect(sourceBody).toContain(FILE_A);
    expect(sourceBody).not.toContain(FILE_B);
    const newBody = await readFile(join(patchesDir, '002-infra-feature-styles.patch'), 'utf-8');
    expect(newBody).toContain(FILE_B);
    expect(newBody).toContain('color: blue');
    expect(newBody).not.toContain(FILE_A);

    const manifest = await readManifest(patchesDir);
    const byName = new Map(manifest.patches.map((p) => [p.filename, p]));
    expect(byName.get('001-infra-feature.patch')?.filesAffected).toEqual([FILE_A]);
    expect(byName.get('002-infra-feature-styles.patch')?.filesAffected).toEqual([FILE_B]);
    expect(byName.get('002-infra-feature-styles.patch')?.order).toBe(2);
    expect(byName.get('003-infra-later.patch')?.order).toBe(3);

    // The committed queue lints clean end to end.
    const ctx = await buildPatchQueueContext(patchesDir);
    expect(lintPatchQueue(ctx).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('normalizes a filename-shaped --name to the bare slug in the manifest', async () => {
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
    ]);

    await patchSplitCommand(projectRoot, '001-infra-feature.patch', {
      files: [FILE_B],
      name: '002-infra-feature-styles.patch',
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const created = manifest.patches.find((p) => p.filename === '002-infra-feature-styles.patch');
    expect(created).toBeDefined();
    // The display name is the bare slug, not the typed filename — same G13
    // normalization `export --name` applies.
    expect(created?.name).toBe('feature-styles');
  });

  it('rewrites staged-dependency owners pointing at moved files (the A4 flow)', async () => {
    // 001 forward-imports feature.css... modelled as a JS helper created by
    // the source: 001 imports Helper.sys.mjs which 002 creates; the helper
    // moves to a new patch 003, so 001's owner must follow it.
    const helperPath = 'browser/modules/Helper.sys.mjs';
    const importerPath = 'browser/modules/Importer.sys.mjs';
    await writeFiles(engineDir, {
      [helperPath]: 'export const H = 1;\n',
      [importerPath]:
        'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const I = H;\n',
    });

    const importerMetadata: PatchMetadata = {
      ...makeMetadata('001-infra-importer.patch', 1, [importerPath]),
      stagedDependencies: {
        forwardImports: [
          {
            file: importerPath,
            specifier: 'resource:///modules/Helper.sys.mjs',
            creates: helperPath,
            owner: '002-infra-source.patch',
          },
        ],
      },
    };
    await seedManifest(patchesDir, [
      { metadata: importerMetadata, body: '(stale)' },
      {
        metadata: makeMetadata('002-infra-source.patch', 2, [FILE_A, helperPath]),
        body: '(stale)',
      },
    ]);

    await patchSplitCommand(projectRoot, '002-infra-source.patch', {
      files: [helperPath],
      name: 'helper',
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const importer = manifest.patches.find((p) => p.filename === '001-infra-importer.patch');
    expect(importer?.stagedDependencies?.forwardImports?.[0]?.owner).toBe('003-infra-helper.patch');
    const source = manifest.patches.find((p) => p.filename === '002-infra-source.patch');
    expect(source?.filesAffected).toEqual([FILE_A]);
    const split = manifest.patches.find((p) => p.filename === '003-infra-helper.patch');
    expect(split?.filesAffected).toEqual([helperPath]);

    // The rewritten owner keeps the forward-import declaration valid.
    const ctx = await buildPatchQueueContext(patchesDir);
    expect(lintPatchQueue(ctx).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('auto-declares the forward edge a split introduces into the new patch', async () => {
    // The remaining source still imports a helper that moves into the new
    // (later) patch — a forward edge the split itself creates, with no prior
    // declaration. Before the fix, the projected lint flagged it and the
    // split refused (the real per-patch gate would have been 0/0 once
    // declared). Now the split auto-declares it: the dry-run projection is
    // clean (no refusal) AND the committed queue lints clean.
    const helperPath = 'browser/modules/Helper.sys.mjs';
    const importerPath = 'browser/modules/Importer.sys.mjs';
    const mozBuildPath = 'browser/modules/moz.build';
    await writeFiles(engineDir, {
      [helperPath]: 'export const H = 1;\n',
      [importerPath]:
        'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const I = H;\n',
      [mozBuildPath]: 'EXTRA_JS_MODULES += ["Helper.sys.mjs", "Importer.sys.mjs"]\n',
    });

    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-feature.patch', 1, [
          importerPath,
          helperPath,
          mozBuildPath,
        ]),
        body: '(stale)',
      },
    ]);

    // No --force-unsafe: if the projected lint flagged the forward edge,
    // confirmDestructive would refuse and this would throw.
    await patchSplitCommand(projectRoot, '001-infra-feature.patch', {
      files: [helperPath],
      name: 'helper',
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const source = manifest.patches.find((p) => p.filename === '001-infra-feature.patch');
    const split = manifest.patches.find((p) => p.filename === '002-infra-helper.patch');
    expect(split?.filesAffected).toEqual([helperPath]);
    // The split auto-wrote the staged forward-import declaration onto the
    // source, owner pointing at the freshly created patch.
    const decl = source?.stagedDependencies?.forwardImports?.[0];
    expect(decl).toMatchObject({
      file: importerPath,
      specifier: 'resource:///modules/Helper.sys.mjs',
      creates: helperPath,
      owner: '002-infra-helper.patch',
    });

    // The committed queue lints clean end to end — matching the real gate.
    const ctx = await buildPatchQueueContext(patchesDir);
    expect(lintPatchQueue(ctx).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('refuses files the source does not own', async () => {
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A]), body: '(stale)' },
    ]);

    await expect(
      patchSplitCommand(projectRoot, '001-infra-feature.patch', {
        files: [FILE_B],
        name: 'styles',
        yes: true,
        skipLint: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('refuses to split every file out of the source', async () => {
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
    ]);

    await expect(
      patchSplitCommand(projectRoot, '001-infra-feature.patch', {
        files: [FILE_A, FILE_B],
        name: 'everything',
        yes: true,
        skipLint: true,
      })
    ).rejects.toThrow(/leave it empty/);
  });

  it('refuses when the worktree does not carry the patch content', async () => {
    // Revert FILE_B so its diff against HEAD is empty.
    await writeFiles(engineDir, { [FILE_B]: '.root { color: red; }\n' });
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
    ]);

    await expect(
      patchSplitCommand(projectRoot, '001-infra-feature.patch', {
        files: [FILE_B],
        name: 'styles',
        yes: true,
        skipLint: true,
      })
    ).rejects.toBeInstanceOf(GeneralError);
  });

  it('dry-run writes nothing', async () => {
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
    ]);
    const manifestBefore = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

    await patchSplitCommand(projectRoot, '001-infra-feature.patch', {
      files: [FILE_B],
      name: 'styles',
      dryRun: true,
      skipLint: true,
    });

    expect(await readFile(join(patchesDir, 'patches.json'), 'utf-8')).toBe(manifestBefore);
    expect(await readFile(join(patchesDir, '001-infra-feature.patch'), 'utf-8')).toBe('(stale)');
    expect(await pathExists(join(patchesDir, '001-infra-styles.patch'))).toBe(false);
    expect(await pathExists(join(patchesDir, '002-infra-styles.patch'))).toBe(false);
  });

  it('rolls back the source body and new patch file when the manifest write fails', async () => {
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
    ]);
    const manifestBefore = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
    // No renames in this layout (new patch appends at order 2), so the
    // first patches.json write is the final manifest commit.
    fsControls.failManifestWrites = 1;

    await expect(
      patchSplitCommand(projectRoot, '001-infra-feature.patch', {
        files: [FILE_B],
        name: 'styles',
        yes: true,
        skipLint: true,
      })
    ).rejects.toThrow(/simulated manifest write failure/);

    // Reverse-order rollback: source body restored byte-identically, the
    // new patch file removed, manifest semantically unchanged (the restore
    // re-serializes, so compare parsed shapes rather than raw bytes).
    expect(await readFile(join(patchesDir, '001-infra-feature.patch'), 'utf-8')).toBe('(stale)');
    expect(await pathExists(join(patchesDir, '002-infra-styles.patch'))).toBe(false);
    const restored = await readManifest(patchesDir);
    const before = JSON.parse(manifestBefore) as PatchesManifest;
    // The restore re-serializes through the manifest loader (which may add
    // derived legacy fields), so compare the load-bearing row shape.
    expect(
      restored.patches.map((p) => [p.filename, p.order, p.filesAffected, p.stagedDependencies])
    ).toEqual(
      before.patches.map((p) => [p.filename, p.order, p.filesAffected, p.stagedDependencies])
    );
  });

  it('refuses --before placements that would renumber through a reserved range with one up-front error', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [{ from: 1, to: 99, category: 'infra' }],
        reservedRanges: [{ from: 4, to: 6, allowed: [] }],
      },
    });
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
      { metadata: makeMetadata('004-infra-reserved.patch', 4, ['unrelated.txt']), body: '(stale)' },
    ]);

    // --before the reserved patch would shift it 004 → 005 inside the
    // reserved block; the refusal is one message keyed on the range, with
    // the first free order below the block (003) as the suggested fix.
    await expect(
      patchSplitCommand(projectRoot, '001-infra-feature.patch', {
        files: [FILE_B],
        name: 'styles',
        before: '004-infra-reserved.patch',
        yes: true,
        skipLint: true,
      })
    ).rejects.toThrow(
      /Positional insert would renumber the reserved range 004-006; pass --order 003/
    );
  });

  it('refuses placements that violate patchPolicy without --force-unsafe', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [{ from: 1, to: 99, category: 'infra' }],
        allowGaps: false,
        ranges2: undefined,
      } as never,
    });
    await seedManifest(patchesDir, [
      { metadata: makeMetadata('001-infra-feature.patch', 1, [FILE_A, FILE_B]), body: '(stale)' },
    ]);

    await expect(
      patchSplitCommand(projectRoot, '001-infra-feature.patch', {
        files: [FILE_B],
        name: 'styles',
        order: 50,
        yes: true,
        skipLint: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('patch split projection lint runs with the whole-queue context', () => {
  const A_PATH = 'browser/modules/mb/A.sys.mjs';
  const B_PATH = 'browser/modules/mb/B.sys.mjs';
  const KEEP_CSS = 'browser/base/content/keep.css';

  const A_SOURCE = [
    '/* SPDX-License-Identifier: EUPL-1.2 */',
    '/**',
    ' * Doubles a number.',
    ' * @param {number} n - input',
    ' * @returns {number} doubled',
    ' */',
    'export function dbl(n) {',
    '  return n * 2;',
    '}',
    '',
  ].join('\n');

  function bSource(argument: string): string {
    return [
      '/* SPDX-License-Identifier: EUPL-1.2 */',
      "import { dbl } from 'resource:///modules/A.sys.mjs';",
      '/** @returns {number} result */',
      'export function use() {',
      `  return dbl(${argument});`,
      '}',
      '',
    ].join('\n');
  }

  function newFilePatchBody(path: string, addedLine: string): string {
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1,1 @@',
      `+${addedLine}`,
      '',
    ].join('\n');
  }

  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-split-ctx-');
    await writeFireForgeConfig(projectRoot, { patchLint: { checkJs: true } });
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { 'browser/modules/mb/.gitkeep': '' });
    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  async function seedCrossPatchQueue(argument: string): Promise<void> {
    await writeFiles(engineDir, {
      [A_PATH]: A_SOURCE,
      [B_PATH]: bSource(argument),
      [KEEP_CSS]: '/* SPDX-License-Identifier: EUPL-1.2 */\n.keep { color: red; }\n',
    });
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, [A_PATH]),
        body: newFilePatchBody(A_PATH, 'export function dbl(n) { return n * 2; }'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, [B_PATH, KEEP_CSS]),
        body: newFilePatchBody(B_PATH, "import { dbl } from 'resource:///modules/A.sys.mjs';"),
      },
    ]);
  }

  it('a split body misusing another patch module is refused (pre-fix it slipped through)', async () => {
    await seedCrossPatchQueue("'not a number'");

    await expect(
      patchSplitCommand(projectRoot, '002-infra-b.patch', {
        files: [B_PATH],
        name: 'b-solo',
        yes: true,
      })
    ).rejects.toThrow(/Patch lint found/);
  });

  it('a clean cross-patch import resolves and the split succeeds', async () => {
    await seedCrossPatchQueue('2');

    await patchSplitCommand(projectRoot, '002-infra-b.patch', {
      files: [B_PATH],
      name: 'b-solo',
      yes: true,
    });

    const manifest = await readManifest(patchesDir);
    const created = manifest.patches.find((p) => p.filename === '003-infra-b-solo.patch');
    expect(created?.filesAffected).toEqual([B_PATH]);
  });
});
