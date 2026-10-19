// SPDX-License-Identifier: EUPL-1.2
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { mutatePatchRowsInManifest, savePatchesManifest } from '../patch-manifest-io.js';
import { canonicalizeManifest, canonicalizePatchRow } from '../patch-manifest-key-order.js';
import { validatePatchesManifest } from '../patch-manifest-validate.js';

const CANONICAL = [
  'filename',
  'order',
  'category',
  'name',
  'description',
  'createdAt',
  'sourceEsrVersion',
  'sourceProduct',
  'sourceVersion',
  'filesAffected',
  'lintIgnore',
];

function row(): PatchMetadata {
  // Deliberately scrambled: the shape a hand edit or an older writer leaves.
  return {
    filesAffected: ['a.js'],
    lintIgnore: ['large-patch-lines'],
    sourceProduct: 'firefox-esr',
    filename: '001-ui-a.patch',
    order: 1,
    category: 'ui',
    name: 'a',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceVersion: '140.0esr',
    sourceEsrVersion: '140.0esr',
  };
}

describe('canonicalizePatchRow', () => {
  it('orders known keys as PatchMetadata declares them', () => {
    expect(Object.keys(canonicalizePatchRow(row()))).toEqual(CANONICAL);
  });

  it('keeps unknown keys after the known ones, in their own order', () => {
    const ordered = canonicalizePatchRow({ zeta: 1, ...row(), alpha: 2 });
    expect(Object.keys(ordered).slice(-2)).toEqual(['zeta', 'alpha']);
  });

  it('orders the manifest keys and every row', () => {
    const manifest = canonicalizeManifest({
      retired: [],
      patches: [row()],
      version: 1,
    });
    expect(Object.keys(manifest)).toEqual(['version', 'patches', 'retired']);
    expect(Object.keys(manifest.patches[0] as object)).toEqual(CANONICAL);
  });
});

describe('patches.json writers agree on key order', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-key-order-');
    patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('the validator returns rows in canonical order', () => {
    const manifest = validatePatchesManifest({ version: 1, patches: [row()] });
    expect(Object.keys(manifest.patches[0] as object)).toEqual(CANONICAL);
  });

  it('a full save and a row mutation produce the same bytes', async () => {
    await savePatchesManifest(patchesDir, { version: 1, patches: [row()] });
    const saved = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

    await writeFile(
      join(patchesDir, 'patches.json'),
      JSON.stringify({ version: 1, patches: [{ ...row(), description: 'x' }] }, null, 2)
    );
    await mutatePatchRowsInManifest(patchesDir, ['001-ui-a.patch'], () => ({
      set: { description: '' },
    }));
    const mutated = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

    expect(mutated).toBe(saved);
  });
});
