// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the placement helpers in export-flow.ts. These exist
 * specifically to cover the forward-import projection bug: the synthetic
 * entry for the pending patch must include its newly-created files, or
 * the forward-import rule cannot see imports authored *by* the new patch
 * itself and the gate silently lets through bad placements.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sanitizeName } from '../../core/patch-export.js';
import { addPatchToManifest } from '../../core/patch-manifest.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { ensureDir, writeText } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import {
  commitPlacementExport,
  computeExactPlacementPlan,
  computePlacementPlan,
  projectPlacementForLint,
  renderDryRunPreview,
  resolvePlacementPlan,
} from '../export-flow.js';
import { assertPlacementAvoidsReservedRanges } from '../export-placement-policy.js';

// Mock ../../utils/fs.js and ../../core/patch-manifest.js so the rollback
// tests below can override specific functions (writeText,
// addPatchToManifest) to simulate mid-commit failures. Other tests in
// this file continue to get real behavior because the mocks delegate to
// the actual implementations by default.
vi.mock('../../utils/fs.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
  return {
    ...actual,
    writeText: vi.fn(actual.writeText),
  };
});

vi.mock('../../core/patch-manifest.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/patch-manifest.js')>(
    '../../core/patch-manifest.js'
  );
  return {
    ...actual,
    addPatchToManifest: vi.fn(actual.addPatchToManifest),
  };
});

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

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

function makePolicyMetadata(
  filename: string,
  order: number,
  category: string,
  filesAffected: string[]
): PatchMetadata {
  return {
    ...makeMetadata(filename, order, filesAffected),
    category,
    name: filename.replace(/^\d+-[a-z0-9-]+-/, '').replace(/\.patch$/, ''),
    description: `${category} patch ${String(order)}`,
  };
}

