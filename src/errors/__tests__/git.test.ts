// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import { GitError, GitIndexLockError, GitNotFoundError, PatchApplyError } from '../git.js';

describe('git errors', () => {
  it('formats GitError with command and recovery steps', () => {
    const error = new GitError('checkout failed', 'checkout main');

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.userMessage).toContain('Git Error: checkout failed');
    expect(error.userMessage).toContain('Command: git checkout main');
    expect(error.userMessage).toContain('Ensure git is installed');
  });

  it('formats GitError without command', () => {
    const error = new GitError('unknown failure');

    expect(error.userMessage).toContain('Git Error: unknown failure');
    expect(error.userMessage).not.toContain('Command:');
  });

  // The single home for the base-class `cause` pass-through (FurnaceError /
  // PatchError / RebaseError all inherit the same constructor). The
  // end-to-end rendering of a cause lives in
  // `src/__tests__/error-handling.test.ts`.
  it('preserves cause', () => {
    const cause = new Error('underlying');
    const error = new GitError('failed', 'status', cause);

    expect(error.cause).toBe(cause);
  });

  it('formats GitNotFoundError', () => {
    const error = new GitNotFoundError();

    expect(error.code).toBe(ExitCode.MISSING_DEPENDENCY);
    expect(error.userMessage).toContain('Git is not installed');
    expect(error.userMessage).toContain('https://git-scm.com/');
  });

  it('formats PatchApplyError with patch path', () => {
    const error = new PatchApplyError('/patches/001-fix.patch');

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.userMessage).toContain('Patch: /patches/001-fix.patch');
    expect(error.userMessage).toContain('patch conflicts');
  });

  it('formats GitIndexLockError with age', () => {
    const error = new GitIndexLockError('/engine/.git/index.lock', 180_000);

    expect(error.code).toBe(ExitCode.GIT_ERROR);
    expect(error.userMessage).toContain('3 minute(s)');
    expect(error.userMessage).toContain('index.lock');
  });

  it('formats GitIndexLockError without age', () => {
    const error = new GitIndexLockError('/engine/.git/index.lock');

    expect(error.userMessage).not.toContain('minute(s)');
  });
});
