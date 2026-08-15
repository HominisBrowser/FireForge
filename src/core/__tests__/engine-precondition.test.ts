// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared engine precondition ladder.
 *
 * Five commands carried their own copy, and `resolve.ts` and
 * `token-coverage.ts` were truncated: two rungs, no unborn-HEAD guard. Both
 * then enumerated working-tree status against an unborn HEAD, where the whole
 * ~300k-file Firefox tree reads as untracked.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGit, writeFiles } from '../../test-utils/index.js';
import { assertEngineGitReady } from '../engine-precondition.js';

describe('assertEngineGitReady', () => {
  let root: string;
  let engineDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-engine-precond-'));
    engineDir = join(root, 'engine');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses when the engine directory does not exist', async () => {
    await expect(assertEngineGitReady(engineDir)).rejects.toThrow(
      /Firefox source not found\. Run "fireforge download" first/
    );
  });

  it('refuses when the engine is not a git repository', async () => {
    await writeFiles(engineDir, { 'README.txt': 'not a repo\n' });
    await expect(assertEngineGitReady(engineDir)).rejects.toThrow(
      /not a git repository\. Run "fireforge download" to initialize/
    );
  });

  it('refuses an unborn HEAD — the rung two commands were missing', async () => {
    // `git init` with no commit: the repo exists but has no baseline, so the
    // entire tree reads as untracked to any status walk downstream.
    await writeFiles(engineDir, { 'browser/base/content/app.js': 'content\n' });
    await runGit(engineDir, ['init']);

    await expect(assertEngineGitReady(engineDir)).rejects.toThrow(
      /no baseline commit yet.*download --force/s
    );
  });

  it('appends the caller-supplied remediation tail', async () => {
    await writeFiles(engineDir, { 'a.txt': 'x\n' });
    await runGit(engineDir, ['init']);

    await expect(
      assertEngineGitReady(engineDir, { unbornHeadSuffix: ', then retry the rebase.' })
    ).rejects.toThrow(/cleanly, then retry the rebase\.$/);
  });

  it('ends in a single full stop when no suffix is supplied', async () => {
    // The base message used to carry its own trailing period, so the rebase
    // caller's `', then retry…'` suffix rendered as "cleanly., then retry".
    // Moving the period to the default means neither form doubles it.
    await writeFiles(engineDir, { 'a.txt': 'x\n' });
    await runGit(engineDir, ['init']);

    await expect(assertEngineGitReady(engineDir)).rejects.toThrow(/cleanly\.$/);
    await expect(assertEngineGitReady(engineDir)).rejects.not.toThrow(/cleanly\.\./);
  });

  it('resolves for a repository with a baseline commit', async () => {
    await writeFiles(engineDir, { 'a.txt': 'x\n' });
    await runGit(engineDir, ['init']);
    await runGit(engineDir, ['config', 'user.email', 't@e.st']);
    await runGit(engineDir, ['config', 'user.name', 'T']);
    await runGit(engineDir, ['add', '-A']);
    await runGit(engineDir, ['commit', '-m', 'baseline']);

    await expect(assertEngineGitReady(engineDir)).resolves.toBeUndefined();
  });
});
