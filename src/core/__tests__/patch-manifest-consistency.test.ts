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
              sourceEsrVersion: '140.0esr',
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
              sourceEsrVersion: '140.0esr',
              filesAffected: ['browser/toolbar.js'],
            },
            {
              filename: '001-ui-toolbar.patch',
              order: 2,
              category: 'ui',
              name: 'toolbar-duplicate',
              description: 'Duplicate toolbar tweak',
              createdAt: '2026-01-02T00:00:00.000Z',
              sourceEsrVersion: '140.0esr',
              filesAffected: ['browser/toolbar.js'],
            },
            {
              filename: '003-ui-missing.patch',
              order: 3,
              category: 'ui',
              name: 'missing',
              description: 'Missing patch file',
              createdAt: '2026-01-03T00:00:00.000Z',
              sourceEsrVersion: '140.0esr',
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
              sourceEsrVersion: '140.0esr',
              filesAffected: ['browser/wrong.js'],
            },
          ],
        },
        null,
        2
      )}\n`,
    });

    const rebuilt = await rebuildPatchesManifest(patchesDir, '140.0esr');
    const loaded = await loadPatchesManifest(patchesDir);

    expect(rebuilt).toEqual(loaded);
    expect(rebuilt.patches).toHaveLength(2);
    expect(rebuilt.patches[0]).toMatchObject({
      filename: '001-ui-toolbar.patch',
      description: 'Toolbar tweak',
      filesAffected: ['browser/toolbar.js'],
    });
    expect(rebuilt.patches[1]).toMatchObject({
      filename: '002-sidebar.patch',
      category: 'infra',
      name: 'sidebar',
      sourceEsrVersion: '140.0esr',
      filesAffected: ['browser/sidebar.js'],
    });
  });
});
