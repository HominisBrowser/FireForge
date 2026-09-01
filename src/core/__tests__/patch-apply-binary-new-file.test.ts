// SPDX-License-Identifier: EUPL-1.2
/**
 * New-file conflict recovery for BINARY targets, against a REAL git
 * repository.
 *
 * When `git apply` fails because a patch creates a file that already exists,
 * FireForge resolves the conflict by putting the patch's intended content in
 * place and retrying. For a text file that means overwriting with the
 * extracted content; for a binary file there is nothing to extract — the
 * payload is base85 — so before 0.45.0 the recovery threw and the import
 * failed on a patch `git apply` could have completed itself.
 *
 * The binary resolution is to REMOVE the blocking file and let `git apply`
 * decode the `GIT binary patch` payload, which is the same outcome the text
 * branch reaches by overwriting.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { generateBinaryFilePatch } from '../git-diff.js';
import { applyPatchesWithContinue } from '../patch-apply.js';

/**
 * Two distinct PNG-shaped buffers, so a wrong restore is detectable. The NUL
 * bytes are load-bearing: git's binary heuristic keys on a NUL in the first
 * 8 KB, and without one these diff as (mangled) text.
 */
const PATCH_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xaa, 0xbb,
]);
const PREEXISTING_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x11, 0x22,
]);

const FONT = 'browser/themes/shared/fonts/nebula-sans-regular.woff2';

describe('binary new-file conflict recovery (real git)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await removeTempProject(root);
      root = undefined;
    }
  });

  /**
   * Builds an engine repo plus a patches dir holding one patch that CREATES
   * the binary file, and leaves a different file already at that path — the
   * exact conflict shape `applySinglePatch` recovers from.
   */
  async function setup(): Promise<{ engine: string; patches: string }> {
    root = await createTempProject('ff-binary-newfile-');
    const engine = join(root, 'engine');
    const patches = join(root, 'patches');
    await mkdir(join(engine, 'browser/themes/shared/fonts'), { recursive: true });
    await mkdir(patches, { recursive: true });

    await runGit(engine, ['init']);
    await runGit(engine, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(engine, ['config', 'user.name', 'FireForge Tests']);
    await writeFile(join(engine, 'seed.txt'), 'seed\n');
    await runGit(engine, ['add', '-A']);
    await runGit(engine, ['commit', '-m', 'initial']);

    // Author the patch from a real untracked binary, then remove it so the
    // patch describes a file that does not exist at HEAD.
    await writeFile(join(engine, FONT), PATCH_BYTES);
    const diff = await generateBinaryFilePatch(engine, FONT);
    expect(diff).toContain('GIT binary patch');
    await writeFile(join(patches, '101-fonts.patch'), diff);
    await rm(join(engine, FONT));

    return { engine, patches };
  }

  it('applies a new binary file when nothing is in the way', async () => {
    const { engine, patches } = await setup();

    const summary = await applyPatchesWithContinue(patches, engine);

    expect(summary.failed).toEqual([]);
    expect(summary.succeeded).toHaveLength(1);
    expect(await readFile(join(engine, FONT))).toEqual(PATCH_BYTES);
  });

  it('resolves the conflict when a DIFFERENT file already occupies the path', async () => {
    const { engine, patches } = await setup();
    await writeFile(join(engine, FONT), PREEXISTING_BYTES);

    const summary = await applyPatchesWithContinue(patches, engine);

    expect(summary.failed.map((r) => r.error)).toEqual([]);
    expect(summary.succeeded).toHaveLength(1);
    // The patch's bytes won, byte-for-byte — not a utf-8 round-trip of them.
    expect(await readFile(join(engine, FONT))).toEqual(PATCH_BYTES);
  });
});
