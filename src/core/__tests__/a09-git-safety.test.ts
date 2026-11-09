// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { execWithInput } from '../../utils/process-input.js';
import { collectChangedEnginePaths } from '../engine-changes.js';
import { resumeRepository } from '../git.js';
import { generateBinaryFilePatch, generateNewFileDiff, getAllDiff } from '../git-diff.js';
import { readOnlyGitIndexEnv, withPrivateGitIndex } from '../git-readonly-index.js';
import {
  getDirtyFiles,
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
} from '../git-status.js';

const controls = vi.hoisted(() => ({ failCopy: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: (...args: Parameters<typeof actual.copyFile>) =>
      controls.failCopy
        ? Promise.reject(Object.assign(new Error('fixture copy denied'), { code: 'EACCES' }))
        : actual.copyFile(...args),
  };
});
const roots: string[] = [];
afterEach(async () => {
  controls.failCopy = false;
  await Promise.all(roots.splice(0).map((root) => removeTempProject(root)));
});
async function fixture(): Promise<{ root: string; repo: string; clone: string }> {
  const root = await createTempProject('ff-a09-git-');
  roots.push(root);
  const repo = join(root, 'repo'),
    clone = join(root, 'clone');
  await mkdir(repo);
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await runGit(repo, ['config', 'user.name', 'Fixture']);
  await writeFile(join(repo, 'base.txt'), 'base\n');
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-qm', 'baseline']);
  await runGit(root, ['clone', '-q', repo, clone]);
  return { root, repo, clone };
}
it('never stages the primary index or discards conflict stages when private-index creation fails', async () => {
  const { repo } = await fixture();
  const oid = (await runGit(repo, ['rev-parse', 'HEAD:base.txt'])).trim();
  const result = await execWithInput(
    'git',
    ['update-index', '--index-info'],
    `0 ${'0'.repeat(40)}\tbase.txt\n100644 ${oid} 1\tbase.txt\n100644 ${oid} 2\tbase.txt\n`,
    { cwd: repo }
  );
  expect(result.exitCode).toBe(0);
  await writeFile(join(repo, 'new.bin'), Buffer.from([0, 1, 2]));
  const index = join(repo, '.git', 'index'),
    before = await readFile(index),
    conflicts = await runGit(repo, ['ls-files', '-u', '-z']);
  controls.failCopy = true;
  await expect(generateBinaryFilePatch(repo, 'new.bin')).rejects.toThrow(
    /refusing to stage the shared index/
  );
  const body = vi.fn(() => Promise.resolve('not authorized'));
  await expect(withPrivateGitIndex(repo, body)).rejects.toThrow(/shared-index fallback/);
  expect(body).not.toHaveBeenCalled();
  expect(await readFile(index)).toEqual(before);
  expect(await runGit(repo, ['ls-files', '-u', '-z'])).toBe(conflicts);
});
it('round trips executable and broken symlink modes plus quoted/newline Unicode paths without shared staging', async () => {
  const { root, repo, clone } = await fixture();
  await writeFile(join(repo, 'run.sh'), '#!/bin/sh\necho ready\n');
  await chmod(join(repo, 'run.sh'), 0o755);
  await symlink('missing-target', join(repo, 'link'));
  const strange = ' leading-é\nquoted".txt ';
  await writeFile(join(repo, strange), 'exact bytes\n');
  const before = await readFile(join(repo, '.git', 'index'));
  const patch = await getAllDiff(repo);
  expect(patch).toContain('new file mode 100755');
  expect(patch).toContain('new file mode 120000');
  const path = join(root, 'roundtrip.patch');
  await writeFile(path, patch);
  await runGit(clone, ['apply', path]);
  expect((await stat(join(clone, 'run.sh'))).mode & 0o111).not.toBe(0);
  expect(await readlink(join(clone, 'link'))).toBe('missing-target');
  expect(await readFile(join(clone, strange), 'utf8')).toBe('exact bytes\n');
  expect(await readFile(join(repo, '.git', 'index'))).toEqual(before);
  expect(await generateNewFileDiff(repo, 'link')).toContain('120000');
});
it('enumerates raw NUL-delimited paths and refuses baseline/working-scan failures instead of claiming clean', async () => {
  const { repo } = await fixture(),
    tracked = ' tracked-雪\nfile.txt ',
    untracked = ' new-雪\nfile.txt ';
  await writeFile(join(repo, tracked), 'before');
  await runGit(repo, ['add', '--', tracked]);
  await runGit(repo, ['commit', '-qm', 'tracked']);
  await writeFile(join(repo, tracked), 'changed');
  await writeFile(join(repo, untracked), 'new');
  expect(await getUntrackedFiles(repo)).toContain(untracked);
  expect(await getUntrackedFilesInDir(repo, '.')).toContain(untracked);
  expect(await getModifiedFilesInDir(repo, '.')).toContain(tracked);
  expect(await getDirtyFiles(repo, [tracked, untracked])).toEqual([tracked, untracked].sort());
  expect(await collectChangedEnginePaths(repo, undefined, 'fixture')).toEqual(
    [tracked, untracked].sort()
  );
  await expect(
    collectChangedEnginePaths(
      repo,
      { engineHeadSha: 'not-a-revision' } as Parameters<typeof collectChangedEnginePaths>[1],
      'fixture'
    )
  ).rejects.toThrow(/cannot establish engine changes/);
  await expect(
    collectChangedEnginePaths(join(repo, 'missing'), undefined, 'fixture')
  ).rejects.toThrow(/cannot establish complete workdir/);
});
it('preserves an unknown/replacement index lock before any resume mutations', async () => {
  const { repo } = await fixture(),
    path = join(repo, '.git', 'index.lock'),
    config = await readFile(join(repo, '.git', 'config'));
  await writeFile(path, 'external writer');
  await expect(resumeRepository(repo)).rejects.toThrow(/index.lock/);
  expect(await readFile(path, 'utf8')).toBe('external writer');
  expect(await readFile(join(repo, '.git', 'config'))).toEqual(config);
});
it('isolates concurrent and nested private-index scopes across repositories', async () => {
  const first = await fixture(),
    second = await fixture();
  let signal: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let firstIndex: string | undefined, secondIndex: string | undefined;
  await Promise.all([
    withPrivateGitIndex(first.repo, async () => {
      firstIndex = readOnlyGitIndexEnv(first.repo)?.['GIT_INDEX_FILE'];
      signal();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readOnlyGitIndexEnv(first.repo)?.['GIT_INDEX_FILE']).toBe(firstIndex);
      await withPrivateGitIndex(second.repo, () => {
        expect(readOnlyGitIndexEnv(second.repo)).toBeDefined();
        return Promise.resolve();
      });
      expect(readOnlyGitIndexEnv(first.repo)?.['GIT_INDEX_FILE']).toBe(firstIndex);
    }),
    (async () => {
      await entered;
      await withPrivateGitIndex(second.repo, () => {
        secondIndex = readOnlyGitIndexEnv(second.repo)?.['GIT_INDEX_FILE'];
        expect(readOnlyGitIndexEnv(first.repo)).toBeUndefined();
        return Promise.resolve();
      });
    })(),
  ]);
  expect(firstIndex).toBeDefined();
  expect(secondIndex).toBeDefined();
  expect(firstIndex).not.toBe(secondIndex);
  expect(readOnlyGitIndexEnv(first.repo)).toBeUndefined();
});