function sparsePolicyConfig(): FireForgeConfig {
  return {
    name: 'MyBrowser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    patchPolicy: {
      requireDescription: true,
      ranges: [
        { from: 200, to: 299, category: 'ui' },
        { from: 100, to: 199, category: 'infra' },
      ],
      reservedRanges: [
        {
          from: 900,
          to: 999,
          allowed: [
            {
              filename: '900-infra-bindgen-basic-string-workaround.patch',
              files: ['tools/profiler/rust-api/build.rs'],
              documentation: 'docs/patches/bindgen-basic-string-workaround.md',
            },
          ],
        },
      ],
    },
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

describe('computePlacementPlan validation', () => {
  // Fix 3: a NaN / non-positive requestedOrder must be rejected before
  // the planner can embed it into a filename like `NaN-ui-foo.patch`.
  // The argParser on --order is the primary guard, but this function is
  // exported and reachable from tests / future callers, so the check
  // lives here too.
  const oneMeta = [makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs'])];

  it('throws on NaN', () => {
    expect(() => computePlacementPlan(oneMeta, 'infra', 'foo', Number.NaN)).toThrow(
      InvalidArgumentError
    );
  });

  it('throws on zero', () => {
    expect(() => computePlacementPlan(oneMeta, 'infra', 'foo', 0)).toThrow(InvalidArgumentError);
  });

  it('throws on negatives', () => {
    expect(() => computePlacementPlan(oneMeta, 'infra', 'foo', -5)).toThrow(InvalidArgumentError);
  });

  it('throws on non-integers', () => {
    expect(() => computePlacementPlan(oneMeta, 'infra', 'foo', 1.5)).toThrow(InvalidArgumentError);
  });

  it('accepts 1 and produces a valid filename', () => {
    const plan = computePlacementPlan([], 'infra', 'bar', 1);
    expect(plan.insertionOrder).toBe(1);
    expect(plan.newFilename).toMatch(/^001-infra-bar\.patch$/);
  });

  it('uses the shared patch-export slug sanitizer for new placement filenames', () => {
    const name = 'My@@@Feature###Name';
    const plan = computePlacementPlan([], 'ui', name, 1);

    expect(plan.newFilename).toBe(`001-ui-${sanitizeName(name)}.patch`);
  });
});

describe('sparse export placement with patchPolicy reserved ranges', () => {
  let projectRoot: string;
  let patchesDir: string;

  const ui200 = makePolicyMetadata('200-ui-shell.patch', 200, 'ui', [
    'browser/base/content/browser.js',
  ]);
  const ui240 = makePolicyMetadata('240-ui-something.patch', 240, 'ui', [
    'browser/base/content/something.js',
  ]);
  const reserved900 = makePolicyMetadata(
    '900-infra-bindgen-basic-string-workaround.patch',
    900,
    'infra',
    ['tools/profiler/rust-api/build.rs']
  );

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-sparse-placement-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  async function seedSparseQueue(includeReserved = true): Promise<PatchMetadata[]> {
    const patches = includeReserved ? [ui200, ui240, reserved900] : [ui200, ui240];
    await seed(
      patchesDir,
      patches.map((metadata) => ({
        metadata,
        body: createDiff(metadata.filesAffected[0] ?? 'missing.js', 'export const value = 1;'),
      }))
    );
    return patches;
  }

  async function readManifestPatches(): Promise<PatchMetadata[]> {
    const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
    return (JSON.parse(raw) as PatchesManifest).patches;
  }

  it('creates an exact sparse --order patch without renumbering a later reserved patch', async () => {
    await seedSparseQueue();
    const plan = await resolvePlacementPlan(patchesDir, { order: 241 }, 'ui', 'new-feature');

    expect(plan.newFilename).toBe('241-ui-new-feature.patch');
    expect(plan.renameMap.size).toBe(0);

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { order: 241 },
        category: 'ui',
        name: 'new-feature',
        diff: createDiff('browser/base/content/new-feature.js', 'export const feature = 1;'),
        metadata: {
          ...makePolicyMetadata('241-ui-new-feature.patch', 241, 'ui', [
            'browser/base/content/new-feature.js',
          ]),
          name: 'new-feature',
          sourceEsrVersion: '140.9.0esr',
        },
        expectedPlan: plan,
        config: sparsePolicyConfig(),
      })
    ).resolves.toMatchObject({
      insertionOrder: 241,
      newFilename: '241-ui-new-feature.patch',
    });

    const entries = (await readdir(patchesDir)).filter((entry) => entry.endsWith('.patch')).sort();
    expect(entries).toEqual([
      '200-ui-shell.patch',
      '240-ui-something.patch',
      '241-ui-new-feature.patch',
      '900-infra-bindgen-basic-string-workaround.patch',
    ]);
    expect((await readManifestPatches()).map((patch) => patch.filename)).toEqual(entries);
  });

  it('leaves a reserved exact exception untouched when the insert lands on a free ordinal (FORGE G6)', async () => {
    const patches = await seedSparseQueue();
    const plan = await resolvePlacementPlan(
      patchesDir,
      { after: '240-ui-something.patch' },
      'ui',
      'new-feature'
    );

    // Order 241 is free, so the cascade never starts — nothing renames and
    // the reserved 900 patch stays out of the plan entirely.
    expect(plan.insertionOrder).toBe(241);
    expect(plan.renameMap.size).toBe(0);
    expect(() => {
      assertPlacementAvoidsReservedRanges(plan, patches, sparsePolicyConfig());
    }).not.toThrow();

    // With the config threaded through, the same positional insert resolves
    // up front instead of refusing via the reserved-range projection.
    await expect(
      resolvePlacementPlan(
        patchesDir,
        { after: '240-ui-something.patch' },
        'ui',
        'new-feature',
        sparsePolicyConfig()
      )
    ).resolves.toMatchObject({ insertionOrder: 241, newFilename: '241-ui-new-feature.patch' });
  });

  it('rejects exact --order when the requested order is occupied', async () => {
    await seedSparseQueue();

    await expect(
      resolvePlacementPlan(patchesDir, { order: 240 }, 'ui', 'new-feature')
    ).rejects.toThrow(/already occupied by 240-ui-something\.patch/);
  });

  it('lets policy reject exact --order outside the selected category range', async () => {
    await seedSparseQueue();
    const plan = computeExactPlacementPlan([ui200, ui240, reserved900], 'ui', 'wrong-range', 199);

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { order: 199 },
        category: 'ui',
        name: 'wrong-range',
        diff: createDiff('browser/base/content/wrong-range.js', 'export const wrong = 1;'),
        metadata: {
          ...makePolicyMetadata('199-ui-wrong-range.patch', 199, 'ui', [
            'browser/base/content/wrong-range.js',
          ]),
          name: 'wrong-range',
        },
        expectedPlan: plan,
        config: sparsePolicyConfig(),
      })
    ).rejects.toThrow(/ui patches must use 200-299/);
  });

  it('lets policy reject exact --order inside a reserved range', async () => {
    await seedSparseQueue(false);
    const plan = computeExactPlacementPlan([ui200, ui240], 'ui', 'reserved-slot', 900);

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { order: 900 },
        category: 'ui',
        name: 'reserved-slot',
        diff: createDiff('browser/base/content/reserved-slot.js', 'export const reserved = 1;'),
        metadata: {
          ...makePolicyMetadata('900-ui-reserved-slot.patch', 900, 'ui', [
            'browser/base/content/reserved-slot.js',
          ]),
          name: 'reserved-slot',
        },
        expectedPlan: plan,
        config: sparsePolicyConfig(),
      })
    ).rejects.toThrow(/reserved range 900-999/);
  });
});

