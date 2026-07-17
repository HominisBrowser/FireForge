// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the reserved-range placement gate. A positional insert
 * that would renumber patches through a `patchPolicy.reservedRanges`
 * block must fail with ONE up-front error (not one confusing per-patch
 * policy finding per shifted patch), suggesting the first free --order
 * below the reserved block when one exists.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { ensureDir } from '../../utils/fs.js';
import { computePlacementPlan, resolvePlacementPlan } from '../export-flow.js';
import { assertPlacementAvoidsReservedRanges } from '../export-placement-policy.js';

function makeMetadata(filename: string, order: number): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-[a-z0-9-]+-/, '').replace(/\.patch$/, ''),
    description: 'test patch',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [`browser/${filename}.js`],
  };
}

function reservedConfig(reserved: { from: number; to: number }): FireForgeConfig {
  return {
    name: 'MyBrowser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    patchPolicy: {
      ranges: [{ from: 1, to: 200, category: 'ui' }],
      reservedRanges: [{ ...reserved, allowed: [] }],
    },
  };
}

describe('assertPlacementAvoidsReservedRanges', () => {
  it('throws a single error when a positional insert shifts multiple patches through a reserved range', () => {
    // Orders 90, 94 are regular; 95 and 96 sit inside the reserved block.
    // Inserting before 94 shifts 94→95 (into the block) and 95→96, 96→97
    // (out of their reserved slots) — three hits, one error.
    const patches = [
      makeMetadata('090-ui-early.patch', 90),
      makeMetadata('094-ui-late.patch', 94),
      makeMetadata('095-ui-reserved-a.patch', 95),
      makeMetadata('096-ui-reserved-b.patch', 96),
    ];
    const plan = computePlacementPlan(patches, 'ui', 'incoming', 94);
    expect(plan.renameMap.size).toBe(3);

    expect(() => {
      assertPlacementAvoidsReservedRanges(plan, patches, reservedConfig({ from: 95, to: 100 }));
    }).toThrow(
      'Positional insert would renumber the reserved range 095-100; pass --order 093 ' +
        '(first free order below the reserved block) to place the new patch without ' +
        'renumbering reserved patches.'
    );
  });

  it('suggests the first free order below the block, skipping occupied orders', () => {
    // 94 and 93 are occupied, so the suggestion must fall through to 092.
    const patches = [
      makeMetadata('093-ui-a.patch', 93),
      makeMetadata('094-ui-b.patch', 94),
      makeMetadata('095-ui-reserved.patch', 95),
    ];
    const plan = computePlacementPlan(patches, 'ui', 'incoming', 93);

    expect(() => {
      assertPlacementAvoidsReservedRanges(plan, patches, reservedConfig({ from: 95, to: 100 }));
    }).toThrow(/pass --order 092/);
  });

  it('falls back to the no-free-slot message when every order below the block is taken', () => {
    const patches = [makeMetadata('001-ui-a.patch', 1), makeMetadata('002-ui-reserved.patch', 2)];
    const plan = computePlacementPlan(patches, 'ui', 'incoming', 1);

    expect(() => {
      assertPlacementAvoidsReservedRanges(plan, patches, reservedConfig({ from: 2, to: 5 }));
    }).toThrow(
      'Positional insert would renumber the reserved range 002-005; no free order exists ' +
        'below the reserved block. Choose an unused --order outside the reserved range or ' +
        'adjust patchPolicy.reservedRanges.'
    );
  });

  it('passes plans that shift patches without touching a reserved range', () => {
    const patches = [makeMetadata('010-ui-a.patch', 10), makeMetadata('011-ui-b.patch', 11)];
    const plan = computePlacementPlan(patches, 'ui', 'incoming', 10);

    expect(() => {
      assertPlacementAvoidsReservedRanges(plan, patches, reservedConfig({ from: 95, to: 100 }));
    }).not.toThrow();
  });
});

describe('resolvePlacementPlan reserved-range wiring', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-placement-policy-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  async function seed(patches: PatchMetadata[]): Promise<void> {
    await ensureDir(patchesDir);
    for (const patch of patches) {
      await writeFile(join(patchesDir, patch.filename), `# stub body for ${patch.filename}\n`);
    }
    const manifest: PatchesManifest = { version: 1, patches };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  }

  it('does not block an exact --order below the reserved block', async () => {
    await seed([makeMetadata('094-ui-late.patch', 94), makeMetadata('095-ui-reserved.patch', 95)]);

    const plan = await resolvePlacementPlan(
      patchesDir,
      { order: 93 },
      'ui',
      'incoming',
      reservedConfig({ from: 95, to: 100 })
    );

    expect(plan.insertionOrder).toBe(93);
    expect(plan.renameMap.size).toBe(0);
  });

  it('refuses a --before insert that would renumber through the reserved block', async () => {
    await seed([makeMetadata('094-ui-late.patch', 94), makeMetadata('095-ui-reserved.patch', 95)]);

    await expect(
      resolvePlacementPlan(
        patchesDir,
        { before: '094-ui-late.patch' },
        'ui',
        'incoming',
        reservedConfig({ from: 95, to: 100 })
      )
    ).rejects.toThrow(/Positional insert would renumber the reserved range 095-100/);
  });
});
