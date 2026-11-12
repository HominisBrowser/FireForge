// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePatch } from '../diff/index.js';
import { commitAll, git, gitBytes, initRepo } from '../testing/git.js';
import { makeTempDir, removeTempDir, useTempDir, writeTree } from '../testing/temp.js';
import { applyToTree, applyWithRejects, replay, sparseTree, statesIn } from './apply.js';
import { replayQueue, writeQueue } from './index.js';

const dir = useTempDir();
const FILE = 'browser/base/content/browser.js';
const CONTEXT = [
  'line-a',
  'line-b',
  'line-c',
  'title = "baseline";',
  'line-d',
  'line-e',
  'line-f',
  '',
].join('\n');
const STAMP = { product: 'firefox-esr' as const, version: '140.9.0esr' };

function patchOf(
  filename: string,
  body: Buffer | string
): {
  filename: string;
  body: Buffer;
  diff: ReturnType<typeof parsePatch>;
  files: string[];
} {
  const bytes = Buffer.from(body);
  const diff = parsePatch(bytes);
  return { filename, body: bytes, diff, files: [...new Set(diff.files.map((file) => file.path))] };
}

/** The diff the edits make against HEAD (null deletes a file); the working tree is put back. */
async function diffOf(
  repo: string,
  files: Record<string, string | Buffer | null>
): Promise<Buffer> {
  const writes: Record<string, string | Buffer> = {};
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(repo, path));
    else writes[path] = content;
  }
  await writeTree(repo, writes);
  await git(repo, ['add', '-A']);
  const body = await gitBytes(repo, ['diff', '--cached', '--binary', '--full-index']);
  await git(repo, ['reset', '-q', '--hard']);
  await git(repo, ['clean', '-fdq']);
  return body;
}

async function headTree(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim();
}

async function blobAt(repo: string, tree: string, path: string): Promise<string> {
  return git(repo, ['show', `${tree}:${path}`]);
}

