// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFiles } from '../../test-utils/index.js';
import { withPatchDirectoryLock } from '../patch-lock.js';
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

const PANEL_PATCH = [
  'diff --git a/browser/panel.js b/browser/panel.js',
  '--- a/browser/panel.js',
  '+++ b/browser/panel.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('patch manifest recovery paths', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns null when patches.json exists but cannot be parsed', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-recovery-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      'patches.json': '{"version": 1, "patches": [\n',
    });

    await expect(loadPatchesManifest(patchesDir)).resolves.toBeNull();
  });

  it('reports manifest-invalid when patches.json is malformed', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-recovery-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      'patches.json': '{ not valid json }\n',
    });

    const issues = await validatePatchesManifestConsistency(patchesDir);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'manifest-invalid',
      filename: 'patches.json',
    });
    expect(issues[0]?.message).toContain('patches.json exists but could not be parsed:');
  });

  it('rebuilds from malformed manifest state and infers metadata from categorized, legacy, and fallback filenames', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-recovery-'));
    tempDirs.push(patchesDir);

    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      '002-sidebar.patch': SIDEBAR_PATCH,
      'plain.patch': PANEL_PATCH,
      'patches.json': '{"version": 1, "patches": [\n',
    });

    const rebuilt = await rebuildPatchesManifest(patchesDir, '140.9.0esr');
    const loaded = await loadPatchesManifest(patchesDir);

    expect(rebuilt.manifest).toEqual(loaded);
    expect(rebuilt.manifest.patches.map((patch) => [patch.filename, patch.order])).toEqual([
      ['001-ui-toolbar.patch', 1],
      ['002-sidebar.patch', 2],
      ['plain.patch', 3],
    ]);
    expect(rebuilt.manifest.patches[0]).toMatchObject({
      filename: '001-ui-toolbar.patch',
      category: 'ui',
      name: 'toolbar',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/toolbar.js'],
    });
    expect(rebuilt.manifest.patches[1]).toMatchObject({
      filename: '002-sidebar.patch',
      category: 'infra',
      name: 'sidebar',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/sidebar.js'],
    });
    expect(rebuilt.manifest.patches[2]).toMatchObject({
      filename: 'plain.patch',
      category: 'infra',
      name: 'plain',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/panel.js'],
    });
    expect(
      rebuilt.manifest.patches.every((patch) =>
        patch.description.startsWith('Recovered manifest entry for ')
      )
    ).toBe(true);
    expect(
      rebuilt.manifest.patches.every(
        (patch) => typeof patch.createdAt === 'string' && patch.createdAt.length > 0
      )
    ).toBe(true);
    // The original patches.json was unparseable, so every rebuilt
    // entry is synthetic — the rebuilder must flag all three as
    // recovered.
    expect(rebuilt.recoveredFilenames).toEqual(
      expect.arrayContaining(['001-ui-toolbar.patch', '002-sidebar.patch', 'plain.patch'])
    );
  });

  it('waits for the patch-directory lock before rewriting the manifest', async () => {
    // Invariant 2 (docs/lifecycle-invariants.md): manifest writes
    // serialize on the patch lock. doctor --repair-patches-manifest used
    // to call this rebuild WITHOUT the lock, so a repair racing a
    // concurrent export/reorder could clobber the other writer's
    // manifest.
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-manifest-recovery-'));
    tempDirs.push(patchesDir);
    await writeFiles(patchesDir, {
      '001-ui-toolbar.patch': TOOLBAR_PATCH,
      'patches.json': JSON.stringify({ version: 1, patches: [] }, null, 2),
    });

    let releaseLock: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired: () => void = () => undefined;
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    const holder = withPatchDirectoryLock(patchesDir, async () => {
      lockAcquired();
      await lockHeld;
    });
    await lockAcquiredPromise;

    const rebuild = rebuildPatchesManifest(patchesDir, '140.9.0esr');

    // While the lock is held, the empty manifest must remain untouched.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const during = await loadPatchesManifest(patchesDir);
    expect(during?.patches).toEqual([]);

    releaseLock();
    await holder;
    const rebuilt = await rebuild;

    expect(rebuilt.manifest.patches.map((p) => p.filename)).toEqual(['001-ui-toolbar.patch']);
  });
});
