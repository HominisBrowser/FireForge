// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch reorder --shift <n> --from <order> [--through <order>]` opens room
 * for inserts in one transaction: the run moves up, the slots inside it
 * move with it, a landing on an occupied order refuses, and under
 * `patchPolicy.allowGaps: false` the opened orders are reserved so the
 * queue stays valid. `--map-out` writes the old-to-new filename map.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evaluatePatchPolicy } from '../../core/patch-policy.js';
import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { PatchPolicyConfig } from '../../types/config.js';
import { ensureDir } from '../../utils/fs.js';
import { patchReorderCommand } from '../patch/reorder.js';

const POLICY = {
  ranges: [
    { from: 200, to: 299, category: 'ui' },
    { from: 500, to: 599, category: 'infra' },
  ],
  allowGaps: false,
} satisfies PatchPolicyConfig;

function meta(order: number, category = 'ui'): PatchMetadata {
  return {
    filename: `${order}-${category}-p${order}.patch`,
    order,
    category,
    name: `p${order}`,
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [`ui/P${order}.sys.mjs`],
  };
}

async function seed(
  patchesDir: string,
  rows: PatchMetadata[],
  extra: Partial<PatchesManifest> = {}
): Promise<void> {
  await ensureDir(patchesDir);
  for (const row of rows) {
    await writeFile(join(patchesDir, row.filename), `# ${row.order}\n`);
  }
  const manifest: PatchesManifest = { version: 1, patches: rows, ...extra };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function readManifest(patchesDir: string): Promise<PatchesManifest> {
  return JSON.parse(await readFile(join(patchesDir, 'patches.json'), 'utf8')) as PatchesManifest;
}

describe('patch reorder --shift', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-shift-');
    patchesDir = join(projectRoot, 'patches');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('shifts the run, reserves the opened orders under allowGaps: false, and writes the map', async () => {
    await writeFireForgeConfig(projectRoot, { patchPolicy: POLICY });
    await seed(patchesDir, [meta(201), meta(202), meta(203), meta(204), meta(501, 'infra')], {
      retired: [
        {
          order: 205,
          category: 'ui',
          filename: '205-ui-gone.patch',
          retiredAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    const mapOut = join(projectRoot, 'shift-map.json');

    await patchReorderCommand(projectRoot, undefined, { shift: 2, from: 203, yes: true, mapOut });

    const manifest = await readManifest(patchesDir);
    expect(manifest.patches.map((p) => p.filename)).toEqual([
      '201-ui-p201.patch',
      '202-ui-p202.patch',
      '205-ui-p203.patch',
      '206-ui-p204.patch',
      '501-infra-p501.patch',
    ]);
    // The retired slot inside the run (205, the default --through) moved with it.
    expect(manifest.retired?.map((slot) => slot.order)).toEqual([207]);
    expect(manifest.reserved).toEqual([
      expect.objectContaining({ order: 203, category: 'ui', owner: 'patch reorder --shift' }),
      expect.objectContaining({ order: 204, category: 'ui', owner: 'patch reorder --shift' }),
    ]);
    expect(evaluatePatchPolicy({ ...DEFAULT_CONFIG, patchPolicy: POLICY }, manifest)).toEqual([]);
    expect((await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort()).toEqual(
      manifest.patches.map((p) => p.filename)
    );
    expect(JSON.parse(await readFile(mapOut, 'utf8'))).toEqual({
      '203-ui-p203.patch': '205-ui-p203.patch',
      '204-ui-p204.patch': '206-ui-p204.patch',
    });
  });

  it('honours --through and records no reservation without allowGaps: false', async () => {
    await writeFireForgeConfig(projectRoot);
    await seed(patchesDir, [meta(1), meta(2), meta(3), meta(4), meta(10)]);

    // --through 3 stops the run before 4, so the shift by 1 lands on 4.
    await expect(
      patchReorderCommand(projectRoot, undefined, { shift: 1, from: 2, through: 3, yes: true })
    ).rejects.toThrow(/onto order 004, which 4-ui-p4\.patch holds/);

    await patchReorderCommand(projectRoot, undefined, {
      shift: 3,
      from: 2,
      through: 4,
      yes: true,
    });

    const manifest = await readManifest(patchesDir);
    expect(manifest.patches.map((p) => p.order)).toEqual([1, 5, 6, 7, 10]);
    expect(manifest.patches.map((p) => p.filename)).toContain('005-ui-p2.patch');
    expect(manifest.reserved).toBeUndefined();
  });

  it('refuses a shift that lands on an occupied order past the run', async () => {
    await writeFireForgeConfig(projectRoot);
    await seed(patchesDir, [meta(1), meta(2), meta(3), meta(10)]);
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');

    await expect(
      patchReorderCommand(projectRoot, undefined, { shift: 7, from: 2, yes: true })
    ).rejects.toThrow(/onto order 010, which 10-ui-p10\.patch holds/);
    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
  });

  it('dry run writes nothing', async () => {
    await writeFireForgeConfig(projectRoot);
    await seed(patchesDir, [meta(1), meta(2)]);
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');

    await patchReorderCommand(projectRoot, undefined, { shift: 1, from: 1, dryRun: true });

    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
  });

  it('rejects a patch name or --to beside --shift, and --shift without --from', async () => {
    await writeFireForgeConfig(projectRoot);
    await seed(patchesDir, [meta(1), meta(2)]);
    await expect(
      patchReorderCommand(projectRoot, '1', { shift: 1, from: 1, yes: true })
    ).rejects.toThrow(/takes no patch name/);
    await expect(patchReorderCommand(projectRoot, undefined, { shift: 1 })).rejects.toThrow(
      /--shift <n> and --from <order> go together/
    );
    await expect(patchReorderCommand(projectRoot, undefined, {})).rejects.toThrow(
      /Name the patch to move/
    );
  });

  it('--map-out records a single-patch reorder too', async () => {
    await writeFireForgeConfig(projectRoot);
    await seed(patchesDir, [meta(1), meta(2), meta(3)]);
    const mapOut = join(projectRoot, 'reorder-map.json');

    await patchReorderCommand(projectRoot, '3', { to: 1, yes: true, mapOut });

    expect(JSON.parse(await readFile(mapOut, 'utf8'))).toEqual({
      '3-ui-p3.patch': '001-ui-p3.patch',
      '1-ui-p1.patch': '002-ui-p1.patch',
      '2-ui-p2.patch': '003-ui-p2.patch',
    });
  });
});
