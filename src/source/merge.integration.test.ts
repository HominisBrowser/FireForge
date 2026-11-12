// SPDX-License-Identifier: EUPL-1.2
/**
 * The merge driver under plain git merge, rebase and cherry-pick, as an
 * agent runs them, with the real CLI as the driver.
 */
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GIT_PASSES_ANCESTOR_LABEL } from '../testing/git.js';
import { REPO_ROOT } from '../testing/script.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { installMergeDriver, override } from './index.js';

const dir = useTempDir();
const PATH = 'browser/manifest.txt';
const OURS = 'FIRST\nsecond\nthird\nfourth\nfifth\n';
const THEIRS = 'first\nsecond\nthird\nfourth\nFIFTH\n';
const MERGED = 'FIRST\nsecond\nthird\nfourth\nFIFTH\n';

/** Plain git as an agent runs it. */
function git(cwd: string, ...args: string[]): { status: number; output: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { status: result.status ?? 255, output: `${result.stdout}${result.stderr}` };
}

/**
 * A project whose owned files merge through the CLI installed where a
 * project installs it (`node_modules/.bin/fireforge`), unless told
 * otherwise: `broken` installs one that fails without merging.
 */
let fixtures = 0;

async function driven(driver: 'installed' | 'broken' | 'none'): Promise<SourceFixture> {
  const home = join(dir(), `fixture-${++fixtures}`);
  const value = await createSourceFixture(home);
  const env = await value.hostEnv();
  if (driver === 'none') return value;
  const loader = pathToFileURL(resolve(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
  const bin = join(value.root, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  await appendFile(join(value.root, '.git', 'info', 'exclude'), 'node_modules/\n');
  await writeFile(
    join(bin, 'fireforge'),
    [
      '#!/bin/sh',
      ...(driver === 'broken'
        ? ['echo "fireforge: cannot start" >&2', 'exit 2']
        : [
            `FIREFORGE_HOME='${env['FIREFORGE_HOME'] ?? ''}'`,
            'export FIREFORGE_HOME',
            `exec '${process.execPath}' --import '${loader}' '${REPO_ROOT}/bin/fireforge.ts' "$@"`,
          ]),
      '',
    ].join('\n')
  );
  await chmod(join(bin, 'fireforge'), 0o755);
  await installMergeDriver(await value.load());
  return value;
}

/** Two branches each first-touching the same upstream file, from a commit that has neither. */
async function twoFirstTouches(
  value: SourceFixture,
  ours: string,
  theirs: string
): Promise<SourceFixture> {
  const project = await value.load();
  for (const [branch, content] of [
    ['agent-a', ours],
    ['agent-b', theirs],
  ] as const) {
    git(value.root, 'checkout', '-q', '-b', branch, 'main');
    await override(project, value.pristine, PATH, { component: 'fixture' });
    await value.write({ [`src/${PATH}`]: content });
    await value.commit(`touch on ${branch}`);
  }
  git(value.root, 'checkout', '-q', 'agent-a');
  return value;
}

/** An override that empties the file, committed, then two branches that each fill it. */
async function twoFillsOfAnEmptyOverride(value: SourceFixture): Promise<SourceFixture> {
  await override(await value.load(), value.pristine, PATH, { component: 'fixture' });
  await value.write({ [`src/${PATH}`]: '' });
  await value.commit('empty');
  for (const [branch, content] of [
    ['agent-a', 'first\nsecond\nthird\n'],
    ['agent-b', 'third\nfourth\nfifth\n'],
  ] as const) {
    git(value.root, 'checkout', '-q', '-b', branch, 'main');
    await value.write({ [`src/${PATH}`]: content });
    await value.commit(`fill on ${branch}`);
  }
  git(value.root, 'checkout', '-q', 'agent-a');
  return value;
}

const owned = (value: SourceFixture): Promise<string> =>
  readFile(join(value.root, 'src', PATH), 'utf8');

describe('first touches', () => {
  it.skipIf(!GIT_PASSES_ANCESTOR_LABEL)(
    'merge non-overlapping edits against the pristine ancestor',
    async () => {
      const value = await twoFirstTouches(await driven('installed'), OURS, THEIRS);
      const merge = git(value.root, 'merge', '--no-edit', 'agent-b');
      expect(merge.output).not.toContain('CONFLICT');
      expect(merge.status).toBe(0);
      expect(await owned(value)).toBe(MERGED);
    },
    60_000
  );

  it.skipIf(!GIT_PASSES_ANCESTOR_LABEL)(
    'rebase and cherry-pick through the same driver',
    async () => {
      const rebased = await twoFirstTouches(await driven('installed'), OURS, THEIRS);
      expect(git(rebased.root, 'rebase', 'agent-b').status).toBe(0);
      expect(await owned(rebased)).toBe(MERGED);
      const picked = await twoFirstTouches(await driven('installed'), OURS, THEIRS);
      expect(git(picked.root, 'cherry-pick', 'agent-b').status).toBe(0);
      expect(await owned(picked)).toBe(MERGED);
    },
    90_000
  );

  it('leave conflict markers for overlapping edits', async () => {
    const value = await twoFirstTouches(
      await driven('installed'),
      'OURS\nsecond\nthird\nfourth\nfifth\n',
      'THEIRS\nsecond\nthird\nfourth\nfifth\n'
    );
    expect(git(value.root, 'merge', '--no-edit', 'agent-b').status).not.toBe(0);
    const content = await owned(value);
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('OURS');
    expect(content).toContain('THEIRS');
    expect(content).toContain('second\nthird');
  }, 60_000);

  it('keep git add/add behaviour without the driver, or when git passes no ancestor label', async () => {
    const plain = await twoFirstTouches(await driven('none'), OURS, THEIRS);
    const merge = git(plain.root, 'merge', '--no-edit', 'agent-b');
    expect(merge.status).not.toBe(0);
    expect(merge.output).toContain('add/add');
    // What a git before 2.44 runs: the configured command line with no label to expand.
    const unlabelled = await twoFirstTouches(await driven('installed'), OURS, THEIRS);
    const line = git(unlabelled.root, 'config', '--get', 'merge.fireforge.driver').output.trim();
    git(unlabelled.root, 'config', 'merge.fireforge.driver', line.replace(/ %S$/, ''));
    expect(git(unlabelled.root, 'merge', '--no-edit', 'agent-b').status).not.toBe(0);
    expect(await owned(unlabelled)).toContain('<<<<<<<');
  }, 90_000);

  it('end as a conflict holding both sides when FireForge fails', async () => {
    const value = await twoFirstTouches(await driven('broken'), OURS, THEIRS);
    expect(git(value.root, 'merge', '--no-edit', 'agent-b').status).not.toBe(0);
    const content = await owned(value);
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('FIRST');
    expect(content).toContain('FIFTH');
  }, 60_000);

  it.skipIf(!GIT_PASSES_ANCESTOR_LABEL)(
    'use one configuration for every linked worktree',
    async () => {
      const value = await twoFirstTouches(await driven('installed'), OURS, THEIRS);
      const linked = join(dir(), 'linked');
      git(value.root, 'checkout', '-q', '--detach');
      git(value.root, 'worktree', 'add', '-q', linked, 'agent-a');
      expect(git(linked, 'merge', '--no-edit', 'agent-b').status).toBe(0);
      expect(await readFile(join(linked, 'src', PATH), 'utf8')).toBe(MERGED);
    },
    60_000
  );
});

describe('a committed empty file as the common ancestor', () => {
  it('conflicts on a merge, a cherry-pick and a rebase instead of merging against pristine', async () => {
    for (const operation of [
      ['merge', '--no-edit', 'agent-b'],
      ['cherry-pick', 'agent-b'],
      ['rebase', 'agent-b'],
    ]) {
      const value = await twoFillsOfAnEmptyOverride(await driven('installed'));
      expect(git(value.root, ...operation).status, operation[0]).not.toBe(0);
      const content = await owned(value);
      expect(content, operation[0]).toContain('<<<<<<<');
      expect(content).toContain('first');
      expect(content).toContain('fifth');
    }
  }, 120_000);
});
