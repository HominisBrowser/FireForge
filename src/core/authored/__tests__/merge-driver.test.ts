// SPDX-License-Identifier: EUPL-1.2
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureAuthoredSnapshot } from '../capture.js';
import { sourceGit } from '../git.js';
import { authoredMergeDriverInstalled, installAuthoredMergeDriver } from '../merge.js';
import { declareAuthoredOverride } from '../writer.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const PATH = 'browser/manifest.txt';
const REPOSITORY = process.cwd();

/** Plain Git as an agent runs it, with no FireForge environment. */
function git(cwd: string, ...args: string[]): { status: number; output: string } {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=agent@example.invalid', '-c', 'user.name=Agent', ...args],
    { cwd, encoding: 'utf8' }
  );
  return { status: result.status ?? 255, output: `${result.stdout}${result.stderr}` };
}

/** Two branches each first-touching the same upstream file, from a commit that has neither. */
async function twoFirstTouches(
  ours: string,
  theirs: string,
  options: { driver?: boolean } = {}
): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await writeAt(value.root, 'src/.gitattributes', '* -text\n* merge=fireforge-authored\n');
  await commitFixture(value.root);
  if (options.driver !== false) {
    // A shell wrapper stands in for the installed binary, as the real command is a node invocation.
    const wrapper = join(dirname(value.root), 'fireforge-under-test');
    await writeFile(
      wrapper,
      [
        '#!/bin/sh',
        `FIREFORGE_PRISTINE_REPOSITORY='${value.pristine}'`,
        'export FIREFORGE_PRISTINE_REPOSITORY',
        `exec '${REPOSITORY}/node_modules/.bin/tsx' '${REPOSITORY}/bin/fireforge.ts' "$@"`,
        '',
      ].join('\n')
    );
    await chmod(wrapper, 0o755);
    await installAuthoredMergeDriver(value.root, wrapper);
  }
  const touch = async (branch: string, content: string): Promise<void> => {
    git(value.root, 'checkout', '-q', '-b', branch, 'HEAD');
    await declareAuthoredOverride(value.root, PATH, {
      component: 'fixture',
      classification: 'registration',
      pristineRepository: value.pristine,
    });
    await writeAt(value.root, `src/${PATH}`, content);
    await commitFixture(value.root);
    git(value.root, 'checkout', '-q', '-');
  };
  await touch('agent-a', ours);
  await touch('agent-b', theirs);
  git(value.root, 'checkout', '-q', 'agent-a');
  return value;
}

describe('first-touch merges through plain git merge', () => {
  it('merges non-overlapping edits of two first touches against the pristine ancestor', async () => {
    const value = await twoFirstTouches(
      'FIRST\nsecond\nthird\nfourth\nfifth\n',
      'first\nsecond\nthird\nfourth\nFIFTH\n'
    );
    const merge = git(value.root, 'merge', '--no-edit', 'agent-b');
    expect(merge.output).not.toContain('CONFLICT');
    expect(merge.status).toBe(0);
    expect(await readFile(join(value.root, `src/${PATH}`), 'utf8')).toBe(
      'FIRST\nsecond\nthird\nfourth\nFIFTH\n'
    );
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: value.root,
      pristineRepository: value.pristine,
    });
    expect(snapshot.files.find((file) => file.path === PATH)?.declaration?.base.blob).toBe(
      value.declaration.base.blob
    );
  }, 60_000);

  it('rebases and cherry-picks through the same driver', async () => {
    const value = await twoFirstTouches(
      'FIRST\nsecond\nthird\nfourth\nfifth\n',
      'first\nsecond\nthird\nfourth\nFIFTH\n'
    );
    const rebase = git(value.root, 'rebase', 'agent-b');
    expect(rebase.status).toBe(0);
    expect(await readFile(join(value.root, `src/${PATH}`), 'utf8')).toBe(
      'FIRST\nsecond\nthird\nfourth\nFIFTH\n'
    );
  }, 60_000);

  it('leaves real conflict markers for overlapping edits and stops the merge', async () => {
    const value = await twoFirstTouches(
      'OURS\nsecond\nthird\nfourth\nfifth\n',
      'THEIRS\nsecond\nthird\nfourth\nfifth\n'
    );
    const merge = git(value.root, 'merge', '--no-edit', 'agent-b');
    expect(merge.status).not.toBe(0);
    const content = await readFile(join(value.root, `src/${PATH}`), 'utf8');
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('OURS');
    expect(content).toContain('THEIRS');
    expect(content).toContain('second\nthird');
  }, 60_000);

  it('keeps Git add/add behaviour with no driver installed, never a silent wrong merge', async () => {
    const value = await twoFirstTouches(
      'FIRST\nsecond\nthird\nfourth\nfifth\n',
      'first\nsecond\nthird\nfourth\nFIFTH\n',
      { driver: false }
    );
    expect(await authoredMergeDriverInstalled(value.root)).toBe(false);
    const merge = git(value.root, 'merge', '--no-edit', 'agent-b');
    expect(merge.status).not.toBe(0);
    expect(merge.output).toContain('add/add');
  }, 60_000);

  it('is one configuration for every linked worktree', async () => {
    const value = await twoFirstTouches(
      'FIRST\nsecond\nthird\nfourth\nfifth\n',
      'first\nsecond\nthird\nfourth\nFIFTH\n'
    );
    const worktree = join(dirname(value.root), 'linked');
    git(value.root, 'checkout', '-q', '--detach');
    await sourceGit(value.root, ['worktree', 'add', '-q', worktree, 'agent-a']);
    expect(await authoredMergeDriverInstalled(worktree)).toBe(true);
    const merge = git(worktree, 'merge', '--no-edit', 'agent-b');
    expect(merge.status).toBe(0);
    expect(execFileSync('git', ['status', '--short'], { cwd: worktree }).toString()).toBe('');
  }, 60_000);
});
