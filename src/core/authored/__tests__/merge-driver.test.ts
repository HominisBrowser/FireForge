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

/** Whether this Git passes the ancestor label `%S` to a merge driver (Git 2.44 and later). */
const PASSES_ANCESTOR_LABEL = ((): boolean => {
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(git(process.cwd(), '--version').output) ?? [])
    .slice(1)
    .map(Number);
  return major > 2 || (major === 2 && minor >= 44);
})();

/**
 * How the fixture's driver is configured: as installed, as installed but without `%S` (what a Git
 * that does not pass the label leaves the driver with), or not at all.
 */
type DriverSetup = boolean | 'without-label';

/** A source fixture whose `src/` merges through the driver, unless told otherwise. */
async function drivenFixture(
  options: { driver?: DriverSetup } = {}
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
    const line = await installAuthoredMergeDriver(value.root, wrapper);
    if (options.driver === 'without-label')
      await sourceGit(value.root, [
        'config',
        '--local',
        'merge.fireforge-authored.driver',
        line.replace(/ %S$/u, ''),
      ]);
  }
  return value;
}

async function declareOverride(root: string, pristine: string): Promise<void> {
  await declareAuthoredOverride(root, PATH, {
    component: 'fixture',
    classification: 'registration',
    pristineRepository: pristine,
  });
}

/** Two branches each first-touching the same upstream file, from a commit that has neither. */
async function twoFirstTouches(
  ours: string,
  theirs: string,
  options: { driver?: DriverSetup; theirsAfterUnrelated?: boolean } = {}
): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await drivenFixture(options);
  const touch = async (branch: string, content: string, unrelated = false): Promise<void> => {
    git(value.root, 'checkout', '-q', '-b', branch, 'HEAD');
    if (unrelated) {
      await writeAt(value.root, 'docs/unrelated.md', 'unrelated\n');
      await commitFixture(value.root);
    }
    await declareOverride(value.root, value.pristine);
    await writeAt(value.root, `src/${PATH}`, content);
    await commitFixture(value.root);
    git(value.root, 'checkout', '-q', '-');
  };
  await touch('agent-a', ours);
  await touch('agent-b', theirs, options.theirsAfterUnrelated === true);
  git(value.root, 'checkout', '-q', 'agent-a');
  return value;
}

/**
 * An override that empties the pristine file, committed, then two branches that each fill it.
 * The empty file is the real common ancestor, not a missing one.
 */
async function twoFillsOfAnEmptyOverride(
  ours: string,
  theirs: string,
  options: { driver?: DriverSetup } = {}
): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await drivenFixture(options);
  await declareOverride(value.root, value.pristine);
  await writeAt(value.root, `src/${PATH}`, '');
  await commitFixture(value.root);
  const fill = async (branch: string, content: string): Promise<void> => {
    git(value.root, 'checkout', '-q', '-b', branch, 'HEAD');
    await writeAt(value.root, `src/${PATH}`, content);
    await commitFixture(value.root);
    git(value.root, 'checkout', '-q', '-');
  };
  await fill('agent-a', ours);
  await fill('agent-b', theirs);
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
    const picked = await twoFirstTouches(
      'FIRST\nsecond\nthird\nfourth\nfifth\n',
      'first\nsecond\nthird\nfourth\nFIFTH\n'
    );
    const pick = git(picked.root, 'cherry-pick', 'agent-b');
    // A single-commit cherry-pick names its ancestor only through `%S`.
    if (PASSES_ANCESTOR_LABEL) {
      expect(pick.status).toBe(0);
      expect(await readFile(join(picked.root, `src/${PATH}`), 'utf8')).toBe(
        'FIRST\nsecond\nthird\nfourth\nFIFTH\n'
      );
    } else {
      expect(pick.status).not.toBe(0);
    }
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

describe('a committed empty file as the common ancestor', () => {
  it('conflicts on a merge instead of merging against the pristine file', async () => {
    const value = await twoFillsOfAnEmptyOverride(
      'first\nsecond\nthird\n',
      'third\nfourth\nfifth\n'
    );
    const merge = git(value.root, 'merge', '--no-edit', 'agent-b');
    expect(merge.status).not.toBe(0);
    expect(merge.output).toContain('CONFLICT');
    const content = await readFile(join(value.root, `src/${PATH}`), 'utf8');
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('first');
    expect(content).toContain('fifth');
  }, 60_000);

  it('conflicts on a cherry-pick and a rebase too', async () => {
    const picked = await twoFillsOfAnEmptyOverride(
      'first\nsecond\nthird\n',
      'third\nfourth\nfifth\n'
    );
    expect(git(picked.root, 'cherry-pick', 'agent-b').status).not.toBe(0);
    expect(await readFile(join(picked.root, `src/${PATH}`), 'utf8')).toContain('<<<<<<<');
    const rebased = await twoFillsOfAnEmptyOverride(
      'first\nsecond\nthird\n',
      'third\nfourth\nfifth\n'
    );
    expect(git(rebased.root, 'rebase', 'agent-b').status).not.toBe(0);
    expect(await readFile(join(rebased.root, `src/${PATH}`), 'utf8')).toContain('<<<<<<<');
  }, 60_000);
});

describe('a driver Git runs without the ancestor label', () => {
  const ours = 'FIRST\nsecond\nthird\nfourth\nfifth\n';
  const theirs = 'first\nsecond\nthird\nfourth\nFIFTH\n';
  const merged = 'FIRST\nsecond\nthird\nfourth\nFIFTH\n';

  it("finds a merge's ancestor from the merged head", async () => {
    const value = await twoFirstTouches(ours, theirs, { driver: 'without-label' });
    const merge = git(value.root, 'merge', '--no-edit', 'agent-b');
    expect(merge.output).not.toContain('CONFLICT');
    expect(await readFile(join(value.root, `src/${PATH}`), 'utf8')).toBe(merged);
  }, 60_000);

  it("finds a rebase step's ancestor from the rebase state", async () => {
    const value = await twoFirstTouches(ours, theirs, { driver: 'without-label' });
    expect(git(value.root, 'rebase', 'agent-b').status).toBe(0);
    expect(await readFile(join(value.root, `src/${PATH}`), 'utf8')).toBe(merged);
  }, 60_000);

  it("finds a cherry-picked range's ancestor from the sequencer, and keeps the conflict for one commit", async () => {
    const range = await twoFirstTouches(ours, theirs, {
      driver: 'without-label',
      theirsAfterUnrelated: true,
    });
    expect(git(range.root, 'cherry-pick', 'agent-b~1', 'agent-b').status).toBe(0);
    expect(await readFile(join(range.root, `src/${PATH}`), 'utf8')).toBe(merged);
    // A single-commit cherry-pick leaves no state naming the commit while its merge runs.
    const single = await twoFirstTouches(ours, theirs, { driver: 'without-label' });
    expect(git(single.root, 'cherry-pick', 'agent-b').status).not.toBe(0);
    expect(await readFile(join(single.root, `src/${PATH}`), 'utf8')).toContain('<<<<<<<');
  }, 90_000);

  it('still conflicts over a committed empty override', async () => {
    const value = await twoFillsOfAnEmptyOverride(
      'first\nsecond\nthird\n',
      'third\nfourth\nfifth\n',
      { driver: 'without-label' }
    );
    expect(git(value.root, 'merge', '--no-edit', 'agent-b').status).not.toBe(0);
    expect(await readFile(join(value.root, `src/${PATH}`), 'utf8')).toContain('<<<<<<<');
  }, 60_000);
});
