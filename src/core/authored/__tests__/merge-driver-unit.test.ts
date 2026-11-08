// SPDX-License-Identifier: EUPL-1.2
/** The merge driver's decision, in this process. `merge-driver.test.ts` runs it through real Git, where coverage cannot see it. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAuthoredMergeDriver } from '../merge.js';
import { declareAuthoredOverride } from '../writer.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const PATH = 'browser/manifest.txt';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** The three files Git hands a driver. */
async function sides(
  base: string,
  ours: string,
  theirs: string
): Promise<{ base: string; ours: string; theirs: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-merge-sides-'));
  directories.push(directory);
  const paths = {
    base: join(directory, 'base'),
    ours: join(directory, 'ours'),
    theirs: join(directory, 'theirs'),
  };
  await writeFile(paths.base, base);
  await writeFile(paths.ours, ours);
  await writeFile(paths.theirs, theirs);
  return paths;
}

async function declaredProject(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await declareAuthoredOverride(value.root, PATH, {
    component: 'fixture',
    classification: 'registration',
    pristineRepository: value.pristine,
  });
  await writeAt(value.root, `src/${PATH}`, 'first\nsecond\nthird\nfourth\nFIFTH\n');
  await commitFixture(value.root);
  return value;
}

describe('the authored merge driver', () => {
  it('merges against the base Git gave it when there is one', async () => {
    const value = await declaredProject();
    const paths = await sides('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');
    const merged = await runAuthoredMergeDriver({
      projectRoot: value.root,
      ...paths,
      path: `src/${PATH}`,
      pristineRepository: value.pristine,
    });
    expect(merged).toBe(true);
    expect(await readFile(paths.ours, 'utf8')).toBe('A\nb\nc\nd\nE\n');
  });

  it('finds the pristine ancestor of a first touch when Git gave it an empty one', async () => {
    const value = await declaredProject();
    const paths = await sides(
      '',
      'FIRST\nsecond\nthird\nfourth\nfifth\n',
      'first\nsecond\nthird\nfourth\nFIFTH\n'
    );
    const merged = await runAuthoredMergeDriver({
      projectRoot: value.root,
      ...paths,
      path: `src/${PATH}`,
      pristineRepository: value.pristine,
    });
    expect(merged).toBe(true);
    expect(await readFile(paths.ours, 'utf8')).toBe('FIRST\nsecond\nthird\nfourth\nFIFTH\n');
  });

  it('leaves conflict markers, returning false, on overlapping edits', async () => {
    const value = await declaredProject();
    const paths = await sides('a\n', 'ours\n', 'theirs\n');
    const merged = await runAuthoredMergeDriver({
      projectRoot: value.root,
      ...paths,
      path: `src/${PATH}`,
      pristineRepository: value.pristine,
    });
    expect(merged).toBe(false);
    expect(await readFile(paths.ours, 'utf8')).toContain('<<<<<<<');
  });

  it('merges as add/add for a path outside the source root or with no sidecar', async () => {
    const value = await declaredProject();
    for (const path of ['docs/note.md', 'src/browser/undeclared.txt']) {
      const paths = await sides('', 'same\n', 'same\n');
      expect(
        await runAuthoredMergeDriver({
          projectRoot: value.root,
          ...paths,
          path,
          pristineRepository: value.pristine,
        })
      ).toBe(true);
    }
  });

  it('says why when the ancestor cannot be trusted, and merges as add/add', async () => {
    const value = await declaredProject();
    const notice = vi.fn();
    const paths = await sides('', 'same\n', 'same\n');
    await expect(
      runAuthoredMergeDriver({
        projectRoot: value.root,
        ...paths,
        path: `src/${PATH}`,
        pristineRepository: join(value.root, 'not-a-repository'),
        onNotice: notice,
      })
    ).resolves.toBe(true);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('Merging as add/add'));
  });
});
