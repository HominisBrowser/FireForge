// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commitAll, git as testGit, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  listRefs,
  RECOVERY_REF_PREFIX,
  resolveRevision,
  saveRecoverySnapshot,
  status,
  updateRef,
} from './index.js';

const dir = useTempDir();

describe('updateRef', () => {
  it('creates, moves and deletes refs with compare-and-swap', async () => {
    const repo = dir();
    const first = await initRepo(repo, { 'a.txt': 'a\n' });
    await writeTree(repo, { 'a.txt': 'b\n' });
    const second = await commitAll(repo, 'second');
    const ref = 'refs/fireforge/verified';

    expect(await updateRef(repo, ref, first, { expect: null })).toBe(true);
    expect(await updateRef(repo, ref, second, { expect: null })).toBe(false);
    expect(await updateRef(repo, ref, second, { expect: second })).toBe(false);
    expect(await resolveRevision(repo, ref)).toBe(first);
    expect(await updateRef(repo, ref, second, { expect: first })).toBe(true);
    expect(await updateRef(repo, ref, null, { expect: first })).toBe(false);
    expect(await updateRef(repo, ref, null, { expect: second })).toBe(true);
    expect(await resolveRevision(repo, ref)).toBeUndefined();
    expect(await updateRef(repo, ref, first)).toBe(true);
    await expect(updateRef(repo, 'refs/bad..name', first)).rejects.toMatchObject({
      code: 'git-failed',
    });
  });

  it('lists refs under a prefix sorted by name', async () => {
    const repo = dir();
    const head = await initRepo(repo);
    await updateRef(repo, 'refs/fireforge/b', head);
    await updateRef(repo, 'refs/fireforge/a', head);
    await updateRef(repo, 'refs/other/c', head);
    expect(await listRefs(repo, 'refs/fireforge/')).toEqual([
      { ref: 'refs/fireforge/a', oid: head },
      { ref: 'refs/fireforge/b', oid: head },
    ]);
  });
});

describe('saveRecoverySnapshot', () => {
  it('saves tracked edits and untracked files without moving the index, HEAD or branches', async () => {
    const repo = dir();
    const head = await initRepo(repo, { 'tracked.txt': 'one\n', '.gitignore': '*.log\n' });
    await writeTree(repo, {
      'tracked.txt': 'edited\n',
      'scratch.txt': 'only copy\n',
      'x.log': 'l\n',
    });
    const index = await readFile(join(repo, '.git', 'index'));
    const before = await status(repo);

    const snapshot = await saveRecoverySnapshot(repo, { label: 'reset --hard' });
    if (snapshot === undefined) throw new Error('expected a snapshot');
    expect(snapshot.ref).toMatch(
      /^refs\/fireforge\/recovery\/\d{8}t\d{9}z-reset-hard-[0-9a-f]{8}$/
    );
    expect(await testGit(repo, ['show', `${snapshot.ref}:scratch.txt`])).toBe('only copy\n');
    expect(await testGit(repo, ['show', `${snapshot.ref}:tracked.txt`])).toBe('edited\n');
    await expect(testGit(repo, ['show', `${snapshot.ref}:x.log`])).rejects.toThrow();
    expect(await resolveRevision(repo, `${snapshot.commit}^`)).toBe(head);

    expect(await resolveRevision(repo, 'HEAD')).toBe(head);
    expect(await status(repo)).toEqual(before);
    expect((await readFile(join(repo, '.git', 'index'))).equals(index)).toBe(true);
  });

  it('saves only the named paths and nothing when they equal HEAD', async () => {
    const repo = dir();
    await initRepo(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await writeTree(repo, { 'b.txt': 'B\n' });
    expect(
      await saveRecoverySnapshot(repo, { label: 'discard', paths: ['a.txt'] })
    ).toBeUndefined();
    const snapshot = await saveRecoverySnapshot(repo, { label: 'discard', paths: ['b.txt'] });
    expect(await testGit(repo, ['show', `${snapshot?.ref ?? ''}:b.txt`])).toBe('B\n');
  });

  it('keeps only the newest snapshots', async () => {
    const repo = dir();
    await initRepo(repo, { 'a.txt': 'a\n' });
    const refs: string[] = [];
    for (let round = 0; round < 4; round++) {
      await writeTree(repo, { 'a.txt': `round ${round}\n` });
      const snapshot = await saveRecoverySnapshot(repo, { label: 'reset', keep: 2 });
      refs.push(snapshot?.ref ?? '');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await listRefs(repo, RECOVERY_REF_PREFIX)).map((entry) => entry.ref)).toEqual(
      refs.slice(2)
    );
  });
});
