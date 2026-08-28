// SPDX-License-Identifier: EUPL-1.2
/**
 * Byte-equality guard for {@link getAllDiff} against a REAL git repository.
 *
 * `getAllDiff`'s output is not just displayed: `tree-store.ts` SHA-256s the
 * whole string into every tree fingerprint, and `export-all.ts` writes it
 * verbatim into `.patch` files. A single changed byte silently invalidates
 * every stored fingerprint and alters exported patch content.
 *
 * `git-diff.test.ts`'s `getAllDiff` cases stub `hashObjectBatch` in a shared
 * `beforeEach`, so they pass whether or not the hashes are real. This file
 * exercises the real binary and asserts the exact shape: real blob hashes,
 * `ls-files` ordering, tracked-block-first emission, and the `'\n'`
 * empty-result sentinel.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { getAllDiff } from '../git-diff.js';

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

describe('getAllDiff byte contract (real git)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await removeTempProject(root);
      root = undefined;
    }
  });

  async function initRepo(): Promise<string> {
    root = await createTempProject('ff-getalldiff-');
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(root, ['config', 'user.name', 'FireForge Tests']);
    await runGit(root, ['config', 'core.autocrlf', 'false']);
    await runGit(root, ['config', 'core.eol', 'lf']);
    await write(root, 'tracked.js', 'const a = 1;\n');
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '-m', 'initial']);
    return root;
  }

  it('returns the bare newline sentinel for a clean tree', async () => {
    const repo = await initRepo();
    // Not '' — `lint.ts` and `export-all.ts` gate on `.trim()`, but
    // `git-diff.test.ts` pins this exact value.
    await expect(getAllDiff(repo)).resolves.toBe('\n');
  });

  it('uses the real abbreviated blob hash for an untracked text file', async () => {
    const repo = await initRepo();
    await write(repo, 'added.js', 'const b = 2;\n');

    const expectedHash = (await runGit(repo, ['hash-object', join(repo, 'added.js')]))
      .trim()
      .slice(0, 10);

    const diff = await getAllDiff(repo);
    expect(diff).toContain(`index 0000000000..${expectedHash}`);
    expect(diff).not.toContain('index 0000000000..0000000000');
    expect(diff).toContain('diff --git a/added.js b/added.js');
    expect(diff).toContain('+const b = 2;');
  });

  it('emits the tracked block before untracked files, in ls-files order', async () => {
    const repo = await initRepo();
    await write(repo, 'tracked.js', 'const a = 99;\n');
    await write(repo, 'a-added.js', 'a\n');
    await write(repo, 'z-added.js', 'z\n');

    const diff = await getAllDiff(repo);
    const trackedAt = diff.indexOf('diff --git a/tracked.js');
    const firstAt = diff.indexOf('diff --git a/a-added.js');
    const lastAt = diff.indexOf('diff --git a/z-added.js');

    expect(trackedAt).toBeGreaterThanOrEqual(0);
    expect(trackedAt).toBeLessThan(firstAt);
    expect(firstAt).toBeLessThan(lastAt);
  });

  it('preserves the empty-file and no-trailing-newline forms', async () => {
    const repo = await initRepo();
    await write(repo, 'empty.js', '');
    await write(repo, 'nonl.js', 'no newline');

    const diff = await getAllDiff(repo);
    expect(diff).toContain('diff --git a/empty.js b/empty.js');
    expect(diff).not.toContain('@@ -0,0 +1,0 @@');
    expect(diff).toContain('\\ No newline at end of file');
  });

  it('keeps binary files on the staging path alongside batched text files', async () => {
    const repo = await initRepo();
    await writeFile(join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    await write(repo, 'plain.js', 'const c = 3;\n');

    const diff = await getAllDiff(repo);
    expect(diff).toContain('blob.bin');
    expect(diff).toContain('diff --git a/plain.js b/plain.js');
    expect(diff).toContain('+const c = 3;');
  });
});
