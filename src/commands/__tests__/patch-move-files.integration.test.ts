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

  it('--dry-run plans the move without modifying patches.json or patch bodies', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/a.js': 'a\n',
      'browser/shared.sys.mjs': 'shared\n',
      'browser/b.js': 'b\n',
    });
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
    // Worktree carries both patches' content (modified against HEAD).
    await writeFiles(projectRoot, {
      'engine/browser/a.js': 'a patched\n',
      'engine/browser/shared.sys.mjs': 'shared patched\n',
      'engine/browser/b.js': 'b patched\n',
    });
    const manifestPath = join(patchesDir, 'patches.json');
    const sourcePatchPath = join(patchesDir, '001-ui-source.patch');
    const beforeManifestMtime = (await stat(manifestPath)).mtimeMs;
    const beforePatchMtime = (await stat(sourcePatchPath)).mtimeMs;

    await patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
      file: ['browser/shared.sys.mjs'],
      dryRun: true,
      skipLint: true,
    });

    expect((await stat(manifestPath)).mtimeMs).toBe(beforeManifestMtime);
    expect((await stat(sourcePatchPath)).mtimeMs).toBe(beforePatchMtime);
    const manifest = await readManifest(patchesDir);
    expect(manifest.patches[0]?.filesAffected).toEqual(['browser/a.js', 'browser/shared.sys.mjs']);
    expect(manifest.patches[1]?.filesAffected).toEqual(['browser/b.js']);
  });

  it('moves files into an existing patch as one transaction', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/a.js': 'a\n',
      'browser/shared.sys.mjs': 'shared\n',
      'browser/b.js': 'b\n',
    });
    await seed(patchesDir, [
      makeMetadata('001-ui-source.patch', 1, ['browser/a.js', 'browser/shared.sys.mjs']),
      makeMetadata('002-ui-target.patch', 2, ['browser/b.js']),
    ]);
    await writeFiles(projectRoot, {
      'engine/browser/a.js': 'a patched\n',
      'engine/browser/shared.sys.mjs': 'shared patched\n',
      'engine/browser/b.js': 'b patched\n',
    });

    await patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
      file: ['browser/shared.sys.mjs'],
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    expect(manifest.patches[0]?.filesAffected).toEqual(['browser/a.js']);
    expect(manifest.patches[1]?.filesAffected).toEqual(['browser/b.js', 'browser/shared.sys.mjs']);

    const sourceBody = await readFile(join(patchesDir, '001-ui-source.patch'), 'utf-8');
    const targetBody = await readFile(join(patchesDir, '002-ui-target.patch'), 'utf-8');
    expect(sourceBody).toContain('browser/a.js');
    expect(sourceBody).not.toContain('shared.sys.mjs');
    expect(targetBody).toContain('browser/b.js');
    expect(targetBody).toContain('shared.sys.mjs');
    expect(targetBody).toContain('shared patched');
  });

  it('re-points staged-dependency owners at the target patch', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/a.js': 'a\n',
      'browser/b.js': 'b\n',
    });
    const importerMetadata: PatchMetadata = {
      ...makeMetadata('000-ui-importer.patch', 0, ['browser/importer.sys.mjs']),
      stagedDependencies: {
        forwardImports: [
          {
            file: 'browser/importer.sys.mjs',
            specifier: 'resource:///modules/Helper.sys.mjs',
            creates: 'browser/Helper.sys.mjs',
            owner: '001-ui-source.patch',
          },
        ],
      },
    };
    await seed(patchesDir, [
      importerMetadata,
      makeMetadata('001-ui-source.patch', 1, ['browser/a.js', 'browser/Helper.sys.mjs']),
      makeMetadata('002-ui-target.patch', 2, ['browser/b.js']),
    ]);
    await writeFiles(projectRoot, {
      'engine/browser/importer.sys.mjs':
        'import { H } from "resource:///modules/Helper.sys.mjs";\n',
      'engine/browser/a.js': 'a patched\n',
      'engine/browser/Helper.sys.mjs': 'export const H = 1;\n',
      'engine/browser/b.js': 'b patched\n',
    });

    await patchMoveFilesCommand(projectRoot, '001-ui-source.patch', '002-ui-target.patch', {
      file: ['browser/Helper.sys.mjs'],
      yes: true,
      skipLint: true,
    });

    const manifest = await readManifest(patchesDir);
    const importer = manifest.patches.find((p) => p.filename === '000-ui-importer.patch');
    expect(importer?.stagedDependencies?.forwardImports?.[0]?.owner).toBe('002-ui-target.patch');
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
    // An already-bare slug is kept verbatim.
    expect(byName.get('005-ui-feature-styles.patch')?.name).toBe('feature-styles');

    const newBody = await readFile(join(patchesDir, '005-ui-feature-styles.patch'), 'utf-8');
    expect(newBody).toContain(FILE_B);
    expect(newBody).toContain('color: blue');
    expect(newBody).not.toContain(FILE_A);
    const sourceBody = await readFile(join(patchesDir, '001-ui-feature.patch'), 'utf-8');
    expect(sourceBody).toContain(FILE_A);
    expect(sourceBody).not.toContain(FILE_B);
  });

  it('names --description in the description-required refusal', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        requireDescription: true,
        ranges: [{ from: 1, to: 99, category: 'ui' }],
      },
    });
    await seed(patchesDir, [
      {
        ...makeMetadata('001-ui-feature.patch', 1, [FILE_A, FILE_B]),
        description: 'Feature work',
      },
    ]);

    await expect(
      patchMoveFilesCommand(projectRoot, '001-ui-feature.patch', 'feature-styles', {
        file: [FILE_B],
        create: true,
        order: 5,
        yes: true,
        skipLint: true,
      })
    ).rejects.toThrow(/\[description-required\][\s\S]*→ Pass --description "<text>" \(or -d\)/);

    // A supplied description satisfies the policy.
    await patchMoveFilesCommand(projectRoot, '001-ui-feature.patch', 'feature-styles', {
      file: [FILE_B],
      create: true,
      order: 5,
      yes: true,
      skipLint: true,
      description: 'Styles split out',
    });
    const manifest = await readManifest(patchesDir);
    expect(
      manifest.patches.find((p) => p.filename === '005-ui-feature-styles.patch')?.description
    ).toBe('Styles split out');
  });

  it('does not double-suffix when the --create target name carries.patch', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-feature.patch', 1, [FILE_A, FILE_B])]);

    await patchMoveFilesCommand(
      projectRoot,
      '001-ui-feature.patch',
      '005-ui-feature-styles.patch',
      {
        file: [FILE_B],
        create: true,
        order: 5,
        yes: true,
        skipLint: true,
      }
    );

    const manifest = await readManifest(patchesDir);
    const filenames = manifest.patches.map((p) => p.filename);
    expect(filenames).toContain('005-ui-feature-styles.patch');
    expect(filenames).not.toContain('005-ui-feature-styles-patch.patch');
    // The manifest display name is the bare slug run through the
    // G13 normalizer, never the full filename the operator typed — the
    // policy audit's patch-metadata-shape check rejects anything else.
    const created = manifest.patches.find((p) => p.filename === '005-ui-feature-styles.patch');
    expect(created?.name).toBe('feature-styles');
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

describe('patch move-files projection lint runs with the whole-queue context', () => {
  const A_PATH = 'browser/modules/mb/A.sys.mjs';
  const B_PATH = 'browser/modules/mb/B.sys.mjs';
  const KEEP_CSS = 'browser/base/content/keep.css';
  const TARGET_CSS = 'browser/base/content/target.css';
  const HEAD_PATH = 'browser/base/content/test/head.js';
  const BROWSER_TEST_PATH = 'browser/base/content/test/browser_feature.js';

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

  const B_MISUSE = [
    '/* SPDX-License-Identifier: EUPL-1.2 */',
    "import { dbl } from 'resource:///modules/A.sys.mjs';",
    '/** @returns {number} result */',
    'export function use() {',
    "  return dbl('not a number');",
    '}',
    '',
  ].join('\n');

  const B_CLEAN = [
    '/* SPDX-License-Identifier: EUPL-1.2 */',
    "import { dbl } from 'resource:///modules/A.sys.mjs';",
    '/** @returns {number} result */',
    'export function use() {',
    '  return dbl(2);',
    '}',
    '',
  ].join('\n');

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
    projectRoot = await createTempProject('ff-pmf-ctx-');
    await writeFireForgeConfig(projectRoot, {
      patchLint: { checkJs: true, checkJsTestFiles: true },
    });
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, {
      'browser/modules/mb/.gitkeep': '',
      'browser/base/content/test/.gitkeep': '',
    });
    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  async function seedCrossPatchQueue(bSource: string): Promise<void> {
    await writeFiles(engineDir, {
      [A_PATH]: A_SOURCE,
      [B_PATH]: bSource,
      [KEEP_CSS]: '/* SPDX-License-Identifier: EUPL-1.2 */\n.keep { color: red; }\n',
      [TARGET_CSS]: '/* SPDX-License-Identifier: EUPL-1.2 */\n.target { color: green; }\n',
    });
    await ensureDir(patchesDir);
    await writeFile(
      join(patchesDir, '001-ui-a.patch'),
      newFilePatchBody(A_PATH, 'export function dbl(n) { return n * 2; }')
    );
    await writeFile(
      join(patchesDir, '002-ui-b.patch'),
      newFilePatchBody(B_PATH, "import { dbl } from 'resource:///modules/A.sys.mjs';")
    );
    await writeFile(
      join(patchesDir, '003-ui-target.patch'),
      newFilePatchBody(TARGET_CSS, '.target { color: green; }')
    );
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makeMetadata('001-ui-a.patch', 1, [A_PATH]),
        makeMetadata('002-ui-b.patch', 2, [B_PATH, KEEP_CSS]),
        makeMetadata('003-ui-target.patch', 3, [TARGET_CSS]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  }

  it('--create: a moved body misusing another patch module is refused (pre-fix it slipped through)', async () => {
    // Without the queue context B's `resource:///` import degraded to the
    // ambient wildcard and the misuse passed the projection lint — leaving
    // a queue the committed per-patch gate immediately failed.
    await seedCrossPatchQueue(B_MISUSE);

    await expect(
      patchMoveFilesCommand(projectRoot, '002-ui-b.patch', 'b-solo', {
        file: [B_PATH],
        create: true,
        order: 5,
        yes: true,
      })
    ).rejects.toThrow(/Patch lint found/);
  });

  it('--create: a clean cross-patch import resolves and the move succeeds', async () => {
    await seedCrossPatchQueue(B_CLEAN);

    await patchMoveFilesCommand(projectRoot, '002-ui-b.patch', 'b-solo', {
      file: [B_PATH],
      create: true,
      order: 5,
      yes: true,
    });

    const manifest = await readManifest(patchesDir);
    const created = manifest.patches.find((p) => p.filename === '005-ui-b-solo.patch');
    expect(created?.filesAffected).toEqual([B_PATH]);
  });

  it('into-existing: a moved body misusing another patch module is refused', async () => {
    await seedCrossPatchQueue(B_MISUSE);

    await expect(
      patchMoveFilesCommand(projectRoot, '002-ui-b.patch', '003-ui-target.patch', {
        file: [B_PATH],
        yes: true,
      })
    ).rejects.toThrow(/Patch lint found/);
  });

  it('into-existing: a clean cross-patch import resolves and the move succeeds', async () => {
    await seedCrossPatchQueue(B_CLEAN);

    await patchMoveFilesCommand(projectRoot, '002-ui-b.patch', '003-ui-target.patch', {
      file: [B_PATH],
      yes: true,
    });

    const manifest = await readManifest(patchesDir);
    const target = manifest.patches.find((p) => p.filename === '003-ui-target.patch');
    expect(target?.filesAffected).toEqual([TARGET_CSS, B_PATH].sort());
  });

  it('--create: a moved browser test whose head.js stays in the source patch lints clean (the handoff shape)', async () => {
    // Pre-fix the projection lint had no queue context, so the sibling
    // head.js was not a checkJs program root and the harness helper it
    // defines reported as a spurious undefined-identifier warning — noise
    // the committed-context gate then contradicted, leaving the operator
    // unable to tell "the split is wrong" from "the projection is blind".
    await writeFiles(engineDir, {
      [HEAD_PATH]: [
        '/* SPDX-License-Identifier: EUPL-1.2 */',
        '/** @returns {number} helper */',
        'function featureHelper() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
      [BROWSER_TEST_PATH]: ['/* SPDX-License-Identifier: EUPL-1.2 */', 'featureHelper();', ''].join(
        '\n'
      ),
      [KEEP_CSS]: '/* SPDX-License-Identifier: EUPL-1.2 */\n.keep { color: red; }\n',
    });
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '001-ui-tests.patch'), newFilePatchBody(HEAD_PATH, '// head'));
    const manifest: PatchesManifest = {
      version: 1,
      patches: [makeMetadata('001-ui-tests.patch', 1, [HEAD_PATH, BROWSER_TEST_PATH, KEEP_CSS])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));

    // Re-spy with capture: clack renders warnings through stdout, so a
    // spurious diagnostic is observable in the captured writes.
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    await patchMoveFilesCommand(projectRoot, '001-ui-tests.patch', 'feature-test', {
      file: [BROWSER_TEST_PATH],
      create: true,
      order: 5,
      yes: true,
    });

    const created = (await readManifest(patchesDir)).patches.find(
      (p) => p.filename === '005-ui-feature-test.patch'
    );
    expect(created?.filesAffected).toEqual([BROWSER_TEST_PATH]);
    expect(writes.join('')).not.toContain('checkjs-type-error');
  });
});