describe('projectPlacementForLint', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-projectplacement-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('catches a forward-import authored by the pending patch itself', async () => {
    // Seed an existing patch that creates B.sys.mjs at order 5 (later).
    await seed(patchesDir, [
      {
        metadata: makeMetadata('005-infra-b.patch', 5, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);

    // Attempt to place a new patch at order 1 that imports from B.sys.mjs.
    // The fix must populate the synthetic entry's newFiles so the
    // forward-import rule can inspect this import; otherwise the
    // projection returns clean and the placement would go through.
    const newPatchDiff = createDiff(
      'foo/A.sys.mjs',
      'import { B } from "resource:///modules/B.sys.mjs";\nexport const A = B;'
    );
    const plan = computePlacementPlan(
      [makeMetadata('005-infra-b.patch', 5, ['foo/B.sys.mjs'])],
      'infra',
      'a',
      1
    );

    const conflicts = await projectPlacementForLint(patchesDir, plan, newPatchDiff);
    expect(conflicts).not.toBeNull();
    expect(conflicts?.reason).toContain('cross-patch lint error');
    expect(conflicts?.details.some((d) => d.includes('forward-import'))).toBe(true);
  });

  it('returns null when the pending patch does not forward-import', async () => {
    // Same setup as the first test but with a patch that does not
    // reference the later file — projection should be clean.
    await seed(patchesDir, [
      {
        metadata: makeMetadata('005-infra-b.patch', 5, ['foo/B.sys.mjs']),
        body: createDiff('foo/B.sys.mjs', 'export const B = 1;'),
      },
    ]);
    const newPatchDiff = createDiff('foo/A.sys.mjs', 'export const A = 1;');
    const plan = computePlacementPlan(
      [makeMetadata('005-infra-b.patch', 5, ['foo/B.sys.mjs'])],
      'infra',
      'a',
      1
    );

    const conflicts = await projectPlacementForLint(patchesDir, plan, newPatchDiff);
    expect(conflicts).toBeNull();
  });

  it('rejects a stale placement plan when the queue changes before commit', async () => {
    await seed(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: createDiff('foo/A.sys.mjs', 'export const A = 1;'),
      },
    ]);

    const expectedPlan = computePlacementPlan(
      [makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs'])],
      'infra',
      'new',
      1
    );

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
      commitPlacementExport({
        patchesDir,
        options: { before: '001-infra-a.patch' },
        category: 'infra',
        name: 'new',
        diff: createDiff('foo/New.sys.mjs', 'export const NewValue = 1;'),
        metadata: makeMetadata('001-infra-new.patch', 1, ['foo/New.sys.mjs']),
        expectedPlan,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(await readdir(patchesDir)).not.toContain('001-infra-new.patch');
  });

  it('rejects export placement into a reserved policy range', async () => {
    await seed(patchesDir, [
      {
        metadata: makeMetadata('900-infra-bootstrap.patch', 900, ['tools/build.rs']),
        body: createDiff('tools/build.rs', 'export const bootstrap = 1;'),
      },
    ]);
    const config: FireForgeConfig = {
      name: 'MyBrowser',
      vendor: 'Acme',
      appId: 'org.acme.browser',
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      patchPolicy: {
        ranges: [{ from: 200, to: 299, category: 'ui' }],
        reservedRanges: [{ from: 900, to: 999, allowed: [] }],
      },
    };
    const expectedPlan = computePlacementPlan(
      [makeMetadata('900-infra-bootstrap.patch', 900, ['tools/build.rs'])],
      'ui',
      'late-product',
      900
    );

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { before: '900-infra-bootstrap.patch' },
        category: 'ui',
        name: 'late-product',
        diff: createDiff('browser/base/content/product.js', 'export const product = 1;'),
        metadata: makeMetadata('900-ui-late-product.patch', 900, [
          'browser/base/content/product.js',
        ]),
        expectedPlan,
        config,
      })
    ).rejects.toThrow(/reserved range 900-999/);
  });
});

