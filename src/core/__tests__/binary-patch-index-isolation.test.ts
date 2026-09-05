// SPDX-License-Identifier: EUPL-1.2
/**
 * The one-writer invariant for untracked binary patches, against a real git
 * repository.
 *
 * `generateBinaryFilePatch` has to write an index entry to diff an untracked
 * file. Writing it to the shared index made that write observable: a
 * concurrent `fireforge test` fingerprints `engine/` with `git status` and
 * refuses a verdict taken across a change, so a parallel gate lane running
 * this staging killed healthy suites with `FAIL reason=inconclusive` on its
 * own tooling's index churn. These tests pin both halves: the patch bytes
 * are unchanged, and nothing outside this call can see the staging.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { generateBinaryFilePatch } from '../git-diff.js';

/** A tiny PNG-shaped buffer, binary enough for git to treat it as such. */
const BINARY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

describe('untracked binary patch generation (real git)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await removeTempProject(root);
      root = undefined;
    }
  });

  async function initRepo(): Promise<string> {
    root = await createTempProject('ff-binary-index-');
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(root, ['config', 'user.name', 'FireForge Tests']);
    await runGit(root, ['config', 'core.autocrlf', 'false']);
    await runGit(root, ['config', 'core.eol', 'lf']);
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '-m', 'initial']);
    return root;
  }

  it('produces a binary patch for an untracked file', async () => {
    const repo = await initRepo();
    await writeFile(join(repo, 'icon.png'), BINARY);

    const patch = await generateBinaryFilePatch(repo, 'icon.png');

    expect(patch).toContain('GIT binary patch');
    expect(patch).toContain('icon.png');
  });

  it('leaves the shared index and `git status` byte-identical', async () => {
    // This is the invariant the parallel gate lanes broke. The probe that
    // matters is exactly `snapshotEngineGeneration`'s: HEAD plus porcelain.
    const repo = await initRepo();
    await writeFile(join(repo, 'icon.png'), BINARY);

    const indexPath = join(repo, '.git', 'index');
    const indexBefore = await readFile(indexPath);
    const statusBefore = await runGit(repo, ['status', '--porcelain=v1', '-z']);

    await generateBinaryFilePatch(repo, 'icon.png');

    expect(await runGit(repo, ['status', '--porcelain=v1', '-z'])).toBe(statusBefore);
    expect((await readFile(indexPath)).equals(indexBefore)).toBe(true);
  });

  it('never lets a concurrent status probe observe the staged entry', async () => {
    // Serial before/after equality would also hold for a stage-then-restore
    // implementation. The defect was the window in between. Poll `git status`
    // throughout the call and assert the transient entry never appears.
    const repo = await initRepo();
    await writeFile(join(repo, 'icon.png'), BINARY);

    const state = { polling: true };
    const observed = new Set<string>();
    const probe = (async (): Promise<void> => {
      while (state.polling) {
        observed.add(await runGit(repo, ['status', '--porcelain=v1', '-z']));
      }
    })();

    try {
      await generateBinaryFilePatch(repo, 'icon.png');
    } finally {
      state.polling = false;
      await probe;
    }

    // Every observation must be the untracked state. An `A` entry (git's
    // rendering of the intent-to-add staging) is the flap that voided the
    // suites.
    expect([...observed].every((status) => status.includes('?? icon.png'))).toBe(true);
    expect([...observed].some((status) => /(^|\0)A/.test(status))).toBe(false);
  });

  it('does not mistake a tracked, unmodified binary for a fresh add', async () => {
    // The tracked-and-unmodified case reaches the same staging branch (its
    // `diff HEAD` is empty). A private index seeded from nothing would
    // report the whole file as added. Seeding from the repo's own index is
    // what keeps this empty.
    const repo = await initRepo();
    await writeFile(join(repo, 'tracked.png'), BINARY);
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'add binary']);

    expect(await generateBinaryFilePatch(repo, 'tracked.png')).toBe('');
  });
});