describe('applyToTree', () => {
  it('applies exactly to a tree and leaves the working tree and index alone', async () => {
    await initRepo(dir(), { [FILE]: CONTEXT });
    const patch = patchOf(
      '001-ui-title.patch',
      await diffOf(dir(), { [FILE]: CONTEXT.replace('baseline', 'patched') })
    );
    const index = await git(dir(), ['ls-files', '-s']);
    const outcome = await applyToTree(dir(), await headTree(dir()), patch);
    expect(outcome).toMatchObject({ applied: true, fuzz: 0, replaced: [] });
    if (!outcome.applied) return;
    expect(await blobAt(dir(), outcome.tree, FILE)).toContain('patched');
    expect(await readFile(join(dir(), FILE), 'utf8')).toBe(CONTEXT);
    expect(await git(dir(), ['ls-files', '-s'])).toBe(index);
  });

  it('absorbs drifted context only with fuzz, stepping down to -C0', async () => {
    await initRepo(dir(), { [FILE]: CONTEXT });
    const patch = patchOf(
      '001-ui-title.patch',
      await diffOf(dir(), { [FILE]: CONTEXT.replace('baseline', 'patched') })
    );
    await writeTree(dir(), {
      [FILE]: CONTEXT.replace('line-a', 'drift-a').replace('line-f', 'drift-f'),
    });
    await commitAll(dir(), 'outer drift');
    const outer = await headTree(dir());
    const exact = await applyToTree(dir(), outer, patch);
    expect(exact.applied).toBe(false);
    if (!exact.applied) expect(exact.conflicts[0]?.path).toBe(FILE);
    expect(await applyToTree(dir(), outer, patch, { fuzz: true })).toMatchObject({
      applied: true,
      fuzz: 1,
    });

    await writeTree(dir(), {
      [FILE]: ['x-a', 'x-b', 'x-c', 'title = "baseline";', 'x-d', 'x-e', 'x-f', ''].join('\n'),
    });
    await commitAll(dir(), 'all context drift');
    expect(await applyToTree(dir(), await headTree(dir()), patch, { fuzz: true })).toMatchObject({
      applied: true,
      fuzz: 3,
    });

    await writeTree(dir(), { [FILE]: CONTEXT.replace('baseline', 'upstream') });
    await commitAll(dir(), 'conflict');
    const refused = await applyToTree(dir(), await headTree(dir()), patch, { fuzz: true });
    expect(refused.applied).toBe(false);
  });

  it('replaces an upstream file with a new-file section only where allowed', async () => {
    await initRepo(dir(), { 'a.txt': 'a\n' });
    const text = patchOf('001-ui-new.patch', await diffOf(dir(), { 'new.txt': 'mine\n' }));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]);
    const binary = patchOf('002-ui-icon.patch', await diffOf(dir(), { 'icon.png': png }));
    expect(await applyToTree(dir(), await headTree(dir()), binary)).toMatchObject({
      applied: true,
    });

    await writeTree(dir(), { 'new.txt': 'upstream\n', 'icon.png': Buffer.from([0, 9, 9]) });
    await commitAll(dir(), 'upstream adds the same files');
    const tree = await headTree(dir());
    expect(await applyToTree(dir(), tree, text)).toMatchObject({
      applied: false,
      conflicts: [{ path: 'new.txt', reason: 'already exists in index' }],
    });
    const replaced = await applyToTree(dir(), tree, text, { replaceable: new Set(['new.txt']) });
    expect(replaced).toMatchObject({ applied: true, replaced: ['new.txt'] });
    if (replaced.applied) expect(await blobAt(dir(), replaced.tree, 'new.txt')).toBe('mine\n');
    const icon = await applyToTree(dir(), tree, binary, { replaceable: new Set(['icon.png']) });
    expect(icon).toMatchObject({ applied: true, replaced: ['icon.png'] });
    if (icon.applied) {
      expect(await gitBytes(dir(), ['cat-file', 'blob', `${icon.tree}:icon.png`])).toEqual(png);
    }
  });

  it('refuses a content-less binary section and a path outside the engine', async () => {
    await initRepo(dir(), { 'a.txt': 'a\n' });
    const stub = patchOf(
      '001-ui-stub.patch',
      'diff --git a/icon.png b/icon.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/icon.png differ\n'
    );
    expect(await applyToTree(dir(), await headTree(dir()), stub)).toMatchObject({
      applied: false,
      conflicts: [{ path: 'icon.png', reason: expect.stringContaining('no content') as string }],
    });
    const escape = patchOf(
      '002-ui-escape.patch',
      'diff --git a/../outside.txt b/../outside.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+x\n'
    );
    expect(await applyToTree(dir(), await headTree(dir()), escape)).toMatchObject({
      applied: false,
      conflicts: [
        { path: '../outside.txt', reason: expect.stringContaining('leaves the engine') as string },
      ],
    });
  });
});

describe('a body git cannot read', () => {
  it('is refused, not thrown', async () => {
    await initRepo(dir(), { 'a.txt': 'a\n' });
    const outcome = await applyToTree(
      dir(),
      await headTree(dir()),
      patchOf('001-ui-x.patch', 'not a patch\n')
    );
    expect(outcome.applied).toBe(false);
  });
});