describe('renderDryRunPreview ownership overlap', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject('ff-export-dry-run-overlap-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('fails dry-run after surfacing partial ownership overlap', async () => {
    await seed(patchesDir, [
      {
        metadata: {
          ...makeMetadata('001-ui-owned.patch', 1, [
            'browser/base/content/mybrowser.xhtml',
            'browser/base/content/mybrowser.js',
          ]),
          category: 'ui',
        },
        body: createDiff('browser/base/content/mybrowser.xhtml', '<window />'),
      },
    ]);

    await expect(
      renderDryRunPreview({
        patchesDir,
        category: 'ui',
        name: 'audit-export-probe',
        description: '',
        filesAffected: ['browser/base/content/mybrowser.xhtml'],
        sourceEsrVersion: '140.9.0esr',
        explicitSupersede: false,
        allowOverlap: false,
      })
    ).rejects.toThrow(/cross-patch ownership overlap/i);

    expect(info).toHaveBeenCalledWith('\n[dry-run] No patches would be superseded.');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'browser/base/content/mybrowser.xhtml already claimed by: 001-ui-owned.patch'
      )
    );
  });

  it('prints acknowledged overlap when --allow-overlap is set', async () => {
    await seed(patchesDir, [
      {
        metadata: {
          ...makeMetadata('001-ui-owned.patch', 1, [
            'browser/base/content/mybrowser.xhtml',
            'browser/base/content/mybrowser.js',
          ]),
          category: 'ui',
        },
        body: createDiff('browser/base/content/mybrowser.xhtml', '<window />'),
      },
    ]);

    await expect(
      renderDryRunPreview({
        patchesDir,
        category: 'ui',
        name: 'audit-export-probe',
        description: '',
        filesAffected: ['browser/base/content/mybrowser.xhtml'],
        sourceEsrVersion: '140.9.0esr',
        explicitSupersede: false,
        allowOverlap: true,
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Would create cross-patch ownership overlap')
    );
  });
});

