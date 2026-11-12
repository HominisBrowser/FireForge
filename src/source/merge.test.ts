// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { commitAll, git, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { ancestorAbsent, completedAttributes, mergeContent } from './merge.js';

const dir = useTempDir();
const PATH = 'tracked.txt';

interface History {
  root: string;
  /** Has no PATH. */
  first: string;
  /** Adds PATH. */
  second: string;
  /** Edits PATH. */
  third: string;
}

async function history(): Promise<History> {
  const root = dir();
  const first = await initRepo(root, { 'other.txt': 'other\n' });
  await writeTree(root, { [PATH]: 'one\n' });
  const second = await commitAll(root, 'add');
  await writeTree(root, { [PATH]: 'two\n' });
  return { root, first, second, third: await commitAll(root, 'edit') };
}

describe('ancestorAbsent', () => {
  it('reads an abbreviated id as the merge base', async () => {
    const { root, first, second } = await history();
    expect(await ancestorAbsent(root, PATH, first.slice(0, 10))).toBe(true);
    expect(await ancestorAbsent(root, PATH, second.slice(0, 10))).toBe(false);
  });

  it('reads "parent of <id> (...)" as the picked commit\'s parent', async () => {
    const { root, first, second, third } = await history();
    expect(await ancestorAbsent(root, PATH, `parent of ${second.slice(0, 10)} (add)`)).toBe(true);
    expect(await ancestorAbsent(root, PATH, `parent of ${third.slice(0, 10)} (edit)`)).toBe(false);
    expect(await ancestorAbsent(root, PATH, `parent of ${first.slice(0, 10)} (root)`)).toBe(
      undefined
    );
  });

  it('reads "<id> (...)" as the reverted commit itself', async () => {
    const { root, first, second } = await history();
    expect(await ancestorAbsent(root, PATH, `${first.slice(0, 10)} (root)`)).toBe(true);
    expect(await ancestorAbsent(root, PATH, `${second.slice(0, 10)} (add)`)).toBe(false);
  });

  it('names nothing for labels that match no commit or no known shape', async () => {
    const { root, second } = await history();
    for (const label of [
      'deadbeefdead',
      'parent of deadbeefdead (gone)',
      'deadbeefdead (gone)',
      'merged common ancestors',
      `${second.slice(0, 10)}x`,
      `parent of ${second.slice(0, 10)}`,
    ]) {
      expect(await ancestorAbsent(root, PATH, label), label).toBeUndefined();
    }
  });

  it('names nothing for the parent of a merge commit', async () => {
    const { root, first } = await history();
    await git(root, ['checkout', '--quiet', '-b', 'side', first]);
    await writeTree(root, { 'side.txt': 'side\n' });
    await commitAll(root, 'side');
    await git(root, ['checkout', '--quiet', 'main']);
    await git(root, ['merge', '--quiet', '--no-edit', 'side']);
    const merge = (await git(root, ['rev-parse', 'HEAD'])).trim();
    expect(await ancestorAbsent(root, PATH, `parent of ${merge.slice(0, 10)} (merge)`)).toBe(
      undefined
    );
  });
});

describe('mergeContent', () => {
  const merge = (
    base: string | Buffer,
    ours: string | Buffer,
    theirs: string | Buffer
  ): ReturnType<typeof mergeContent> =>
    mergeContent(
      dir(),
      { base: Buffer.from(base), ours: Buffer.from(ours), theirs: Buffer.from(theirs) },
      { ours: 'ours', base: 'base', theirs: 'theirs' }
    );

  it('takes the changed side, merges text, and marks overlapping edits', async () => {
    expect(await merge('a\n', 'a\n', 'b\n')).toEqual({ clean: true, content: Buffer.from('b\n') });
    expect(await merge('a\n', 'b\n', 'a\n')).toEqual({ clean: true, content: Buffer.from('b\n') });
    const text = 'one\ntwo\nthree\nfour\nfive\n';
    expect(await merge(text, text.replace('one', 'ONE'), text.replace('five', 'FIVE'))).toEqual({
      clean: true,
      content: Buffer.from('ONE\ntwo\nthree\nfour\nFIVE\n'),
    });
    const conflict = await merge(text, text.replace('one', 'OURS'), text.replace('one', 'THEIRS'));
    expect(conflict).toMatchObject({ clean: false, reason: 'content' });
    expect(conflict.clean ? '' : conflict.markers?.toString()).toContain('<<<<<<< ours');
  });

  it('refuses to pick a side of competing binary edits', async () => {
    expect(await merge(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]))).toEqual({
      clean: false,
      reason: 'binary',
    });
  });
});

describe('completedAttributes', () => {
  it('adds only the missing lines', () => {
    expect(completedAttributes(undefined)).toBe('* -text\n* merge=fireforge\n');
    expect(completedAttributes('*.png binary')).toBe('*.png binary\n* -text\n* merge=fireforge\n');
    expect(completedAttributes('* -text\n* merge=fireforge\n')).toBeUndefined();
  });
});
