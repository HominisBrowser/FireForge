// SPDX-License-Identifier: EUPL-1.2
/**
 * Preserve-or-refuse contract for the two manifest repairs.
 *
 * The failures these pin are all from one downstream incident: a
 * `files-affected-mismatch` on a single patch was met with the
 * whole-manifest rebuild, which dropped every `stagedDependencies` block in
 * the queue on its way to correcting one derived list.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFiles } from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { rebuildPatchesManifest, repairPatchesFilesAffected } from '../patch-manifest.js';

const TWO_FILE_PATCH = [
  'diff --git a/browser/toolbar.js b/browser/toolbar.js',
  '--- a/browser/toolbar.js',
  '+++ b/browser/toolbar.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/browser/newtab.js b/browser/newtab.js',
  '--- a/browser/newtab.js',
  '+++ b/browser/newtab.js',
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

/** Manifest row declaring one file too few, plus fields no diff can carry. */
function driftedRow(): PatchMetadata {
  return {
    filename: '001-ui-toolbar.patch',
    order: 1,
    category: 'ui',
    name: 'toolbar',
    description: 'Hand-written description that no patch body can reproduce.',
    createdAt: '2026-01-02T03:04:05.000Z',
    sourceEsrVersion: '140.9.0esr',
    sourceVersion: '140.9.0esr',
    filesAffected: ['browser/toolbar.js'],
    lintIgnore: ['large-patch-lines'],
    tier: 'branding',
    stagedDependencies: {
      registrations: [
        {
          file: 'browser/moz.configure',
          line: 'imply_option("--with-branding", "browser/branding/hominis")',
          creates: 'browser/branding/hominis',
          owner: '002-infra-sidebar.patch',
        },
      ],
    },
  };
}

function healthyRow(): PatchMetadata {
  return {
    filename: '002-infra-sidebar.patch',
    order: 2,
    category: 'infra',
    name: 'sidebar',
    description: 'Sidebar plumbing.',
    createdAt: '2026-01-03T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    sourceVersion: '140.9.0esr',
    filesAffected: ['browser/sidebar.js'],
  };
}

async function seedQueue(rows: PatchMetadata[]): Promise<string> {
  const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-repair-'));
  await writeFiles(patchesDir, {
    '001-ui-toolbar.patch': TWO_FILE_PATCH,
    '002-infra-sidebar.patch': SIDEBAR_PATCH,
    'patches.json': `${JSON.stringify({ version: 1, patches: rows }, null, 2)}\n`,
  });
  return patchesDir;
}

