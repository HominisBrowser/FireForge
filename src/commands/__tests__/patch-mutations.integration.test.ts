// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `patch delete`, `patch reorder`, and
 * `re-export --files`. Exercises the destructive-safety contract end to
 * end: interactive confirmation, non-TTY rejection without --yes,
 * --dry-run no-op, --yes bypass, --force-unsafe bypass of conflicts,
 * and history log append.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_LOG_FILENAME } from '../../core/destructive.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  setInteractiveMode,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir, pathExists } from '../../utils/fs.js';
import { patchDeleteCommand } from '../patch/delete.js';
import { patchReorderCommand } from '../patch/reorder.js';

vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
  return {
    ...actual,
    confirm: vi.fn(),
  };
});

import { confirm } from '@clack/prompts';

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

function createDiff(newFilePath: string, content: string): string {
  const lines = content.split('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${newFilePath} b/${newFilePath}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${newFilePath}`,
    hunk,
  ].join('\n');
}

/**
 * Builds a modification diff that adds `addedLines` at the top of an
 * existing file (`existingLine` is a single context line already at the
 * top). Used by tests that exercise the modification-side of the
 * cross-patch forward-import rule.
 */
function createModificationDiff(
  existingFilePath: string,
  existingLine: string,
  addedLines: string[]
): string {
  const newCount = 1 + addedLines.length;
  const hunk =
    `@@ -1,1 +1,${newCount} @@\n` +
    ` ${existingLine}\n` +
    addedLines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${existingFilePath} b/${existingFilePath}`,
    'index aaaaaaa..bbbbbbb 100644',
    `--- a/${existingFilePath}`,
    `+++ b/${existingFilePath}`,
    hunk,
  ].join('\n');
}

async function seed(
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

describe('patch delete', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pd-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    vi.mocked(confirm).mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('rejects non-TTY runs without --yes', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
    ]);
    await expect(patchDeleteCommand(projectRoot, '001-infra-a.patch')).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    // File must still exist (no side effect).
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(true);
  });

  it('--dry-run does not delete anything', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
    ]);
    await patchDeleteCommand(projectRoot, '001-infra-a.patch', { dryRun: true });
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(true);
    expect(await pathExists(join(patchesDir, HISTORY_LOG_FILENAME))).toBe(false);
  });

  it('--yes deletes both file and manifest row and writes history', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);
    await patchDeleteCommand(projectRoot, '001-infra-a.patch', { yes: true });
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(false);
    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(manifest.patches.map((p) => p.filename)).toEqual(['002-infra-b.patch']);
    const history = await readFile(join(patchesDir, HISTORY_LOG_FILENAME), 'utf-8');
    interface HistoryRecord {
      operation: string;
      args: { filename?: string };
      yes?: boolean;
    }
    const entry = JSON.parse(history.trim()) as HistoryRecord;
    expect(entry.operation).toBe('patch-delete');
    expect(entry.args.filename).toBe('001-infra-a.patch');
    expect(entry.yes).toBe(true);
  });

  it('refuses when a later patch imports a module owned by the target', async () => {
    restoreTTY = setInteractiveMode(false);
    // Patch A creates B.sys.mjs; patch C (order 2) imports from it.
    const diffA = createDiff('foo/B.sys.mjs', 'export const B = 1;');
    const diffC = createDiff(
      'foo/C.sys.mjs',
      'import { B } from "resource:///modules/B.sys.mjs";\nexport const C = B;'
    );
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/B.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-c.patch', 2, ['foo/C.sys.mjs']),
        body: diffC,
      },
    ]);
    await expect(
      patchDeleteCommand(projectRoot, '001-infra-a.patch', { yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    // Target file must still exist.
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(true);
  });

  it('refuses when a later patch uses dynamic import() of a target leaf', async () => {
    restoreTTY = setInteractiveMode(false);
    const diffA = createDiff('foo/Helper.sys.mjs', 'export const H = 1;');
    const diffC = createDiff(
      'foo/C.sys.mjs',
      'const mod = await import("resource:///modules/Helper.sys.mjs");\nexport const C = mod.H;'
    );
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/Helper.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-c.patch', 2, ['foo/C.sys.mjs']),
        body: diffC,
      },
    ]);
    await expect(
      patchDeleteCommand(projectRoot, '001-infra-a.patch', { yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(true);
  });

  it('refuses when a later patch uses defineESModuleGetters referencing a target leaf', async () => {
    restoreTTY = setInteractiveMode(false);
    const diffA = createDiff('foo/Helper.sys.mjs', 'export const H = 1;');
    const diffC = createDiff(
      'foo/C.sys.mjs',
      [
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  Helper: "resource:///modules/Helper.sys.mjs",',
        '});',
        'export const C = lazy;',
      ].join('\n')
    );
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/Helper.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-c.patch', 2, ['foo/C.sys.mjs']),
        body: diffC,
      },
    ]);
    await expect(
      patchDeleteCommand(projectRoot, '001-infra-a.patch', { yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(true);
  });

  it('refuses when a later patch MODIFIES an existing file to import a target leaf', async () => {
    // Fix 1: the dependency scan used to only walk later patches'
    // `newFiles` map, so a later patch that added an import into a
    // pre-existing file (browser.js) slid straight through and the
    // target could be deleted silently. The scan now also walks
    // `modifiedFileAdditions` and must refuse this shape.
    restoreTTY = setInteractiveMode(false);
    const diffA = createDiff('foo/Helper.sys.mjs', 'export const H = 1;');
    const diffB = createModificationDiff('browser/base/content/browser.js', 'existing;', [
      'import { H } from "resource:///modules/Helper.sys.mjs";',
    ]);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/Helper.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-ui-modifier.patch', 2, ['browser/base/content/browser.js']),
        body: diffB,
      },
    ]);
    await expect(
      patchDeleteCommand(projectRoot, '001-infra-a.patch', { yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    // Target file must still exist.
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(true);
  });

  it('honors the forward-import suppression marker when deleting a patch', async () => {
    restoreTTY = setInteractiveMode(false);
    const diffA = createDiff('foo/Helper.sys.mjs', 'export const H = 1;');
    const diffC = createDiff(
      'foo/C.sys.mjs',
      [
        '// fireforge-ignore: forward-import',
        'import { H } from "resource:///modules/Helper.sys.mjs";',
        'export const C = H;',
      ].join('\n')
    );
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/Helper.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-c.patch', 2, ['foo/C.sys.mjs']),
        body: diffC,
      },
    ]);

    await patchDeleteCommand(projectRoot, '001-infra-a.patch', { yes: true });

    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(false);
  });

  it('--force-unsafe bypasses the dependency refusal', async () => {
    restoreTTY = setInteractiveMode(false);
    const diffA = createDiff('foo/B.sys.mjs', 'export const B = 1;');
    const diffC = createDiff('foo/C.sys.mjs', 'import { B } from "resource:///modules/B.sys.mjs";');
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/B.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-c.patch', 2, ['foo/C.sys.mjs']),
        body: diffC,
      },
    ]);
    await patchDeleteCommand(projectRoot, '001-infra-a.patch', {
      yes: true,
      forceUnsafe: true,
    });
    expect(await pathExists(join(patchesDir, '001-infra-a.patch'))).toBe(false);
  });
});

describe('patch delete staged-dependency owner warning', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pd-owner-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    vi.mocked(confirm).mockReset();
  });
  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('warns when another patch declares the deleted patch as a staged-dependency owner', async () => {
    restoreTTY = setInteractiveMode(false);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const holderMetadata: PatchMetadata = {
      ...makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
      stagedDependencies: {
        forwardImports: [
          {
            file: 'foo/A.sys.mjs',
            specifier: 'resource:///modules/Helper.sys.mjs',
            creates: 'foo/Helper.sys.mjs',
            owner: '003-infra-c.patch',
          },
        ],
      },
    };
    await seed(patchesDir, [
      {
        metadata: holderMetadata,
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-c.patch', 3, ['foo/Helper.sys.mjs']),
        body: createDiff('foo/Helper.sys.mjs', 'export const H = 1;'),
      },
    ]);

    await patchDeleteCommand(projectRoot, '003-infra-c.patch', { yes: true });

    expect(await pathExists(join(patchesDir, '003-infra-c.patch'))).toBe(false);
    const output = writes.join('');
    expect(output).toContain('001-infra-a.patch declares a staged dependency with owner');
  });
});

describe('patch reorder', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pr-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    vi.mocked(confirm).mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('moves a patch with --to and renames files atomically', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-c.patch', 3, ['foo/C.sys.mjs']),
        body: createDiff('foo/C.sys.mjs', 'export const C = 1;'),
      },
    ]);
    await patchReorderCommand(projectRoot, '003-infra-c.patch', { to: 1, yes: true });

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    // C should now be first; A and B shift down.
    expect(entries).toEqual(['001-infra-c.patch', '002-infra-a.patch', '003-infra-b.patch']);

    const history = await readFile(join(patchesDir, HISTORY_LOG_FILENAME), 'utf-8');
    expect(history).toContain('patch-reorder');
  });

  it('reorders a two-patch swap atomically and leaves the queue verifiable (Eval 1 Finding #7)', async () => {
    // Reproduces the exact eval scenario: two patches at orders 1 and 2,
    // move the second to position 1 with `--yes`. The eval saw the
    // manifest end up with renamed filenames while the on-disk files
    // stayed at their pre-reorder names — `verify` then failed ENOENT
    // opening the manifest-renamed file. The postcondition assert added
    // to `renumberPatchesInManifest` guarantees the disk and manifest
    // stay in agreement (or the whole reorder aborts).
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-bindgen.patch', 1, ['tools/profiler/rust-api/build.rs']),
        body: createDiff('tools/profiler/rust-api/build.rs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-ui-furnace-override.patch', 2, [
          'toolkit/content/widgets/moz-button/moz-button.css',
        ]),
        body: createDiff(
          'toolkit/content/widgets/moz-button/moz-button.css',
          '.moz-button { padding: 0; }'
        ),
      },
    ]);

    await patchReorderCommand(projectRoot, '002-ui-furnace-override.patch', { to: 1, yes: true });

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-ui-furnace-override.patch', '002-infra-bindgen.patch']);

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    const filenames = manifest.patches.map((p) => p.filename).sort();
    expect(filenames).toEqual(['001-ui-furnace-override.patch', '002-infra-bindgen.patch']);
    // Every filename recorded in the manifest must exist on disk —
    // this is precisely the invariant the eval reported as broken.
    for (const filename of filenames) {
      expect(await pathExists(join(patchesDir, filename))).toBe(true);
    }
  });

  it('rejects reordering a non-allowlisted patch into a reserved policy range', async () => {
    restoreTTY = setInteractiveMode(false);
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [
          { from: 100, to: 199, category: 'infra' },
          { from: 200, to: 299, category: 'ui' },
        ],
        reservedRanges: [
          {
            from: 900,
            to: 999,
            allowed: [
              {
                filename: '901-infra-bootstrap-peer.patch',
                adr: 'docs/architecture/adr/0001-bootstrap-peer.md',
              },
            ],
          },
        ],
      },
    });
    await seed(patchesDir, [
      {
        metadata: {
          ...makeMetadata('900-infra-bootstrap-peer.patch', 900, ['tools/build.rs']),
          description: 'bootstrap peer',
        },
        body: createDiff('tools/build.rs', 'export const bootstrap = 1;'),
      },
      {
        metadata: {
          ...makeMetadata('950-ui-late-product.patch', 950, ['browser/base/content/product.js']),
          category: 'ui',
          description: 'late product',
        },
        body: createDiff('browser/base/content/product.js', 'export const product = 1;'),
      },
    ]);

    await expect(
      patchReorderCommand(projectRoot, '950-ui-late-product.patch', { to: 900, yes: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('allows an allowlisted bootstrap exception to reorder into a reserved policy range', async () => {
    restoreTTY = setInteractiveMode(false);
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [
          { from: 100, to: 199, category: 'infra' },
          { from: 200, to: 299, category: 'ui' },
        ],
        reservedRanges: [
          {
            from: 900,
            to: 999,
            allowed: [
              {
                filename: '900-infra-bootstrap-workaround.patch',
                adr: 'docs/architecture/adr/0001-bootstrap-workaround.md',
              },
              {
                filename: '901-infra-bootstrap-peer.patch',
                adr: 'docs/architecture/adr/0002-bootstrap-peer.md',
              },
            ],
          },
        ],
      },
    });
    await seed(patchesDir, [
      {
        metadata: {
          ...makeMetadata('900-infra-bootstrap-peer.patch', 900, ['tools/peer.rs']),
          description: 'bootstrap peer',
        },
        body: createDiff('tools/peer.rs', 'export const peer = 1;'),
      },
      {
        metadata: {
          ...makeMetadata('950-infra-bootstrap-workaround.patch', 950, ['tools/build.rs']),
          description: 'bootstrap workaround',
        },
        body: createDiff('tools/build.rs', 'export const bootstrap = 1;'),
      },
    ]);

    await patchReorderCommand(projectRoot, '950-infra-bootstrap-workaround.patch', {
      to: 900,
      yes: true,
    });

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual([
      '900-infra-bootstrap-workaround.patch',
      '901-infra-bootstrap-peer.patch',
    ]);
  });

  it('--dry-run does not mutate anything', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);
    await patchReorderCommand(projectRoot, '002-infra-b.patch', { to: 1, dryRun: true });

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-b.patch']);
    expect(await pathExists(join(patchesDir, HISTORY_LOG_FILENAME))).toBe(false);
  });

  it('rejects non-TTY runs without --yes', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);
    await expect(
      patchReorderCommand(projectRoot, '002-infra-b.patch', { to: 1 })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('preserves intentional gaps when moving a patch earlier', async () => {
    restoreTTY = setInteractiveMode(false);
    // Orders 1, 3, 7 with gaps. Move 7 → 3. Expect only 003 to bump
    // (to 004) and 007 to land at 003; 001 must be untouched.
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-b.patch', 3, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
      {
        metadata: makeMetadata('007-infra-c.patch', 7, ['foo/C.sys.mjs']),
        body: createDiff('foo/C.sys.mjs', 'export const C = 1;'),
      },
    ]);
    await patchReorderCommand(projectRoot, '007-infra-c.patch', { to: 3, yes: true });

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    const byName = new Map(manifest.patches.map((p) => [p.name, p]));
    expect(byName.get('test')).toBeDefined();
    // Find each patch by files affected since 'name' is shared in the fixture.
    const byFile = new Map(
      manifest.patches.map((p) => [p.filesAffected[0] ?? '(none)', p] as const)
    );
    expect(byFile.get('foo/A.sys.mjs')?.order).toBe(1);
    expect(byFile.get('foo/C.sys.mjs')?.order).toBe(3);
    expect(byFile.get('foo/B.sys.mjs')?.order).toBe(4);

    const onDisk = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(onDisk).toContain('001-infra-a.patch');
    expect(onDisk).toContain('003-infra-c.patch');
    expect(onDisk).toContain('004-infra-b.patch');
    // The old 007 filename must no longer exist.
    expect(onDisk).not.toContain('007-infra-c.patch');
  });

  it('records the clamped destination order instead of the raw --to value', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);

    await patchReorderCommand(projectRoot, '001-infra-a.patch', { to: 99, yes: true });

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    const byFile = new Map(
      manifest.patches.map((p) => [p.filesAffected[0] ?? '(none)', p] as const)
    );
    expect(byFile.get('foo/A.sys.mjs')?.order).toBe(3);

    interface HistoryRecord {
      args: { destinationOrder?: number };
    }
    const history = await readFile(join(patchesDir, HISTORY_LOG_FILENAME), 'utf-8');
    const entry = JSON.parse(history.trim()) as HistoryRecord;
    expect(entry.args.destinationOrder).toBe(3);
  });

  it('cascades bumps through a dense run when moving a patch earlier', async () => {
    restoreTTY = setInteractiveMode(false);
    // Orders 1, 2, 3 (dense). Move 3 → 1. Every patch must shift.
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-c.patch', 3, ['foo/C.sys.mjs']),
        body: createDiff('foo/C.sys.mjs', 'export const C = 1;'),
      },
    ]);
    await patchReorderCommand(projectRoot, '003-infra-c.patch', { to: 1, yes: true });

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    const byFile = new Map(
      manifest.patches.map((p) => [p.filesAffected[0] ?? '(none)', p] as const)
    );
    expect(byFile.get('foo/C.sys.mjs')?.order).toBe(1);
    expect(byFile.get('foo/A.sys.mjs')?.order).toBe(2);
    expect(byFile.get('foo/B.sys.mjs')?.order).toBe(3);
  });

  it('aborts if the queue changes after confirmation and before rename execution', async () => {
    restoreTTY = setInteractiveMode(true);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-b.patch', 3, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);

    vi.mocked(confirm).mockImplementationOnce(async () => {
      await seed(patchesDir, [
        {
          metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
          body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
        },
        {
          metadata: makeMetadata('002-infra-c.patch', 2, ['foo/C.sys.mjs']),
          body: createDiff('foo/C.sys.mjs', 'export const C = 1;'),
        },
        {
          metadata: makeMetadata('003-infra-b.patch', 3, ['foo/B.sys.mjs']),
          body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
        },
      ]);
      return true;
    });

    await expect(
      patchReorderCommand(projectRoot, '003-infra-b.patch', { to: 1 })
    ).rejects.toBeInstanceOf(GeneralError);

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-c.patch', '003-infra-b.patch']);
    expect(await pathExists(join(patchesDir, HISTORY_LOG_FILENAME))).toBe(false);
  });

  it('rejects conflicting --to/--before combos', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
    ]);
    await expect(
      patchReorderCommand(projectRoot, '001-infra-a.patch', {
        to: 1,
        before: '001-infra-a.patch',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  // Self-reference footgun: `--before <target>` resolves to the target's
  // own order, which hit computeRenameMap's silent no-op branch;
  // `--after <target>` set destinationOrder = order + 1 and renumbered
  // the target plus everything after it. Both are rejected loudly now
  // so typos and scripted misuse don't mutate (or silently no-op) the
  // queue.
  it('rejects --before referencing the target itself', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);
    await expect(
      patchReorderCommand(projectRoot, '002-infra-b.patch', {
        before: '002-infra-b.patch',
      })
    ).rejects.toThrow(/relative to itself/);

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-b.patch']);
    expect(await pathExists(join(patchesDir, HISTORY_LOG_FILENAME))).toBe(false);
  });

  it('rejects --after referencing the target itself', async () => {
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-c.patch', 3, ['foo/C.sys.mjs']),
        body: createDiff('foo/C.sys.mjs', 'export const C = 1;'),
      },
    ]);
    await expect(
      patchReorderCommand(projectRoot, '002-infra-b.patch', {
        after: '002-infra-b.patch',
      })
    ).rejects.toThrow(/relative to itself/);

    // Queue must be untouched: previously the --after branch bumped the
    // target and everything after it by one.
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-b.patch', '003-infra-c.patch']);
    expect(await pathExists(join(patchesDir, HISTORY_LOG_FILENAME))).toBe(false);
  });

  it('rewrites staged-dependency owners when the owning patch is renumbered', async () => {
    restoreTTY = setInteractiveMode(false);
    // 001 forward-imports Helper.sys.mjs created by 003, declared via a
    // staged dependency whose owner names 003's exact filename. Moving 003
    // to slot 2 must remap the owner or the projected lint would refuse the
    // reorder with a false forward-import error.
    const importerDiff = createDiff(
      'foo/A.sys.mjs',
      'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const A = H;'
    );
    const importerMetadata: PatchMetadata = {
      ...makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
      stagedDependencies: {
        forwardImports: [
          {
            file: 'foo/A.sys.mjs',
            specifier: 'resource:///modules/Helper.sys.mjs',
            creates: 'foo/Helper.sys.mjs',
            owner: '003-infra-c.patch',
          },
        ],
      },
    };
    await seed(patchesDir, [
      { metadata: importerMetadata, body: importerDiff },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
      {
        metadata: makeMetadata('003-infra-c.patch', 3, ['foo/Helper.sys.mjs']),
        body: createDiff('foo/Helper.sys.mjs', 'export const H = 1;'),
      },
    ]);

    await patchReorderCommand(projectRoot, '003-infra-c.patch', { to: 2, yes: true });

    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-c.patch', '003-infra-b.patch']);

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    const importer = manifest.patches.find((p) => p.filename === '001-infra-a.patch');
    expect(importer?.stagedDependencies?.forwardImports?.[0]?.owner).toBe('002-infra-c.patch');
  });

  it('rejects --after self-reference resolved via ordinal', async () => {
    // Confirms the check fires post-resolution regardless of whether
    // the identifier was a filename or an ordinal integer.
    restoreTTY = setInteractiveMode(false);
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);
    await expect(
      patchReorderCommand(projectRoot, '002-infra-b.patch', { after: '2' })
    ).rejects.toThrow(/relative to itself/);
  });
});
