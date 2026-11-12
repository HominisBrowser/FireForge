// SPDX-License-Identifier: EUPL-1.2
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { parseApplyOutput } from './apply.js';
import {
  apply,
  diffWorktree,
  listTree,
  mergeFile,
  reset,
  resolveRevision,
  status,
} from './index.js';

const dir = useTempDir();
const ORIGINAL = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

/** A repository at ORIGINAL plus the patch that changes line 6, and the tree it leads to. */
async function patched(): Promise<{ repo: string; patch: Buffer }> {
  const repo = dir();
  await initRepo(repo, { 'f.txt': ORIGINAL, 'other.txt': 'o\n' });
  await writeTree(repo, { 'f.txt': ORIGINAL.replace('line 6\n', 'line six\n') });
  const patch = await diffWorktree(repo);
  await reset(repo);
  return { repo, patch };
}

describe('apply', () => {
  it('checks without changing anything, applies, and reverses', async () => {
    const { repo, patch } = await patched();
    expect(await apply(repo, patch, { check: true })).toMatchObject({
      applied: true,
      conflicts: [],
    });
    expect(await status(repo)).toEqual([]);
    expect((await apply(repo, patch)).applied).toBe(true);
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toContain('line six');
    expect(await status(repo)).toEqual([{ path: 'f.txt', index: ' ', worktree: 'M' }]);
    expect((await apply(repo, patch, { reverse: true })).applied).toBe(true);
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe(ORIGINAL);
  });

  it('updates the index too when asked', async () => {
    const { repo, patch } = await patched();
    await apply(repo, patch, { target: 'index' });
    expect(await status(repo)).toEqual([{ path: 'f.txt', index: 'M', worktree: ' ' }]);
  });

  it('applies to a tree in a private index and returns the result, touching nothing', async () => {
    const { repo, patch } = await patched();
    const result = await apply(repo, patch, { target: { tree: 'HEAD' } });
    expect(result.applied).toBe(true);
    const entries = await listTree(repo, result.tree ?? '');
    expect(entries.map((entry) => entry.path)).toEqual(['f.txt', 'other.txt']);
    expect(entries[0]?.oid).not.toBe(await resolveRevision(repo, 'HEAD:f.txt'));
    expect(await status(repo)).toEqual([]);
    const checked = await apply(repo, patch, { target: { tree: 'HEAD' }, check: true });
    expect(checked).toMatchObject({ applied: true });
    expect(checked.tree).toBeUndefined();
  });

  it('names the failed file and line when the context drifted, and fits with less context', async () => {
    const { repo, patch } = await patched();
    await writeTree(repo, { 'f.txt': ORIGINAL.replace('line 4\n', 'line FOUR\n') });
    const exact = await apply(repo, patch);
    expect(exact.applied).toBe(false);
    expect(exact.conflicts).toEqual([
      { path: 'f.txt', reason: 'patch failed', line: 3 },
      { path: 'f.txt', reason: 'patch does not apply' },
    ]);
    const loose = await apply(repo, patch, { context: 1 });
    expect(loose.applied).toBe(true);
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toContain('line FOUR\nline 5\nline six\n');
  });

  it('leaves .rej files for hunks that do not fit and names their files', async () => {
    const { repo, patch } = await patched();
    await writeTree(repo, { 'f.txt': 'completely\ndifferent\n' });
    const result = await apply(repo, patch, { reject: true });
    expect(result.applied).toBe(false);
    expect(result.rejected).toEqual(['f.txt']);
    await access(join(repo, 'f.txt.rej'));
  });

  it('reports a patch git cannot read as not applied', async () => {
    const { repo } = await patched();
    const result = await apply(
      repo,
      'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,5 @@\n-x\n'
    );
    expect(result.applied).toBe(false);
    expect(result.stderr).toMatch(/corrupt patch/);
    expect((await apply(repo, '')).applied).toBe(true);
  });

  it('reads the conflicts and rejects git prints', () => {
    expect(
      parseApplyOutput(
        [
          'error: patch failed: browser/a.js:12',
          'error: browser/a.js: patch does not apply',
          'error: browser/new.js: already exists in working directory',
          'error: gone.js: does not exist in index',
          'Applying patch "f\\303\\274r.js" with 2 rejects...',
          'Applying patch plain.js with 1 reject...',
          'Rejected hunk #1.',
        ].join('\n')
      )
    ).toEqual({
      conflicts: [
        { path: 'browser/a.js', reason: 'patch failed', line: 12 },
        { path: 'browser/a.js', reason: 'patch does not apply' },
        { path: 'browser/new.js', reason: 'already exists in working directory' },
        { path: 'gone.js', reason: 'does not exist in index' },
      ],
      rejected: ['für.js', 'plain.js'],
    });
  });
});

describe('mergeFile', () => {
  it('merges independent changes and marks conflicting ones', async () => {
    const repo = dir();
    await initRepo(repo);
    const base = Buffer.from('a\nb\nc\nd\ne\n');
    const clean = await mergeFile(repo, {
      base,
      ours: Buffer.from('A\nb\nc\nd\ne\n'),
      theirs: Buffer.from('a\nb\nc\nd\nE\n'),
    });
    expect(clean).toEqual({ content: Buffer.from('A\nb\nc\nd\nE\n'), conflicts: 0 });
    const conflicted = await mergeFile(
      repo,
      { base, ours: Buffer.from('a\nX\nc\nd\ne\n'), theirs: Buffer.from('a\nY\nc\nd\ne\n') },
      { ours: 'source', base: 'old pin', theirs: 'new pin' }
    );
    expect(conflicted.conflicts).toBe(1);
    expect(conflicted.content.toString()).toBe(
      'a\n<<<<<<< source\nX\n=======\nY\n>>>>>>> new pin\nc\nd\ne\n'
    );
  });
});
