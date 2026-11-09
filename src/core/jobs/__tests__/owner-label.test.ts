// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ownerLabel } from '../owner.js';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

async function repository(name: string): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ff-owner-')));
  roots.push(base);
  const directory = join(base, name);
  await mkdir(directory);
  git(directory, 'init', '-q', '-b', 'topic');
  git(directory, 'commit', '-q', '--allow-empty', '-m', 'first');
  return directory;
}

describe('ownerLabel', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['FIREFORGE_OWNER'];
    delete process.env['FIREFORGE_OWNER'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['FIREFORGE_OWNER'];
    else process.env['FIREFORGE_OWNER'] = saved;
  });

  it('names the worktree and its branch, so sessions differ', async () => {
    const one = await repository('wt-one');
    const two = await repository('wt-two');
    git(two, 'checkout', '-q', '-b', 'other');
    expect(ownerLabel(one)).toBe('wt-one@topic');
    expect(ownerLabel(two)).toBe('wt-two@other');
  });

  it('names the short commit when HEAD is detached', async () => {
    const directory = await repository('wt-detached');
    git(directory, 'checkout', '-q', '--detach');
    expect(ownerLabel(directory)).toBe(
      `wt-detached@${git(directory, 'rev-parse', '--short', 'HEAD')}`
    );
  });

  it('falls back to user@host outside git', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'ff-owner-')));
    roots.push(base);
    expect(ownerLabel(base)).toBe(`${userInfo().username}@${hostname()}`);
  });

  it('lets FIREFORGE_OWNER decide', async () => {
    process.env['FIREFORGE_OWNER'] = 'chosen';
    expect(ownerLabel(await repository('wt-env'))).toBe('chosen');
  });
});
