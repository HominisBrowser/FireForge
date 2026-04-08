// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import {
  DirtyRepositoryError,
  GitError,
  GitIndexLockError,
  GitNotFoundError,
  PatchApplyError,
} from '../git.js';

describe('git errors', () => {
  it('formats GitError with command and recovery steps', () => {
    const error = new GitError('checkout failed', 'checkout main');

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.command).toBe('checkout main');
    expect(error.userMessage).toContain('Git Error: checkout failed');
    expect(error.userMessage).toContain('Command: git checkout main');
    expect(error.userMessage).toContain('Ensure git is installed');
  });

  it('formats GitError without command', () => {
    const error = new GitError('unknown failure');

    expect(error.userMessage).toContain('Git Error: unknown failure');
    expect(error.userMessage).not.toContain('Command:');
  });

  it('preserves cause', () => {
    const cause = new Error('underlying');
    const error = new GitError('failed', 'status', cause);

    expect(error.cause).toBe(cause);
  });

  it('formats GitNotFoundError', () => {
    const error = new GitNotFoundError();

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.userMessage).toContain('Git is not installed');
    expect(error.userMessage).toContain('https://git-scm.com/');
  });

  it('formats PatchApplyError with patch path', () => {
    const error = new PatchApplyError('/patches/001-fix.patch');

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.patchPath).toBe('/patches/001-fix.patch');
    expect(error.command).toBe('apply');
    expect(error.userMessage).toContain('Patch: /patches/001-fix.patch');
    expect(error.userMessage).toContain('patch conflicts');
  });

  it('formats DirtyRepositoryError', () => {
    const error = new DirtyRepositoryError();

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.userMessage).toContain('uncommitted changes');
    expect(error.userMessage).toContain('fireforge export');
  });

  it('formats GitIndexLockError with age', () => {
    const error = new GitIndexLockError('/engine/.git/index.lock', 180_000);

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.lockPath).toBe('/engine/.git/index.lock');
    expect(error.ageMs).toBe(180_000);
    expect(error.userMessage).toContain('3 minute(s)');
    expect(error.userMessage).toContain('index.lock');
  });

  it('formats GitIndexLockError without age', () => {
    const error = new GitIndexLockError('/engine/.git/index.lock');

    expect(error.ageMs).toBeUndefined();
    expect(error.userMessage).not.toContain('minute(s)');
  });
});
