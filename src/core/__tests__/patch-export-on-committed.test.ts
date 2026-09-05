// SPDX-License-Identifier: EUPL-1.2
/**
 * Regression coverage for the `onCommitted` hook semantics on
 * {@link updatePatchAndMetadata}: a hook that throws after the mutation has
 * already committed must not leak its error out as a command failure,
 * because by the time the hook runs there is nothing meaningful to roll
 * back. The re-export --files path threads a history-log append through
 * this hook, and a stray filesystem error on the history file would
 * otherwise make a perfectly valid re-export look like it had failed.
 *
 * The shape mirrors the compound-failure and phase-3 rollback tests in
 * `patch-manifest-mutation-rollback.test.ts`: seed a real patches
 * directory, exercise the helper directly, and assert on-disk state.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir, readText } from '../../utils/fs.js';
import { updatePatchAndMetadata } from '../patch-export.js';
import { loadPatchesManifest, savePatchesManifest } from '../patch-manifest-io.js';

function makeMetadata(overrides: Partial<PatchMetadata> = {}): PatchMetadata {
  return {
    filename: '001-infra-a.patch',
    order: 1,
    category: 'infra',
    name: 'a',
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: ['fake/a.txt'],
    ...overrides,
  };
}

async function seed(patchesDir: string): Promise<void> {
  await ensureDir(patchesDir);
  await writeFile(join(patchesDir, '001-infra-a.patch'), 'original body');
  const manifest: PatchesManifest = {
    version: 1,
    patches: [makeMetadata()],
  };
  await savePatchesManifest(patchesDir, manifest);
}

async function seedLegacyManifest(patchesDir: string): Promise<void> {
  await ensureDir(patchesDir);
  await writeFile(join(patchesDir, '001-infra-a.patch'), 'a body');
  await writeFile(join(patchesDir, '002-infra-b.patch'), 'b body');
  await writeFile(join(patchesDir, '003-infra-c.patch'), 'c body');
  await writeFile(
    join(patchesDir, 'patches.json'),
    `${JSON.stringify(
      {
        version: 1,
        patches: [
          makeMetadata({ filename: '001-infra-a.patch', order: 1, filesAffected: ['fake/a.txt'] }),
          makeMetadata({ filename: '002-infra-b.patch', order: 2, filesAffected: ['fake/b.txt'] }),
          makeMetadata({ filename: '003-infra-c.patch', order: 3, filesAffected: ['fake/c.txt'] }),
        ],
      },
      null,
      2
    )}\n`
  );
}

describe('updatePatchAndMetadata onCommitted hook', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-upd-oncommitted-');
    patchesDir = join(projectRoot, 'patches');
    await seed(patchesDir);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('swallows hook failures so a failed audit log append does not fail the command', async () => {
    // Install an onCommitted hook that throws. The mutation (patch body
    // + manifest row) has already committed by the time the hook runs,
    // so the helper must catch, warn, and return normally. If the hook
    // error bubbled out, `re-export --files` would print a misleading
    // failure for a mutation that actually succeeded.
    const hook = (): Promise<void> => {
      return Promise.reject(new Error('simulated history-append failure'));
    };

    await expect(
      updatePatchAndMetadata({
        patchesDir,
        filename: '001-infra-a.patch',
        newContent: 'new body',
        updates: { filesAffected: ['fake/a.txt', 'fake/b.txt'] },
        onCommitted: hook,
      })
    ).resolves.toBe(true);

    // Patch body: the new content landed.
    const body = await readText(join(patchesDir, '001-infra-a.patch'));
    expect(body).toBe('new body');

    // Manifest row: the filesAffected update landed.
    const manifest = await loadPatchesManifest(patchesDir);
    const row = manifest?.patches.find((p) => p.filename === '001-infra-a.patch');
    expect(row?.filesAffected).toEqual(['fake/a.txt', 'fake/b.txt']);
  });

  it('runs the hook when it does not throw and keeps the mutation in place', async () => {
    // Happy path pinned alongside the failure case so a future change
    // that e.g. moves the hook call outside the lock has two tests to
    // update instead of one.
    let hookInvocations = 0;
    const hook = (): Promise<void> => {
      hookInvocations += 1;
      return Promise.resolve();
    };

    await updatePatchAndMetadata({
      patchesDir,
      filename: '001-infra-a.patch',
      newContent: 'new body',
      updates: { filesAffected: ['fake/a.txt'] },
      onCommitted: hook,
    });

    expect(hookInvocations).toBe(1);
    expect(await readText(join(patchesDir, '001-infra-a.patch'))).toBe('new body');
  });

  it('does not serialize fallback sourceVersion onto unrelated legacy rows', async () => {
    await seedLegacyManifest(patchesDir);

    await updatePatchAndMetadata({
      patchesDir,
      filename: '002-infra-b.patch',
      newContent: 'new b body',
      updates: { filesAffected: ['fake/b.txt', 'fake/b2.txt'] },
      onCommitted: undefined,
    });

    const raw = JSON.parse(await readText(join(patchesDir, 'patches.json'))) as {
      patches: Array<{
        filename: string;
        filesAffected: string[];
        sourceVersion?: string;
      }>;
    };
    const rows = new Map(raw.patches.map((patch) => [patch.filename, patch]));

    expect(rows.get('001-infra-a.patch')?.sourceVersion).toBeUndefined();
    expect(rows.get('002-infra-b.patch')?.sourceVersion).toBeUndefined();
    expect(rows.get('003-infra-c.patch')?.sourceVersion).toBeUndefined();
    expect(rows.get('002-infra-b.patch')?.filesAffected).toEqual(['fake/b.txt', 'fake/b2.txt']);
  });
});
