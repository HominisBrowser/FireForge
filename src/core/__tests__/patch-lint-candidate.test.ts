// SPDX-License-Identifier: EUPL-1.2
import { access, lstat, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import { withPatchLintCandidate } from '../patch-lint-candidate.js';
import { runCheckJs } from '../patch-lint-checkjs.js';

let root: string;
const path = 'browser/modules/Owned.sys.mjs';
const header = '/* SPDX-License-Identifier: EUPL-1.2 */';
const clean = `${header}\n/** @type {number} */\nexport const n = 1;\n`;
const bad = clean.replace('n = 1', 'n = "wrong"');
function newFileDiff(file: string, content: string): string {
  const lines = content.trimEnd().split('\n');
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
}
beforeEach(async () => {
  root = await createTempProject('ff-candidate-');
  await initCommittedRepo(join(root, 'engine'), { 'tracked.txt': 'old\n', 'remove.txt': 'gone\n' });
  await writeFiles(root, {
    [`engine/${path}`]: clean,
    'engine/browser/modules/Peer.sys.mjs': 'export const peer = 7;\n',
  });
});
afterEach(async () => {
  await removeTempProject(root);
});

describe('private lint candidate', () => {
  it.each([
    [clean, bad, true],
    [bad, clean, false],
  ] as const)(
    'checks selected bytes independently of current working content',
    async (working, selected, fails) => {
      await writeFiles(root, { [`engine/${path}`]: working });
      let scratch: string | undefined;
      const issues = await withPatchLintCandidate(
        join(root, 'engine'),
        newFileDiff(path, selected),
        async (candidate) => {
          scratch = candidate;
          expect(await readFile(join(candidate, path), 'utf8')).toBe(selected);
          expect(await readFile(join(candidate, 'browser/modules/Peer.sys.mjs'), 'utf8')).toContain(
            'peer = 7'
          );
          expect(
            (await lstat(join(candidate, 'browser/modules/Peer.sys.mjs'))).isSymbolicLink()
          ).toBe(true);
          await expect(access(join(candidate, '.git'))).rejects.toThrow();
          return runCheckJs(candidate, new Set([path]));
        }
      );
      expect(issues.some((issue) => issue.check === 'checkjs-type-error')).toBe(fails);
      expect(await readFile(join(root, 'engine', path), 'utf8')).toBe(working);
      await expect(access(scratch ?? '')).rejects.toThrow();
    }
  );
  it('reconstructs a tracked modification and deletion against HEAD, not current working bytes', async () => {
    await writeFiles(root, { 'engine/tracked.txt': 'peer\n' });
    const diff =
      'diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-old\n+selected\n' +
      'diff --git a/remove.txt b/remove.txt\ndeleted file mode 100644\n--- a/remove.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
    await withPatchLintCandidate(join(root, 'engine'), diff, async (candidate) => {
      expect(await readFile(join(candidate, 'tracked.txt'), 'utf8')).toBe('selected\n');
      await expect(access(join(candidate, 'remove.txt'))).rejects.toThrow();
    });
    expect(await readFile(join(root, 'engine/tracked.txt'), 'utf8')).toBe('peer\n');
  });
  it('materializes new parent directories and cleans up after a lint exception', async () => {
    let scratch = '';
    await expect(
      withPatchLintCandidate(
        join(root, 'engine'),
        newFileDiff('new/nested/new.js', 'hello\n'),
        async (candidate) => {
          scratch = candidate;
          expect(await readFile(join(candidate, 'new/nested/new.js'), 'utf8')).toBe('hello\n');
          throw new Error('lint failed');
        }
      )
    ).rejects.toThrow('lint failed');
    await expect(access(scratch)).rejects.toThrow();
  });
  it('refuses a candidate path through a source directory alias', async () => {
    await symlink(join(root, 'engine/browser'), join(root, 'engine/alias'));
    await expect(
      withPatchLintCandidate(join(root, 'engine'), newFileDiff('alias/owned.js', 'hello\n'), () =>
        Promise.resolve(undefined)
      )
    ).rejects.toThrow(/real directory/);
    await expect(access(join(root, 'engine/browser/owned.js'))).rejects.toThrow();
  });
  it.each(['../outside.js', '.git/config'])(
    'refuses escaping or Git-private candidate path: %s',
    async (file) => {
      await expect(
        withPatchLintCandidate(join(root, 'engine'), newFileDiff(file, 'hello\n'), () =>
          Promise.resolve(undefined)
        )
      ).rejects.toThrow(/Invalid candidate/);
    }
  );
});
