// SPDX-License-Identifier: EUPL-1.2
/**
 * The engine-state contract, against real git repositories: one working-tree
 * walk per hold, kept until this process writes, with a token that still sees
 * every edit. `git` is wrapped only to count; every call runs for real.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ args: [] as string[][] }));

vi.mock('../git-base.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-base.js')>();
  return {
    ...actual,
    git: (args: string[], cwd: string, options?: never) => {
      calls.args.push(args);
      return actual.git(args, cwd, options);
    },
  };
});
vi.mock('../../utils/logger.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createLoggerMock()
);

import { InconclusiveVerdictError } from '../../errors/base.js';
import { warn } from '../../utils/logger.js';
import { readEngineContentState } from '../coverage-records.js';
import { collectChangedEnginePaths } from '../engine-changes.js';
import { describeEngineGenerationDelta, generationDeltaPaths } from '../engine-session-lock.js';
import { isUnavailableGenerationToken } from '../engine-session-lock.js';
import {
  captureEngineGeneration,
  invalidateEngineState,
  isEngineContentJudged,
  judgeEngineGeneration,
  markEngineContentJudged,
  readCommittedChanges,
  readEngineInventory,
  refreshEngineGeneration,
  withEngineStateHold,
} from '../engine-state.js';

const walks = (): number => calls.args.filter((args) => args[0] === 'status').length;
const allWalks = (): number =>
  calls.args.filter((args) => ['status', 'ls-files'].includes(args[0] ?? '') || isDiffOfHead(args))
    .length;
const isDiffOfHead = (args: string[]): boolean => args[0] === 'diff' && args.includes('HEAD');

let engine: string;
const run = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: engine,
    encoding: 'utf8',
  });

beforeEach(async () => {
  engine = await mkdtemp(join(tmpdir(), 'fireforge-engine-state-'));
  run('init', '-q');
  await writeFile(join(engine, 'tracked.js'), 'one\n');
  await writeFile(join(engine, 'other.js'), 'one\n');
  run('add', '.');
  run('commit', '-qm', 'base');
  calls.args = [];
  vi.mocked(warn).mockClear();
});

afterEach(async () => {
  await rm(engine, { recursive: true, force: true });
});

describe('one inventory per hold', () => {
  it('walks once for the census, the content state and the token', async () => {
    await writeFile(join(engine, 'tracked.js'), 'two\n');
    await writeFile(join(engine, 'untracked.js'), 'new\n');
    await withEngineStateHold(async () => {
      const head = run('rev-parse', 'HEAD').trim();
      const baseline = { engineHeadSha: head, builtAt: 'now', binaryName: 'browser' };
      const [one, two] = await Promise.all([
        collectChangedEnginePaths(engine, baseline, 'package'),
        collectChangedEnginePaths(engine, { ...baseline, engineHeadSha: '' }, 'components'),
      ]);
      expect(one).toEqual(['tracked.js', 'untracked.js']);
      expect(two).toEqual(one);
      const state = await readEngineContentState(engine);
      expect([...state.dirty].sort()).toEqual(['tracked.js', 'untracked.js']);
      await captureEngineGeneration(engine);
    });
    expect(allWalks()).toBe(1);
  });

  it('measures afresh outside a hold, so a stale answer cannot leak', async () => {
    expect((await readEngineInventory(engine)).paths).toEqual([]);
    await writeFile(join(engine, 'tracked.js'), 'two\n');
    expect((await readEngineInventory(engine)).paths).toEqual(['tracked.js']);
    expect(walks()).toBe(2);
  });

  it('sees this process writing only through an invalidation', async () => {
    await withEngineStateHold(async () => {
      expect((await readEngineInventory(engine)).paths).toEqual([]);
      await writeFile(join(engine, 'tracked.js'), 'two\n');
      invalidateEngineState(engine);
      expect((await readEngineInventory(engine)).paths).toEqual(['tracked.js']);
    });
    expect(walks()).toBe(2);
  });

  it('does not remember a failed walk', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'fireforge-not-git-'));
    await withEngineStateHold(async () => {
      await expect(readEngineInventory(elsewhere)).rejects.toThrow();
      await expect(readEngineInventory(elsewhere)).rejects.toThrow();
    });
    expect(walks()).toBe(2);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('keeps commit diffs to the commits, with no walk', async () => {
    const before = run('rev-parse', 'HEAD').trim();
    await writeFile(join(engine, 'other.js'), 'two\n');
    run('commit', '-qam', 'next');
    expect(await readCommittedChanges(engine, before)).toEqual(['other.js']);
    expect(walks()).toBe(0);
  });

  it('forgets what a hold judged when this process writes, not when a harness ran', async () => {
    await withEngineStateHold(async () => {
      expect(isEngineContentJudged(engine)).toBe(false);
      markEngineContentJudged(engine);
      await refreshEngineGeneration(engine);
      expect(isEngineContentJudged(engine)).toBe(true);
      invalidateEngineState(engine);
      expect(isEngineContentJudged(engine)).toBe(false);
    });
  });
});

describe('the generation token', () => {
  it('chains: an "after" serves as the next "before" without another walk', async () => {
    await withEngineStateHold(async () => {
      const before = await captureEngineGeneration(engine);
      expect(walks()).toBe(1);
      const after = await refreshEngineGeneration(engine);
      expect(walks()).toBe(2);
      expect(after).toBe(before);
      expect(await captureEngineGeneration(engine)).toBe(after);
      expect((await readEngineInventory(engine)).paths).toEqual([]);
      expect(walks()).toBe(2);
    });
  });

  it('never lets a kept token hide an edit: the next "after" finds it', async () => {
    await withEngineStateHold(async () => {
      const before = await captureEngineGeneration(engine);
      await writeFile(join(engine, 'tracked.js'), 'peer\n');
      const after = await refreshEngineGeneration(engine);
      expect(after).not.toBe(before);
      await expect(judgeEngineGeneration(before, after)).rejects.toBeInstanceOf(
        InconclusiveVerdictError
      );
    });
  });

  it('sees a second edit to an already dirty file, which status alone cannot', async () => {
    await writeFile(join(engine, 'tracked.js'), 'two\n');
    await withEngineStateHold(async () => {
      const before = await captureEngineGeneration(engine);
      await writeFile(join(engine, 'tracked.js'), 'three\n');
      const after = await refreshEngineGeneration(engine);
      expect(generationDeltaPaths(before, after).paths).toEqual(['tracked.js']);
    });
  });

  it('is read by the delta helpers, including symlinks, deletions and renames', async () => {
    await symlink('tracked.js', join(engine, 'link.js'));
    await rm(join(engine, 'other.js'));
    const before = await captureEngineGeneration(engine);
    await writeFile(join(engine, 'late.js'), 'x\n');
    const after = await captureEngineGeneration(engine);
    const delta = describeEngineGenerationDelta(before, after).join('\n');
    expect(delta).toContain('?? late.js');
    expect(generationDeltaPaths(before, after)).toEqual({
      headMoved: false,
      paths: ['late.js'],
    });
  });

  it('names a moved HEAD', async () => {
    const before = await captureEngineGeneration(engine);
    await writeFile(join(engine, 'other.js'), 'two\n');
    run('commit', '-qam', 'next');
    const after = await captureEngineGeneration(engine);
    expect(generationDeltaPaths(before, after).headMoved).toBe(true);
  });

  it('keeps guarding the whole engine when an untracked nested repository is dirty', async () => {
    const nested = join(engine, 'third_party', 'foo');
    await mkdir(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested });
    await writeFile(join(nested, 'f.txt'), 'nested\n');
    execFileSync('git', ['add', '.'], { cwd: nested });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'n'], {
      cwd: nested,
    });
    const before = await captureEngineGeneration(engine);
    expect(isUnavailableGenerationToken(before)).toBe(false);
    await writeFile(join(engine, 'tracked.js'), 'edited mid-run\n');
    invalidateEngineState(engine);
    const after = await captureEngineGeneration(engine);
    await expect(judgeEngineGeneration(before, after)).rejects.toBeInstanceOf(
      InconclusiveVerdictError
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('holds a socket as an identity instead of failing the whole measurement', async () => {
    await rm(join(engine, 'tracked.js'));
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(join(engine, 'tracked.js'), resolve);
    });
    try {
      expect(isUnavailableGenerationToken(await captureEngineGeneration(engine))).toBe(false);
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  });

  it('reports a failed probe as unavailable, without rejecting', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'fireforge-not-git-'));
    const token = await captureEngineGeneration(elsewhere);
    expect(isUnavailableGenerationToken(token)).toBe(true);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('warns only for a tree it cannot measure at all, and refuses any other failed probe', async () => {
    await judgeEngineGeneration(
      'unavailable:fatal: not a git repository (or any of the parent directories): .git',
      'unavailable:fatal: not a git repository (or any of the parent directories): .git'
    );
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(
      judgeEngineGeneration('unavailable:EMFILE: too many open files', 'unavailable:EACCES')
    ).rejects.toBeInstanceOf(InconclusiveVerdictError);
    await expect(judgeEngineGeneration('unavailable:a', 'head\0')).rejects.toBeInstanceOf(
      InconclusiveVerdictError
    );
    await expect(judgeEngineGeneration('head\0', 'unavailable:b')).rejects.toBeInstanceOf(
      InconclusiveVerdictError
    );
  });

  it('keeps a verdict only when the caller proves the delta unreachable', async () => {
    const tolerate = vi.fn(() => Promise.resolve(true));
    await judgeEngineGeneration('a\0', 'b\0', tolerate);
    expect(tolerate).toHaveBeenCalledWith('a\0', 'b\0');
    await expect(judgeEngineGeneration('a\0', 'b\0', () => Promise.resolve(false))).rejects.toThrow(
      'HEAD moved: a -> b'
    );
  });
});
