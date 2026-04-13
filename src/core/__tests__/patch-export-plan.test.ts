// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins that `planExport` (dry-run preview) agrees with what
 * `commitExportedPatch` (real write) actually does. Both paths go through
 * the shared `computeExportPlanUnderLock` helper, so any drift between
 * planning logic and write logic — a bug fix applied to one but not the
 * other — would cause this test to fail with a concrete mismatch instead
 * of silently producing misleading dry-run previews.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { commitExportedPatch, planExport } from '../patch-export.js';
import { loadPatchesManifest, savePatchesManifest } from '../patch-manifest-io.js';

interface PatchSetup {
  filename: string;
  order: number;
  body: string;
  filesAffected: string[];
}

async function seed(patchesDir: string, patches: PatchSetup[]): Promise<void> {
  await ensureDir(patchesDir);
  const metadata: PatchMetadata[] = patches.map((p) => ({
    filename: p.filename,
    order: p.order,
    category: 'ui',
    name: 'seed',
    description: 'seed',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '146.0esr',
    filesAffected: p.filesAffected,
  }));
  for (const p of patches) {
    await writeFile(join(patchesDir, p.filename), p.body);
  }
  const manifest: PatchesManifest = { version: 1, patches: metadata };
  await savePatchesManifest(patchesDir, manifest);
}

function normalizeCreatedAt(m: PatchMetadata): PatchMetadata {
  return { ...m, createdAt: '__NORMALIZED__' };
}

function normalizeManifest(manifest: PatchesManifest): PatchesManifest {
  return {
    ...manifest,
    patches: manifest.patches.map(normalizeCreatedAt),
  };
}

describe('planExport agrees with commitExportedPatch', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-plan-commit-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('predicts the same filename, metadata, and manifest-after that the real commit produces', async () => {
    await seed(patchesDir, [
      { filename: '001-ui-alpha.patch', order: 1, body: 'alpha', filesAffected: ['a.js'] },
      { filename: '002-ui-beta.patch', order: 2, body: 'beta', filesAffected: ['b.js'] },
    ]);

    const input = {
      patchesDir,
      category: 'ui' as const,
      name: 'gamma',
      description: 'new patch',
      filesAffected: ['c.js'],
      sourceEsrVersion: '146.0esr',
    };

    const plan = await planExport(input);

    // planExport must be read-only: the manifest on disk should be
    // identical to what it was before the call. If this fails, the
    // "dry-run never writes" guarantee is broken.
    const manifestAfterPlan = await loadPatchesManifest(patchesDir);
    expect(manifestAfterPlan?.patches.map((p) => p.filename)).toEqual([
      '001-ui-alpha.patch',
      '002-ui-beta.patch',
    ]);

    const commitResult = await commitExportedPatch({
      ...input,
      diff: 'FAKE DIFF BODY',
    });

    // The real commit must have allocated the same filename the plan
    // predicted. This is the core "dry-run preview does not lie" guarantee.
    expect(commitResult.patchFilename).toBe(plan.patchFilename);
    expect(commitResult.patchFilename).toBe('003-ui-gamma.patch');

    // Metadata must match modulo createdAt (which legitimately differs by
    // a millisecond or two because plan and commit each call new Date()).
    expect(normalizeCreatedAt(commitResult.metadata)).toEqual(normalizeCreatedAt(plan.metadata));

    // The on-disk manifest after commit must match plan.manifestAfter
    // exactly (again modulo createdAt on the newly-added row).
    const manifestAfterCommit = await loadPatchesManifest(patchesDir);
    if (manifestAfterCommit === null) {
      throw new Error('manifest load returned null after commit');
    }
    expect(normalizeManifest(manifestAfterCommit)).toEqual(normalizeManifest(plan.manifestAfter));
  });

  it('predicts the same supersede set that the real commit would remove', async () => {
    await seed(patchesDir, [
      { filename: '001-ui-alpha.patch', order: 1, body: 'alpha', filesAffected: ['a.js'] },
      { filename: '002-ui-beta.patch', order: 2, body: 'beta', filesAffected: ['b.js'] },
      {
        filename: '003-ui-legacy.patch',
        order: 3,
        body: 'legacy',
        filesAffected: ['shared.js'],
      },
    ]);

    // The new export covers everything in 003-ui-legacy — so the plan
    // should report it as superseded, and the commit should delete it.
    const input = {
      patchesDir,
      category: 'ui' as const,
      name: 'replacement',
      description: 'replaces legacy',
      filesAffected: ['shared.js', 'extra.js'],
      sourceEsrVersion: '146.0esr',
    };

    const plan = await planExport(input);

    expect(plan.superseded.map((s) => s.filename)).toEqual(['003-ui-legacy.patch']);
    expect(plan.superseded[0]?.coveredByFiles).toEqual(['shared.js']);

    const commitResult = await commitExportedPatch({
      ...input,
      diff: 'FAKE DIFF BODY',
    });

    // Plan and commit must agree on which existing patches get removed.
    expect(commitResult.superseded.map((p) => p.filename)).toEqual(
      plan.superseded.map((s) => s.filename)
    );

    // The on-disk manifest after commit must match plan.manifestAfter
    // (superseded row gone, new row inserted).
    const manifestAfterCommit = await loadPatchesManifest(patchesDir);
    if (manifestAfterCommit === null) {
      throw new Error('manifest load returned null after commit');
    }
    expect(normalizeManifest(manifestAfterCommit)).toEqual(normalizeManifest(plan.manifestAfter));
    expect(manifestAfterCommit.patches.map((p) => p.filename)).not.toContain('003-ui-legacy.patch');
    expect(manifestAfterCommit.patches.map((p) => p.filename)).toContain(
      commitResult.patchFilename
    );
  });
});
