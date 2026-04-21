// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFiles } from '../../test-utils/index.js';
import {
  loadPatchesManifest,
  rebuildPatchesManifest,
  validatePatchesManifestConsistency,
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

const SIDEBAR_PATCH = [
  'diff --git a/browser/sidebar.js b/browser/sidebar.js',
  '--- a/browser/sidebar.js',
  '+++ b/browser/sidebar.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('patch manifest consistency', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reports no issues for a fresh project with an empty manifest', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      'patches.json': `${JSON.stringify({ version: 1, patches: [] }, null, 2)}\n`,
    });

    const issues = await validatePatchesManifestConsistency(patchesDir);

    expect(issues).toEqual([]);
  });

  it('reports patch files when patches.json is missing', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
    });

    const issues = await validatePatchesManifestConsistency(patchesDir);

    expect(issues).toEqual([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file(s) exist.',
      },
    ]);
  });

  it('reports metadata drift and untracked patch files', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      '002-ui-sidebar.patch': SIDEBAR_PATCH,
      'patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-ui-toolbar.patch',
              order: 1,
              category: 'ui',
              name: 'toolbar',
              description: 'Toolbar tweak',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/wrong.js'],
            },
          ],
        },
        null,
        2
      )}\n`,
    });

    const issues = await validatePatchesManifestConsistency(patchesDir);

    expect(issues).toEqual([
      {
        code: 'files-affected-mismatch',
        filename: '001-ui-toolbar.patch',
        message:
          '001-ui-toolbar.patch declares [browser/wrong.js] in patches.json but the patch file targets [browser/toolbar.js].',
      },
      {
        code: 'untracked-patch-file',
        filename: '002-ui-sidebar.patch',
        message: '002-ui-sidebar.patch exists on disk but is not tracked in patches.json.',
      },
    ]);
  });

  it('reports duplicate manifest entries and missing patch files', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      'patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-ui-toolbar.patch',
              order: 1,
              category: 'ui',
              name: 'toolbar',
              description: 'Toolbar tweak',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/toolbar.js'],
            },
            {
              filename: '001-ui-toolbar.patch',
              order: 2,
              category: 'ui',
              name: 'toolbar-duplicate',
              description: 'Duplicate toolbar tweak',
              createdAt: '2026-01-02T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/toolbar.js'],
            },
            {
              filename: '003-ui-missing.patch',
              order: 3,
              category: 'ui',
              name: 'missing',
              description: 'Missing patch file',
              createdAt: '2026-01-03T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/missing.js'],
            },
          ],
        },
        null,
        2
      )}\n`,
    });

    const issues = await validatePatchesManifestConsistency(patchesDir);

    expect(issues).toEqual([
      {
        code: 'duplicate-manifest-entry',
        filename: '001-ui-toolbar.patch',
        message: 'patches.json contains duplicate metadata entries for 001-ui-toolbar.patch.',
      },
      {
        code: 'missing-patch-file',
        filename: '003-ui-missing.patch',
        message: '003-ui-missing.patch is listed in patches.json but the patch file is missing.',
      },
    ]);
  });

  it('rebuilds patches.json from on-disk patches while preserving existing metadata when available', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      '002-sidebar.patch': SIDEBAR_PATCH,
      'patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-ui-toolbar.patch',
              order: 1,
              category: 'ui',
              name: 'toolbar',
              description: 'Toolbar tweak',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/wrong.js'],
            },
          ],
        },
        null,
        2
      )}\n`,
    });

    const rebuilt = await rebuildPatchesManifest(patchesDir, '140.9.0esr');
    const loaded = await loadPatchesManifest(patchesDir);

    expect(rebuilt.manifest).toEqual(loaded);
    expect(rebuilt.manifest.patches).toHaveLength(2);
    expect(rebuilt.manifest.patches[0]).toMatchObject({
      filename: '001-ui-toolbar.patch',
      description: 'Toolbar tweak',
      filesAffected: ['browser/toolbar.js'],
    });
    expect(rebuilt.manifest.patches[1]).toMatchObject({
      filename: '002-sidebar.patch',
      category: 'infra',
      name: 'sidebar',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/sidebar.js'],
    });
    // 002-sidebar had no pre-existing manifest entry in this fixture,
    // so the rebuilder should list it as a recovered entry. 001-ui-toolbar
    // WAS preserved (its description round-tripped), so it must NOT appear.
    expect(rebuilt.recoveredFilenames).toContain('002-sidebar.patch');
    expect(rebuilt.recoveredFilenames).not.toContain('001-ui-toolbar.patch');
  });

  it('preserves existing lintIgnore and tier fields when rebuilding', async () => {
    // Without this preservation, a `doctor --repair-patches-manifest`
    // run would silently strip both optional fields from every entry
    // that had them. The next lint/re-export pass would then refire
    // exactly the rules the operator had intentionally quieted via
    // `lintIgnore` and the branding tier threshold-override set via
    // `tier: "branding"`.
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-branding-custom.patch': TOOLBAR_PATCH,
      'patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-branding-custom.patch',
              order: 1,
              category: 'branding',
              name: 'custom',
              description: 'Custom branding bundle',
              createdAt: '2026-04-21T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: ['browser/wrong.js'],
              lintIgnore: ['large-patch-lines', 'large-patch-files'],
              tier: 'branding',
            },
          ],
        },
        null,
        2
      )}\n`,
    });

    const rebuilt = await rebuildPatchesManifest(patchesDir, '140.9.0esr');

    expect(rebuilt.manifest.patches[0]).toMatchObject({
      filename: '001-branding-custom.patch',
      description: 'Custom branding bundle',
      lintIgnore: ['large-patch-lines', 'large-patch-files'],
      tier: 'branding',
    });
    // And the preserved lintIgnore must be a fresh array (no aliasing
    // of the input object that could surface as a cross-manifest leak
    // later).
    const persistedLoaded = await loadPatchesManifest(patchesDir);
    expect(persistedLoaded?.patches[0]?.lintIgnore).toEqual([
      'large-patch-lines',
      'large-patch-files',
    ]);
  });
});