describe('commitPlacementExport rollback', () => {
  // These tests exercise the rollback path added after placement export
  // was found to mutate the queue irreversibly when a mid-commit step
  // (writeText or addPatchToManifest) failed after the forward
  // renumber had already succeeded. Plain export (commitExportedPatch)
  // had the rollback from day one; placement export did not.
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-placementrollback-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    // mockImplementationOnce is self-clearing: the one-shot override
    // fires during the test and leaves the default (delegating to the
    // real implementation) in place for subsequent tests. mockClear
    // wipes recorded calls without disturbing that default.
    vi.mocked(writeText).mockClear();
    vi.mocked(addPatchToManifest).mockClear();
    await removeTempProject(projectRoot);
  });

  async function seedTwoPatchQueue(): Promise<void> {
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
  }

  async function readManifestPatches(): Promise<PatchMetadata[]> {
    const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
    return (JSON.parse(raw) as PatchesManifest).patches;
  }

  it('restores queue state when writeText fails after renumber', async () => {
    await seedTwoPatchQueue();

    const expectedPlan = computePlacementPlan(
      [
        makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
      ],
      'infra',
      'new',
      1
    );

    // Forward renumber succeeds; writeText for the new patch file
    // simulates a disk failure.
    vi.mocked(writeText).mockImplementationOnce(() =>
      Promise.reject(new Error('simulated disk failure during new patch write'))
    );

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { before: '001-infra-a.patch' },
        category: 'infra',
        name: 'new',
        diff: createDiff('foo/New.sys.mjs', 'export const NewValue = 1;'),
        metadata: makeMetadata('001-infra-new.patch', 1, ['foo/New.sys.mjs']),
        expectedPlan,
      })
    ).rejects.toThrow('simulated disk failure');

    // Disk: original filenames restored, no new patch file left behind.
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-b.patch']);

    // Manifest: back to the original two entries at their original
    // orders, no partial new-patch row.
    const patches = await readManifestPatches();
    const byFile = new Map(patches.map((p) => [p.filesAffected[0] ?? '(none)', p] as const));
    expect(byFile.get('foo/A.sys.mjs')?.filename).toBe('001-infra-a.patch');
    expect(byFile.get('foo/A.sys.mjs')?.order).toBe(1);
    expect(byFile.get('foo/B.sys.mjs')?.filename).toBe('002-infra-b.patch');
    expect(byFile.get('foo/B.sys.mjs')?.order).toBe(2);
    expect(patches).toHaveLength(2);
  });

  it('swallows onCommitted hook failures so a failed audit log append does not fail the export', async () => {
    // Regression for the export --order history-append contract: the
    // hook runs INSIDE the patch directory lock after the mutation has
    // committed, so a throw in the hook (e.g. history jsonl write fails
    // on a readonly filesystem) must not leak out. By the time the hook
    // runs, the new patch file is on disk and the manifest row is
    // written — surfacing the hook error would misrepresent a committed
    // export as failed.
    await seedTwoPatchQueue();

    const expectedPlan = computePlacementPlan(
      [
        makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
      ],
      'infra',
      'new',
      1
    );

    let hookInvocations = 0;
    const throwingHook = (): Promise<void> => {
      hookInvocations += 1;
      return Promise.reject(new Error('simulated history-append failure'));
    };

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { before: '001-infra-a.patch' },
        category: 'infra',
        name: 'new',
        diff: createDiff('foo/New.sys.mjs', 'export const NewValue = 1;'),
        metadata: makeMetadata('001-infra-new.patch', 1, ['foo/New.sys.mjs']),
        expectedPlan,
        onCommitted: throwingHook,
      })
    ).resolves.toBeDefined();

    expect(hookInvocations).toBe(1);

    // The mutation landed: directory has the three patch files with
    // the forward renumber applied, and the manifest records them all.
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-new.patch', '002-infra-a.patch', '003-infra-b.patch']);

    const patches = await readManifestPatches();
    const byFile = new Map(patches.map((p) => [p.filesAffected[0] ?? '(none)', p] as const));
    expect(byFile.get('foo/New.sys.mjs')?.order).toBe(1);
    expect(byFile.get('foo/A.sys.mjs')?.order).toBe(2);
    expect(byFile.get('foo/B.sys.mjs')?.order).toBe(3);
  });

  it('restores queue state when addPatchToManifest fails after writeText', async () => {
    await seedTwoPatchQueue();

    const expectedPlan = computePlacementPlan(
      [
        makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
      ],
      'infra',
      'new',
      1
    );

    // Forward renumber + writeText succeed; addPatchToManifest throws.
    vi.mocked(addPatchToManifest).mockImplementationOnce(() =>
      Promise.reject(new Error('simulated manifest write failure'))
    );

    await expect(
      commitPlacementExport({
        patchesDir,
        options: { before: '001-infra-a.patch' },
        category: 'infra',
        name: 'new',
        diff: createDiff('foo/New.sys.mjs', 'export const NewValue = 1;'),
        metadata: makeMetadata('001-infra-new.patch', 1, ['foo/New.sys.mjs']),
        expectedPlan,
      })
    ).rejects.toThrow('simulated manifest write failure');

    // Disk: original filenames restored, new patch file removed.
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-b.patch']);

    // Manifest: restored to original via the belt-and-braces snapshot
    // rewrite so a partial addPatchToManifest cannot leak through.
    const patches = await readManifestPatches();
    expect(patches).toHaveLength(2);
    const byFile = new Map(patches.map((p) => [p.filesAffected[0] ?? '(none)', p] as const));
    expect(byFile.get('foo/A.sys.mjs')?.order).toBe(1);
    expect(byFile.get('foo/B.sys.mjs')?.order).toBe(2);
  });
});
