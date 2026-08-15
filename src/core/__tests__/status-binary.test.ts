// SPDX-License-Identifier: EUPL-1.2
/**
 * Binary drift classification (FORGE J3): patch-owned binary files settle
 * to `patch-backed`/`patch-owned-drift` via recorded blob hashes, and
 * bodies without a usable hash classify as `binary-unsupported` instead
 * of drifting forever.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, initCommittedRepo, writeFiles } from '../../test-utils/index.js';
import { hashObjectBatch } from '../git-file-ops.js';
import { classifyBinaryOwnedFile } from '../status-binary.js';

const PNG = 'images/fixture.png';
// NUL bytes make isBinaryFile treat the content as binary, like a real PNG.
const ORIGINAL_BYTES = 'PNG\u0000\u0001original';
const PATCHED_BYTES = 'PNG\u0000\u0001patched';

describe('classifyBinaryOwnedFile', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  async function seedPatch(body: string): Promise<void> {
    await writeFiles(projectRoot, {
      'patches/001-ui-img.patch': body,
      'patches/patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-ui-img.patch',
              order: 1,
              category: 'ui',
              name: 'img',
              description: 'binary fixture',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: [PNG],
            },
          ],
        },
        null,
        2
      )}\n`,
    });
  }

  function binaryBody(oldHash: string, newHash: string): string {
    return [
      `diff --git a/${PNG} b/${PNG}`,
      `index ${oldHash}..${newHash} 100644`,
      'GIT binary patch',
      'literal 20',
      '+K}0e#0ssI2',
      '',
    ].join('\n');
  }

  async function liveHash(): Promise<string> {
    const fullPath = join(engineDir, PNG);
    const hash = (await hashObjectBatch(engineDir, [fullPath])).get(fullPath);
    if (hash === undefined) throw new Error('hash-object failed');
    return hash;
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-status-binary-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { [PNG]: ORIGINAL_BYTES });
    await writeFiles(engineDir, { [PNG]: PATCHED_BYTES });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('settles to the match classification when the live blob hash equals the recorded new-side hash', async () => {
    await seedPatch(binaryBody('1'.repeat(40), await liveHash()));
    const result = await classifyBinaryOwnedFile({
      entry: { status: ' M', file: PNG },
      engineDir,
      patchesDir,
      matchClassification: 'patch-backed',
      owner: '001-ui-img.patch',
    });
    expect(result).toMatchObject({ classification: 'patch-backed', owner: '001-ui-img.patch' });
  });

  it('settles to patch-owned-drift when the live bytes differ from the recorded hash', async () => {
    await seedPatch(binaryBody('1'.repeat(40), '2'.repeat(40)));
    const result = await classifyBinaryOwnedFile({
      entry: { status: ' M', file: PNG },
      engineDir,
      patchesDir,
      matchClassification: 'patch-backed',
      owner: '001-ui-img.patch',
    });
    expect(result?.classification).toBe('patch-owned-drift');
  });

  it('classifies a hash-less binary body as binary-unsupported, not drift', async () => {
    await seedPatch(
      [`diff --git a/${PNG} b/${PNG}`, `Binary files a/${PNG} and b/${PNG} differ`, ''].join('\n')
    );
    const result = await classifyBinaryOwnedFile({
      entry: { status: ' M', file: PNG },
      engineDir,
      patchesDir,
      matchClassification: 'patch-backed',
      owner: '001-ui-img.patch',
    });
    expect(result?.classification).toBe('binary-unsupported');
  });

  it('treats a deleted binary the patch deletes as a match, and one it expects as drift', async () => {
    const deletionBody = [
      `diff --git a/${PNG} b/${PNG}`,
      'deleted file mode 100644',
      `index ${'1'.repeat(40)}..${'0'.repeat(40)}`,
      'GIT binary patch',
      'literal 0',
      '',
    ].join('\n');
    await seedPatch(deletionBody);
    await rm(join(engineDir, PNG));
    const deleted = await classifyBinaryOwnedFile({
      entry: { status: 'D ', file: PNG },
      engineDir,
      patchesDir,
      matchClassification: 'patch-backed',
      owner: '001-ui-img.patch',
      fileMissing: true,
    });
    expect(deleted?.classification).toBe('patch-backed');

    await seedPatch(binaryBody('1'.repeat(40), '2'.repeat(40)));
    const missing = await classifyBinaryOwnedFile({
      entry: { status: 'D ', file: PNG },
      engineDir,
      patchesDir,
      matchClassification: 'patch-backed',
      owner: '001-ui-img.patch',
      fileMissing: true,
    });
    expect(missing?.classification).toBe('patch-owned-drift');
  });

  it('returns null for a live text file so the utf-8 comparison path runs unchanged', async () => {
    await writeFile(join(engineDir, PNG), 'plain text now\n', 'utf-8');
    await seedPatch(binaryBody('1'.repeat(40), '2'.repeat(40)));
    const result = await classifyBinaryOwnedFile({
      entry: { status: ' M', file: PNG },
      engineDir,
      patchesDir,
      matchClassification: 'patch-backed',
      owner: '001-ui-img.patch',
    });
    expect(result).toBeNull();
  });
});
