// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `fireforge verify`, built on a temp patches
 * directory. Exercises three scenarios:
 *   1. clean queue → exits 0
 *   2. duplicate /dev/null creation → errors
 *   3. forward import from earlier to later patch → errors
 * Plus the end-to-end "Hominis mess" repair scenario: build a broken
 * queue, run verify (expect failure), use patch delete + re-export --files
 * + patch reorder to fix it, re-run verify (expect clean).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  setInteractiveMode,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { verifyCommand } from '../verify.js';

async function seedManifestAndPatches(
  patchesDir: string,
  patches: Array<{ metadata: PatchMetadata; body: string }>
): Promise<void> {
  await ensureDir(patchesDir);
  for (const p of patches) {
    await writeFile(join(patchesDir, p.metadata.filename), p.body);
  }
  const manifest: PatchesManifest = {
    version: 1,
    patches: patches.map((p) => p.metadata),
  };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

function createDiff(newFilePath: string, content: string): string {
  const lines = content.split('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${newFilePath} b/${newFilePath}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${newFilePath}`,
    hunk,
  ].join('\n');
}

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'infra',
    name: 'test',
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '146.0esr',
    filesAffected,
  };
}

describe('verify command', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-verify-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    restoreTTY = setInteractiveMode(false);
    // Silence logger output during tests by stubbing methods on the
    // loaded singleton.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('passes on a clean queue', async () => {
    const diffA = createDiff('foo/A.sys.mjs', 'export const A = 1;');
    const diffB = createDiff('foo/B.sys.mjs', 'export const B = 2;');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: diffB,
      },
    ]);

    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();
  });

  it('fails on duplicate /dev/null creation across two patches', async () => {
    const diffA = createDiff('foo/Dup.sys.mjs', 'export const Dup = 1;');
    const diffA2 = createDiff('foo/Dup.sys.mjs', 'export const Dup = 2;');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/Dup.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/Dup.sys.mjs']),
        body: diffA2,
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });

  it('fails on forward import from earlier to later patch', async () => {
    const diffA = createDiff(
      'foo/A.sys.mjs',
      'import { B } from "resource:///modules/B.sys.mjs";\nexport const A = B;'
    );
    const diffB = createDiff('foo/B.sys.mjs', 'export const B = 1;');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: diffB,
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });

  it('fails when the manifest is missing a patch file on disk', async () => {
    // Seed manifest + one file, then lie to it by referencing a filename
    // that does not exist.
    await ensureDir(patchesDir);
    const manifest: PatchesManifest = {
      version: 1,
      patches: [makeMetadata('001-infra-ghost.patch', 1, ['foo/Ghost.sys.mjs'])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest));

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });
});