describe('applyWithRejects', () => {
  it('applies the hunks that fit and leaves the rest in .rej files', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const text = (edit: (copy: string[]) => void): string => {
      const copy = [...lines];
      edit(copy);
      return `${copy.join('\n')}\n`;
    };
    await initRepo(dir(), { [FILE]: text(() => undefined) });
    const patch = patchOf(
      '001-ui-two.patch',
      await diffOf(dir(), {
        [FILE]: text((copy) => {
          copy[1] = 'first patched';
          copy[18] = 'last patched';
        }),
      })
    );
    await writeTree(dir(), { [FILE]: text((copy) => (copy[18] = 'last upstream')) });
    const outcome = await applyWithRejects(dir(), patch);
    expect(outcome).toMatchObject({ applied: false, rejects: [`${FILE}.rej`] });
    expect(await readFile(join(dir(), FILE), 'utf8')).toContain('first patched');
    expect(await readFile(join(dir(), `${FILE}.rej`), 'utf8')).toContain('last patched');
  });

  it('refuses a path through a symlink that leaves the engine', async () => {
    const outside = await makeTempDir();
    try {
      await initRepo(dir(), { 'a.txt': 'a\n' });
      await mkdir(join(dir(), 'browser'));
      await symlink(outside, join(dir(), 'browser', 'linked'));
      const patch = patchOf(
        '001-ui-link.patch',
        'diff --git a/browser/linked/x.txt b/browser/linked/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/browser/linked/x.txt\n@@ -0,0 +1 @@\n+x\n'
      );
      await expect(applyWithRejects(dir(), patch)).rejects.toMatchObject({ code: 'path-escape' });
    } finally {
      await removeTempDir(outside);
    }
  });
});

describe('replay', () => {
  it('chains patches on a sparse tree, records each step, and can keep going past a failure', async () => {
    await initRepo(dir(), {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'e.txt': 'e\n',
      'other.txt': 'other\n',
    });
    const first = patchOf(
      '001-ui-a.patch',
      await diffOf(dir(), { 'a.txt': 'a1\n', 'c.txt': 'c\n' })
    );
    const broken = patchOf('002-ui-b.patch', await diffOf(dir(), { 'b.txt': 'b1\n' }));
    const last = patchOf('003-ui-d.patch', await diffOf(dir(), { 'd.txt': 'd\n', 'e.txt': null }));
    await writeTree(dir(), { 'b.txt': 'b-upstream\n' });
    await commitAll(dir(), 'upstream');
    const start = await sparseTree(dir(), 'HEAD', ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
    expect((await statesIn(dir(), start, ['other.txt'])).get('other.txt')).toBeNull();

    const stopped = await replay(dir(), start, [first, broken, last]);
    expect(stopped.steps.map((step) => step.patch)).toEqual(['001-ui-a.patch']);
    expect(stopped.failures).toMatchObject([{ index: 1, patch: '002-ui-b.patch' }]);
    expect(stopped.steps[0]?.changes.map((change) => change.path)).toEqual(['a.txt', 'c.txt']);

    const all = await replay(dir(), start, [first, broken, last], { keepGoing: true });
    expect(all.steps.map((step) => step.patch)).toEqual(['001-ui-a.patch', '003-ui-d.patch']);
    expect(all.failures.map((failure) => failure.index)).toEqual([1]);
    expect(all.steps[1]?.changes).toMatchObject([
      { path: 'd.txt', state: { mode: '100644' } },
      { path: 'e.txt', state: null },
    ]);
  });
});

describe('replayQueue', () => {
  it('returns the full tree a queue produces on a commit', async () => {
    await initRepo(dir(), { 'a.txt': 'a\n', 'keep.txt': 'keep\n' });
    const queueDir = join(dir(), '..', `${basename(dir())}-queue`);
    try {
      await writeQueue(queueDir, {
        patches: [
          {
            order: 1,
            name: 'ui-a',
            description: '',
            firefox: STAMP,
            body: await diffOf(dir(), { 'a.txt': 'a1\n' }),
          },
          {
            order: 2,
            name: 'ui-gone',
            description: '',
            firefox: STAMP,
            body: await diffOf(dir(), { 'keep.txt': null }),
          },
        ],
      });
      const tree = await replayQueue(dir(), 'HEAD', queueDir);
      expect((await git(dir(), ['ls-tree', '--name-only', tree])).trim().split('\n')).toEqual([
        'a.txt',
      ]);
      expect(await blobAt(dir(), tree, 'a.txt')).toBe('a1\n');
      await writeTree(dir(), { 'a.txt': 'conflict\n' });
      await commitAll(dir(), 'conflict');
      await expect(replayQueue(dir(), 'HEAD', queueDir)).rejects.toMatchObject({
        code: 'queue-does-not-apply',
      });
    } finally {
      await removeTempDir(queueDir);
    }
  });
});
