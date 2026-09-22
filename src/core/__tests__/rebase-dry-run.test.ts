// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-git tests for the index-only rebase replay. Like the fuzz-apply
 * tests, these never mock `exec`: `git apply --cached` semantics are the
 * point.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import { parseApplyCheckFailures, replayQueueIndexOnly } from '../rebase-dry-run.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const lines = (...values: string[]): string => values.join('\n') + '\n';

/**
 * Builds a repo whose HEAD is the "new source", plus patches written
 * against an "old source" that differs from it in known ways.
 */
async function makeRebaseFixture(): Promise<{
  engine: string;
  patchesDir: string;
  patch: (name: string) => { filename: string; path: string };
}> {
  const engine = await mkdtemp(join(tmpdir(), 'fireforge-dry-run-engine-'));
  const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-dry-run-patches-'));
  cleanupPaths.push(engine, patchesDir);
  git(engine, 'init', '-q');
  git(engine, 'config', 'user.email', 'test@fireforge.invalid');
  git(engine, 'config', 'user.name', 'FireForge Test');

  const oldSource = {
    'a.txt': lines('a1', 'a2', 'a3', 'a-target', 'a4', 'a5', 'a6'),
    'b.txt': lines('b1', 'b2', 'b3', 'b-target', 'b4', 'b5', 'b6'),
    'c.txt': lines('c1', 'c2', 'c3', 'c-target', 'c4', 'c5', 'c6'),
  };
  for (const [file, content] of Object.entries(oldSource)) {
    await writeFile(join(engine, file), content);
  }
  git(engine, 'add', '-A');
  git(engine, 'commit', '-qm', 'old source');

  const capture = async (
    name: string,
    edit: () => Promise<void>,
    options: { cumulative?: boolean } = {}
  ): Promise<void> => {
    await edit();
    await writeFile(join(patchesDir, name), git(engine, 'diff'));
    if (options.cumulative === true) {
      git(engine, 'commit', '-qam', name);
    } else {
      git(engine, 'checkout', '-q', '--', '.');
    }
  };

  // 001: clean on the new source. Committed so 002 is written on top of it.
  await capture(
    '001-first.patch',
    () => writeFile(join(engine, 'a.txt'), oldSource['a.txt'].replace('a-target', 'a-first')),
    { cumulative: true }
  );
  // 002: only applies once 001 has: its context is 001's result.
  await capture('002-second.patch', () =>
    writeFile(join(engine, 'a.txt'), oldSource['a.txt'].replace('a-target', 'a-second'))
  );
  git(engine, 'reset', '-q', '--hard', 'HEAD~1');
  // 003: will need reduced context (outer context drifts upstream).
  await capture('003-drift.patch', () =>
    writeFile(join(engine, 'b.txt'), oldSource['b.txt'].replace('b-target', 'b-changed'))
  );
  // 004: conflicts (its target line changes upstream).
  await capture('004-conflict.patch', () =>
    writeFile(join(engine, 'c.txt'), oldSource['c.txt'].replace('c-target', 'c-mine'))
  );

  // The "new source": drift b's outer context, rewrite c's target.
  await writeFile(
    join(engine, 'b.txt'),
    lines('B1-drift', 'b2', 'b3', 'b-target', 'b4', 'b5', 'B6-drift')
  );
  await writeFile(join(engine, 'c.txt'), lines('c1', 'c2', 'c3', 'c-upstream', 'c4', 'c5', 'c6'));
  git(engine, 'commit', '-qam', 'new source');

  return {
    engine,
    patchesDir,
    patch: (name: string) => ({ filename: name, path: join(patchesDir, name) }),
  };
}

describe('replayQueueIndexOnly', () => {
  it('replays in queue order and gives one verdict per patch', async () => {
    const { engine, patch } = await makeRebaseFixture();

    const replay = await replayQueueIndexOnly(
      engine,
      [
        patch('001-first.patch'),
        patch('002-second.patch'),
        patch('003-drift.patch'),
        patch('004-conflict.patch'),
      ],
      3
    );

    expect(replay.verdicts.map((v) => [v.filename, v.outcome])).toEqual([
      ['001-first.patch', 'clean'],
      // Applies only on top of 001: proves the replay is cumulative.
      ['002-second.patch', 'clean'],
      ['003-drift.patch', 'reduced-context'],
      ['004-conflict.patch', 'reject'],
    ]);
    const drift = replay.verdicts[2];
    expect(drift?.outcome === 'reduced-context' && drift.contextArg).toMatch(/^-C[0-2]$/);
    const conflict = replay.verdicts[3];
    expect(conflict?.outcome === 'reject' && conflict.files).toEqual(['c.txt']);
    expect(replay.firstRejectIndex).toBe(3);
  });

  it('never writes the worktree or the real index', async () => {
    const { engine, patch } = await makeRebaseFixture();
    const indexBefore = await readFile(join(engine, '.git', 'index'));
    const statusBefore = git(engine, 'status', '--porcelain=v1');

    await replayQueueIndexOnly(
      engine,
      [patch('001-first.patch'), patch('003-drift.patch'), patch('004-conflict.patch')],
      3
    );

    expect(git(engine, 'status', '--porcelain=v1')).toBe(statusBefore);
    expect((await readFile(join(engine, '.git', 'index'))).equals(indexBefore)).toBe(true);
    expect(await readFile(join(engine, 'a.txt'), 'utf8')).toContain('a-target');
  });

  it('replays from HEAD, not from a dirty worktree', async () => {
    const { engine, patch } = await makeRebaseFixture();
    // A worktree edit that would make 001 fail if the replay read it.
    await writeFile(join(engine, 'a.txt'), lines('unrelated'));

    const replay = await replayQueueIndexOnly(engine, [patch('001-first.patch')], 3);

    expect(replay.verdicts[0]?.outcome).toBe('clean');
  });

  it('honours maxFuzz 0 as exact-only', async () => {
    const { engine, patch } = await makeRebaseFixture();

    const replay = await replayQueueIndexOnly(engine, [patch('003-drift.patch')], 0);

    expect(replay.verdicts[0]?.outcome).toBe('reject');
  });

  it('refuses an invalid maxFuzz', async () => {
    await expect(replayQueueIndexOnly('/nowhere', [], -1)).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
  });
});

describe('parseApplyCheckFailures', () => {
  it('names each file git reports once', () => {
    expect(
      parseApplyCheckFailures(
        [
          'error: patch failed: browser/x.js:12',
          'error: browser/x.js: patch does not apply',
          'error: toolkit/y.mjs: does not exist in index',
          'error: toolkit/z.css: already exists in index',
          'warning: something else',
        ].join('\n')
      )
    ).toEqual(['browser/x.js', 'toolkit/y.mjs', 'toolkit/z.css']);
  });
});
