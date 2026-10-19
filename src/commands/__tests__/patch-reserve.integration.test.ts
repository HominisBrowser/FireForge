// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `patch reserve` and the reserved-slot placeholder:
 * the gap check accepts it, the earliest-legal-order search skips it, every
 * manifest write keeps it, and the export that takes the order fills it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HISTORY_LOG_PATH } from '../../core/history-log-file.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { addPatchToManifest, loadPatchesManifest } from '../../core/patch-manifest.js';
import { earliestLegalOrderAfter } from '../../core/patch-order-legal.js';
import { evaluatePatchPolicy } from '../../core/patch-policy.js';
import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig, PatchPolicyConfig } from '../../types/config.js';
import { ensureDir } from '../../utils/fs.js';
import { registerPatch } from '../patch/index.js';
import { patchReserveCommand } from '../patch/reserve.js';

const POLICY = {
  ranges: [
    { from: 200, to: 299, category: 'ui' },
    { from: 500, to: 599, category: 'infra' },
  ],
  allowGaps: false,
} satisfies PatchPolicyConfig;
const POLICY_CONFIG: FireForgeConfig = { ...DEFAULT_CONFIG, patchPolicy: POLICY };

function meta(order: number): PatchMetadata {
  return {
    filename: `${order}-ui-p${order}.patch`,
    order,
    category: 'ui',
    name: `p${order}`,
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [`ui/P${order}.sys.mjs`],
  };
}

