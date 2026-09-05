// SPDX-License-Identifier: EUPL-1.2
/**
 * Tracked binary files must round-trip through a real `GIT binary patch`
 * body, against a real git repository.
 *
 * The batched diff path used to route only untracked binaries through
 * `generateBinaryFilePatch`. A binary already tracked in HEAD fell through
 * to a plain `git diff HEAD`, which degrades to the informational
 * `Binary files a/x and b/x differ`. That body carries none of the bytes and
 * cannot be replayed by `git apply`, so a `re-export` silently replaced real
 * signing-certificate deltas with an un-appliable stub while every gate
 * stayed green. These tests pin the payload for both arms, and pin that
 * `--binary` did not disturb text sections.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { getAllDiff, getDiffForFilesAgainstHead, getFileDiff } from '../git-diff.js';

const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const MODIFIED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x09, 0x63]);

const CERT = 'toolkit/certs/release_primary.der';
const TEXT = 'browser/base/content/browser.js';

describe('tracked binary diff generation (real git)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await removeTempProject(root);
      root = undefined;
    }
  });

  /** A repo where CERT and TEXT are tracked in HEAD and both modified. */
  async function initRepo(): Promise<string> {
    root = await createTempProject('ff-tracked-binary-');
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(root, ['config', 'user.name', 'FireForge Tests']);
    await runGit(root, ['config', 'core.autocrlf', 'false']);
    await runGit(root, ['config', 'core.eol', 'lf']);
    await mkdir(join(root, 'toolkit/certs'), { recursive: true });
    await mkdir(join(root, 'browser/base/content'), { recursive: true });
    await writeFile(join(root, CERT), ORIGINAL);
    await writeFile(join(root, TEXT), 'const a = 1;\nconst b = 2;\n');
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '-m', 'initial']);

    await writeFile(join(root, CERT), MODIFIED);
    await writeFile(join(root, TEXT), 'const a = 1;\nconst b = 3;\n');
    return root;
  }

  it('emits a GIT binary patch for a binary file tracked in HEAD', async () => {
    const repo = await initRepo();
    const diff = await getDiffForFilesAgainstHead(repo, [CERT]);
    expect(diff).toContain('GIT binary patch');
    expect(diff).not.toContain('Binary files');
  });

  it('produces a body git apply can actually replay', async () => {
    const repo = await initRepo();
    const diff = await getDiffForFilesAgainstHead(repo, [CERT]);
    await writeFile(join(repo, 'cert.patch'), diff);
    // Reset the worktree to HEAD, then rebuild the change from the patch alone.
    await runGit(repo, ['checkout', '--', CERT]);
    await runGit(repo, ['apply', 'cert.patch']);
    expect(await readFile(join(repo, CERT))).toEqual(MODIFIED);
  });

  it('keeps text sections byte-identical alongside a binary one', async () => {
    const repo = await initRepo();
    const combined = await getDiffForFilesAgainstHead(repo, [CERT, TEXT]);
    // Abbreviated index hashes on the text section: --binary implies
    // --full-index only for the binary section it expands.
    expect(combined).toContain('-const b = 2;');
    expect(combined).toContain('+const b = 3;');
    expect(combined).toMatch(/index [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/browser/);
  });

  it('carries the payload through getFileDiff and getAllDiff too', async () => {
    const repo = await initRepo();
    expect(await getFileDiff(repo, CERT)).toContain('GIT binary patch');
    const all = await getAllDiff(repo);
    expect(all).toContain('GIT binary patch');
    expect(all).not.toContain('Binary files');
  });
});