describe('patch manifest repairs', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe('rebuildPatchesManifest', () => {
    it('preserves every field the patch body cannot express', async () => {
      const patchesDir = await seedQueue([driftedRow(), healthyRow()]);
      tempDirs.push(patchesDir);

      const rebuilt = await rebuildPatchesManifest(patchesDir, '142.0esr');
      const repaired = rebuilt.manifest.patches[0];

      // The one field the rebuild owns is corrected…
      expect(repaired?.filesAffected).toEqual(['browser/newtab.js', 'browser/toolbar.js']);
      // …and everything a `.patch` cannot carry survives. `stagedDependencies`
      // was dropped from every entry that had one until the rebuilt row was
      // built by spreading the existing entry rather than enumerating fields.
      expect(repaired?.stagedDependencies).toEqual(driftedRow().stagedDependencies);
      expect(repaired?.lintIgnore).toEqual(['large-patch-lines']);
      expect(repaired?.tier).toBe('branding');
      expect(repaired?.description).toBe(driftedRow().description);
      expect(repaired?.createdAt).toBe(driftedRow().createdAt);
      expect(repaired?.sourceEsrVersion).toBe('140.9.0esr');
      expect(rebuilt.recoveredFilenames).toEqual([]);
      expect(rebuilt.written).toBe(true);
    });

    it('refuses to rebuild an unparseable manifest and leaves it untouched', async () => {
      const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-repair-'));
      tempDirs.push(patchesDir);
      const corrupt = '{"version": 1, "patches": [\n';
      await writeFiles(patchesDir, {
        '001-ui-toolbar.patch': TWO_FILE_PATCH,
        'patches.json': corrupt,
      });

      // An unparseable manifest loads as `null`, which the merge cannot tell
      // apart from "no manifest" — so every entry would be reinvented. The
      // write is what makes that unrecoverable, so it must not happen.
      await expect(rebuildPatchesManifest(patchesDir, '142.0esr')).rejects.toThrow(
        '--allow-metadata-loss'
      );
      await expect(readFile(join(patchesDir, 'patches.json'), 'utf-8')).resolves.toBe(corrupt);

      const forced = await rebuildPatchesManifest(patchesDir, '142.0esr', {
        allowMetadataLoss: true,
      });
      expect(forced.recoveredFilenames).toEqual(['001-ui-toolbar.patch']);
      expect(forced.written).toBe(true);
    });

    it('projects a dry run without writing, and names dropped rows', async () => {
      const patchesDir = await seedQueue([
        driftedRow(),
        healthyRow(),
        { ...healthyRow(), filename: '003-ui-gone.patch', order: 3, name: 'gone' },
      ]);
      tempDirs.push(patchesDir);
      const before = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

      const projected = await rebuildPatchesManifest(patchesDir, '142.0esr', { dryRun: true });

      expect(projected.written).toBe(false);
      expect(projected.droppedFilenames).toEqual(['003-ui-gone.patch']);
      expect(projected.manifest.patches[0]?.filesAffected).toEqual([
        'browser/newtab.js',
        'browser/toolbar.js',
      ]);
      await expect(readFile(join(patchesDir, 'patches.json'), 'utf-8')).resolves.toBe(before);
    });
  });

  describe('repairPatchesFilesAffected', () => {
    it('rewrites only the drifted row and leaves the rest byte-identical', async () => {
      const patchesDir = await seedQueue([driftedRow(), healthyRow()]);
      tempDirs.push(patchesDir);
      const before = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

      const result = await repairPatchesFilesAffected(patchesDir, ['001-ui-toolbar.patch']);

      expect(result.written).toBe(true);
      expect(result.repairs).toEqual([
        {
          filename: '001-ui-toolbar.patch',
          before: ['browser/toolbar.js'],
          after: ['browser/newtab.js', 'browser/toolbar.js'],
        },
      ]);

      const after = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
      // The untouched row's serialization must not move at all — a repair
      // that reformats rows it had no reason to touch is what made the
      // original incident's diff unreviewable.
      const healthyBlock = JSON.stringify(healthyRow(), null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
        .trim();
      expect(after).toContain(healthyBlock);
      expect(before).toContain(healthyBlock);
      // And the drifted row keeps everything a diff cannot carry.
      const parsed = JSON.parse(after) as { patches: PatchMetadata[] };
      expect(parsed.patches[0]?.stagedDependencies).toEqual(driftedRow().stagedDependencies);
      expect(parsed.patches[0]?.lintIgnore).toEqual(['large-patch-lines']);
      expect(parsed.patches[0]?.description).toBe(driftedRow().description);
    });

    it('writes nothing on a dry run', async () => {
      const patchesDir = await seedQueue([driftedRow(), healthyRow()]);
      tempDirs.push(patchesDir);
      const manifestPath = join(patchesDir, 'patches.json');
      const before = await stat(manifestPath);

      const result = await repairPatchesFilesAffected(patchesDir, ['001-ui-toolbar.patch'], {
        dryRun: true,
      });

      expect(result.written).toBe(false);
      expect(result.repairs).toHaveLength(1);
      await expect(stat(manifestPath).then((s) => s.mtimeMs)).resolves.toBe(before.mtimeMs);
    });

    it('reports filenames it cannot repair rather than inventing rows', async () => {
      const patchesDir = await seedQueue([driftedRow(), healthyRow()]);
      tempDirs.push(patchesDir);

      const result = await repairPatchesFilesAffected(patchesDir, [
        '001-ui-toolbar.patch',
        '404-ui-missing.patch',
      ]);

      expect(result.skippedFilenames).toEqual(['404-ui-missing.patch']);
      expect(result.repairs.map((repair) => repair.filename)).toEqual(['001-ui-toolbar.patch']);
    });

    it('is a no-op when nothing drifted', async () => {
      const patchesDir = await seedQueue([driftedRow(), healthyRow()]);
      tempDirs.push(patchesDir);
      const before = await readFile(join(patchesDir, 'patches.json'), 'utf-8');

      const result = await repairPatchesFilesAffected(patchesDir, ['002-infra-sidebar.patch']);

      expect(result.repairs).toEqual([]);
      expect(result.written).toBe(false);
      await expect(readFile(join(patchesDir, 'patches.json'), 'utf-8')).resolves.toBe(before);
    });
  });
});