async function seed(patchesDir: string, orders: number[]): Promise<void> {
  await ensureDir(patchesDir);
  for (const order of orders) {
    await writeFile(join(patchesDir, `${order}-ui-p${order}.patch`), `# ${order}\n`);
  }
  const manifest: PatchesManifest = { version: 1, patches: orders.map(meta) };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function readManifest(patchesDir: string): Promise<PatchesManifest> {
  return JSON.parse(await readFile(join(patchesDir, 'patches.json'), 'utf8')) as PatchesManifest;
}

describe('patch reserve', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-reserve-');
    await writeFireForgeConfig(projectRoot, { patchPolicy: POLICY });
    patchesDir = join(projectRoot, 'patches');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('holds claimed orders so a later export leaves no numeric gap', async () => {
    await seed(patchesDir, [201, 202]);

    await patchReserveCommand(projectRoot, 203, {
      category: 'ui',
      owner: 'peer-lane',
      reason: 'command bar',
    });
    await patchReserveCommand(projectRoot, 204, { category: 'ui', owner: 'peer-lane' });

    const manifest = await readManifest(patchesDir);
    expect(manifest.reserved).toEqual([
      expect.objectContaining({
        order: 203,
        category: 'ui',
        owner: 'peer-lane',
        reason: 'command bar',
      }),
      expect.objectContaining({ order: 204, owner: 'peer-lane' }),
    ]);

    // 205 lands past the reservations: no gap with them, a gap without.
    const projected: PatchesManifest = { ...manifest, patches: [...manifest.patches, meta(205)] };
    expect(evaluatePatchPolicy(POLICY_CONFIG, projected)).toEqual([]);
    expect(
      evaluatePatchPolicy(POLICY_CONFIG, { version: 1, patches: projected.patches }).map(
        (issue) => issue.code
      )
    ).toEqual(['numeric-gap']);

    // The earliest legal order skips orders held for their owner.
    expect(earliestLegalOrderAfter(POLICY_CONFIG, manifest, 'ui', 202)).toBe(205);

    const history = (await readFile(join(projectRoot, DEFAULT_HISTORY_LOG_PATH), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { operation: string; args: { order: number } });
    expect(history.map((record) => [record.operation, record.args.order])).toEqual([
      ['patch-reserve', 203],
      ['patch-reserve', 204],
    ]);
  });

  it('is filled (dropped) by the patch that takes its order and kept by unrelated writes', async () => {
    await seed(patchesDir, [201]);
    await patchReserveCommand(projectRoot, 202, { category: 'ui', owner: 'a' });
    await patchReserveCommand(projectRoot, 203, { category: 'ui', owner: 'b' });

    await withPatchDirectoryLock(patchesDir, () => addPatchToManifest(patchesDir, meta(202)));

    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.reserved?.map((slot) => slot.order)).toEqual([203]);
  });

  it('--release drops a reservation and refuses one that does not exist', async () => {
    await seed(patchesDir, [201]);
    await patchReserveCommand(projectRoot, 202, { category: 'ui', owner: 'a' });

    await patchReserveCommand(projectRoot, 202, { release: true });
    expect((await readManifest(patchesDir)).reserved).toBeUndefined();

    await expect(patchReserveCommand(projectRoot, 202, { release: true })).rejects.toThrow(
      /not reserved/
    );
  });

  it('refuses an order a patch, a retired slot or another reservation holds', async () => {
    await seed(patchesDir, [201]);
    const raw = await readManifest(patchesDir);
    raw.retired = [
      { order: 202, category: 'ui', filename: '202-ui-old.patch', retiredAt: '2025-01-01' },
    ];
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(raw, null, 2));

    await expect(
      patchReserveCommand(projectRoot, 201, { category: 'ui', owner: 'a' })
    ).rejects.toThrow(/taken by 201-ui-p201\.patch/);
    await expect(
      patchReserveCommand(projectRoot, 202, { category: 'ui', owner: 'a' })
    ).rejects.toThrow(/retired slot/);

    await patchReserveCommand(projectRoot, 203, { category: 'ui', owner: 'a' });
    await expect(
      patchReserveCommand(projectRoot, 203, { category: 'ui', owner: 'b' })
    ).rejects.toThrow(/already reserved by a/);
  });

  it('refuses an order outside the category range, and missing or misplaced flags', async () => {
    await seed(patchesDir, [201]);
    await expect(
      patchReserveCommand(projectRoot, 510, { category: 'ui', owner: 'a' })
    ).rejects.toThrow(/outside the ui range \(200-299\)/);
    await expect(patchReserveCommand(projectRoot, 210, { owner: 'a' })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(
      patchReserveCommand(projectRoot, 210, { category: 'nope', owner: 'a' })
    ).rejects.toThrow(/Unknown patch category/);
    await expect(
      patchReserveCommand(projectRoot, 210, { release: true, owner: 'a' })
    ).rejects.toThrow(/--release takes only the order/);
  });

  it('--dry-run changes nothing', async () => {
    await seed(patchesDir, [201]);
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');
    await patchReserveCommand(projectRoot, 202, { category: 'ui', owner: 'a', dryRun: true });
    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
  });

  it('rejects a malformed reserved list as manifest corruption', async () => {
    await seed(patchesDir, [201]);
    const raw = await readManifest(patchesDir);
    await writeFile(
      join(patchesDir, 'patches.json'),
      JSON.stringify({ ...raw, reserved: [{ order: 202, category: 'ui', owner: '' }] })
    );
    // A manifest that does not validate loads as null (corrupt), never as
    // a queue that silently lost the reservation.
    expect(await loadPatchesManifest(patchesDir)).toBeNull();
  });

  it('wires `patch reserve` through the CLI', async () => {
    await seed(patchesDir, [201]);
    const context: CommandContext = {
      getProjectRoot: () => projectRoot,
      withErrorHandling:
        <T extends unknown[]>(handler: (...args: T) => Promise<void>) =>
        (...args: T) =>
          handler(...args),
    };
    const program = new Command();
    registerPatch(program, context);

    await program.parseAsync([
      'node',
      'fireforge',
      'patch',
      'reserve',
      '202',
      '--category',
      'ui',
      '--owner',
      'lane-b',
    ]);

    expect((await readManifest(patchesDir)).reserved?.map((slot) => slot.owner)).toEqual([
      'lane-b',
    ]);
  });
});
