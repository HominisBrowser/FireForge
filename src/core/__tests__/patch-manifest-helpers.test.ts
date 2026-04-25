// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-file-ops.js', () => ({
  fileExistsInHead: vi.fn(),
}));

import { writeFiles } from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { fileExistsInHead } from '../git-file-ops.js';
import {
  addPatchToManifest,
  checkVersionCompatibility,
  findPatchesAffectingFile,
  loadPatchesManifest,
  resolvePatchIdentifier,
  validatePatchIntegrity,
} from '../patch-manifest.js';

const TOOLBAR_PATCH = [
  'diff --git a/browser/toolbar.js b/browser/toolbar.js',
  '--- a/browser/toolbar.js',
  '+++ b/browser/toolbar.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const NEW_WIDGET_PATCH = [
  'diff --git a/browser/new-widget.js b/browser/new-widget.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/browser/new-widget.js',
  '@@ -0,0 +1 @@',
  '+export const widget = true;',
  '',
].join('\n');

describe('patch manifest helper coverage', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reports compatibility cleanly for matching, minor-drift, and major-drift versions', () => {
    expect(checkVersionCompatibility('140.9.0esr', '140.9.0esr')).toBeNull();
    expect(checkVersionCompatibility('140.1esr', '140.2esr')).toBe(
      'Patch was created for Firefox 140.1esr, current version is 140.2esr.'
    );
    expect(checkVersionCompatibility('140.9.0esr', '141.0esr')).toContain(
      'Major version mismatch may cause conflicts.'
    );
  });

  it('finds and sorts only the patches that affect a requested file', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-helpers-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      '002-ui-new-widget.patch': NEW_WIDGET_PATCH,
      '003-ui-toolbar-followup.patch': TOOLBAR_PATCH,
      'patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '003-ui-toolbar-followup.patch',
              order: 3,
              category: 'ui',
              name: 'toolbar-followup',
              description: 'Second toolbar patch',
              createdAt: '2026-01-03T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/toolbar.js'],
            },
            {
              filename: '001-ui-toolbar.patch',
              order: 1,
              category: 'ui',
              name: 'toolbar',
              description: 'First toolbar patch',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/toolbar.js'],
            },
            {
              filename: '002-ui-new-widget.patch',
              order: 2,
              category: 'ui',
              name: 'new-widget',
              description: 'Adds widget',
              createdAt: '2026-01-02T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/new-widget.js'],
            },
          ],
        },
        null,
        2
      )}\n`,
    });

    const results = await findPatchesAffectingFile(patchesDir, 'browser/toolbar.js');

    expect(results.map((result) => result.patch.filename)).toEqual([
      '001-ui-toolbar.patch',
      '003-ui-toolbar-followup.patch',
    ]);
    expect(results.map((result) => result.metadata.name)).toEqual(['toolbar', 'toolbar-followup']);
  });

  it('reports only missing modification targets during patch integrity validation', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-helpers-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      '002-ui-new-widget.patch': NEW_WIDGET_PATCH,
    });

    vi.mocked(fileExistsInHead).mockImplementation((_engineDir, filePath) =>
      Promise.resolve(filePath !== 'browser/toolbar.js')
    );

    const issues = await validatePatchIntegrity(patchesDir, '/engine');

    expect(fileExistsInHead).toHaveBeenCalledWith('/engine', 'browser/toolbar.js');
    expect(fileExistsInHead).not.toHaveBeenCalledWith('/engine', 'browser/new-widget.js');
    expect(issues).toEqual([
      {
        filename: '001-ui-toolbar.patch',
        message:
          "Modification patch for file that doesn't exist in source. Re-export with: fireforge export browser/toolbar.js",
        targetFile: 'browser/toolbar.js',
      },
    ]);
  });

  it('adds patch metadata while removing superseded entries and preserving sort order', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-helpers-'));
    tempDirs.push(patchesDir);

    await addPatchToManifest(patchesDir, {
      filename: '002-ui-second.patch',
      order: 2,
      category: 'ui',
      name: 'second',
      description: 'Second patch',
      createdAt: '2026-01-02T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/second.js'],
    });

    await addPatchToManifest(patchesDir, {
      filename: '001-ui-first.patch',
      order: 1,
      category: 'ui',
      name: 'first',
      description: 'First patch',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/first.js'],
    });

    await addPatchToManifest(
      patchesDir,
      {
        filename: '003-ui-third.patch',
        order: 3,
        category: 'ui',
        name: 'third',
        description: 'Third patch',
        createdAt: '2026-01-03T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['browser/third.js'],
      },
      ['002-ui-second.patch']
    );

    const manifest = await loadPatchesManifest(patchesDir);

    expect(manifest?.patches.map((patch) => patch.filename)).toEqual([
      '001-ui-first.patch',
      '003-ui-third.patch',
    ]);
  });

  it('replaces an existing manifest entry with the same filename instead of duplicating it', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-helpers-'));
    tempDirs.push(patchesDir);

    await addPatchToManifest(patchesDir, {
      filename: '001-ui-first.patch',
      order: 3,
      category: 'ui',
      name: 'first-old',
      description: 'Old patch metadata',
      createdAt: '2026-01-03T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/first.js'],
    });

    await addPatchToManifest(patchesDir, {
      filename: '002-ui-second.patch',
      order: 2,
      category: 'ui',
      name: 'second',
      description: 'Second patch',
      createdAt: '2026-01-02T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/second.js'],
    });

    await addPatchToManifest(patchesDir, {
      filename: '001-ui-first.patch',
      order: 1,
      category: 'ui',
      name: 'first-new',
      description: 'Updated patch metadata',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/first.js'],
    });

    const manifest = await loadPatchesManifest(patchesDir);

    expect(manifest?.patches).toHaveLength(2);
    expect(manifest?.patches.map((patch) => `${patch.filename}:${patch.name}`)).toEqual([
      '001-ui-first.patch:first-new',
      '002-ui-second.patch:second',
    ]);
  });
});

describe('resolvePatchIdentifier', () => {
  const fixturePatches: PatchMetadata[] = [
    {
      filename: '001-infra-bindgen-basic-string-workaround.patch',
      order: 1,
      category: 'infra',
      name: 'bindgen-basic-string-workaround',
      description: 'bindgen workaround',
      createdAt: '2026-04-21T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['tools/profiler/rust-api/build.rs'],
    },
    {
      filename: '002-ui-eval-furnace-token-override.patch',
      order: 2,
      category: 'ui',
      name: 'eval-furnace-token-override',
      description: 'Furnace CSS override',
      createdAt: '2026-04-21T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['toolkit/content/widgets/moz-button/moz-button.css'],
    },
  ];

  it('resolves by ordinal number', () => {
    expect(resolvePatchIdentifier('2', fixturePatches)).toMatchObject({
      filename: '002-ui-eval-furnace-token-override.patch',
    });
  });

  it('resolves by full filename with .patch suffix', () => {
    expect(
      resolvePatchIdentifier('002-ui-eval-furnace-token-override.patch', fixturePatches)
    ).toMatchObject({ name: 'eval-furnace-token-override' });
  });

  it('resolves by filename without the .patch suffix', () => {
    expect(
      resolvePatchIdentifier('002-ui-eval-furnace-token-override', fixturePatches)
    ).toMatchObject({ name: 'eval-furnace-token-override' });
  });

  it('resolves by manifest `name` field (Eval 1 Finding #6)', () => {
    // The eval showed `patch reorder eval-furnace-token-override` being
    // rejected because the resolver only knew filenames. Accepting the
    // `name` handle matches the CLI help and `patches.json` schema.
    expect(resolvePatchIdentifier('eval-furnace-token-override', fixturePatches)).toMatchObject({
      filename: '002-ui-eval-furnace-token-override.patch',
    });
  });

  it('returns null for an unknown identifier', () => {
    expect(resolvePatchIdentifier('does-not-exist', fixturePatches)).toBeNull();
  });
});
