// SPDX-License-Identifier: EUPL-1.2
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { mutatePatchRowsInManifest, savePatchesManifest } from '../patch-manifest-io.js';
import { canonicalizeManifest, canonicalizePatchRow } from '../patch-manifest-key-order.js';
import { stampPatchVersions } from '../patch-manifest-query.js';
import { mergeStagedManifest, serializeStagedManifest } from '../patch-manifest-stage.js';
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
  // Deliberately scrambled: the shape a hand edit or a non-canonical writer leaves.
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
  /**
   * Mixed-order drift: rows with `sourceProduct` after the arrays, next to
   * rows already canonical, under scrambled top-level keys. A row mutation
   * canonicalizes every row, not only the rows it changed; otherwise the
   * working copy keeps the non-canonical rows while `patch stage`
   * canonicalizes them in the index, and every commit flips hundreds of rows.
   */
  function mixedOrderManifest(): { patches: Record<string, unknown>[]; version: number } {
    const legacy = (n: number): Record<string, unknown> => ({
      filename: `00${n}-ui-l${n}.patch`,
      order: n,
      category: 'ui',
      name: `l${n}`,
      description: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.0esr',
      sourceVersion: '140.0esr',
      filesAffected: [`l${n}.js`],
      sourceProduct: 'firefox-esr',
      stagedDependencies: {
        registrations: [
          {
            file: 'browser/base/jar.mn',
            line: `content/l${n}.js`,
            creates: `browser/base/content/l${n}.js`,
            owner: `00${n}-ui-l${n}.patch`,
          },
        ],
      },
    });
    return {
      patches: [canonicalizePatchRow({ ...row() }), legacy(2), legacy(3)],
      version: 1,
    };
  }

  async function writeMixed(): Promise<void> {
    await writeFile(
      join(patchesDir, 'patches.json'),
      `${JSON.stringify(mixedOrderManifest(), null, 2)}\n`
    );
  }

  it('every writer turns a mixed-order manifest into the same canonical bytes', async () => {
    const path = join(patchesDir, 'patches.json');
    const expected = `${JSON.stringify(canonicalizeManifest(mixedOrderManifest()), null, 2)}\n`;
    const outputs = new Map<string, string>();

    await writeMixed();
    await savePatchesManifest(patchesDir, validatePatchesManifest(mixedOrderManifest()));
    outputs.set('savePatchesManifest', await readFile(path, 'utf-8'));

    // A re-export of one row: the others must not keep the non-canonical order.
    await writeMixed();
    await mutatePatchRowsInManifest(patchesDir, ['001-ui-a.patch'], () => ({
      set: { description: '' },
    }));
    outputs.set('mutatePatchRowsInManifest', await readFile(path, 'utf-8'));

    await writeMixed();
    await stampPatchVersions(patchesDir, ['002-ui-l2.patch'], '140.0esr', 'firefox');
    outputs.set(
      'stampPatchVersions',
      (await readFile(path, 'utf-8')).replace(
        '"sourceProduct": "firefox"',
        '"sourceProduct": "firefox-esr"'
      )
    );

    const parsed = validatePatchesManifest(mixedOrderManifest());
    outputs.set(
      'patch stage',
      serializeStagedManifest(
        mergeStagedManifest(parsed, parsed, new Set(['003-ui-l3.patch'])).manifest
      )
    );

    for (const [writer, output] of outputs) {
      expect(output, writer).toBe(expected);
    }
  });
});
