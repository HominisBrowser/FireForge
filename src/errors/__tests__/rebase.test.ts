// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import { NoRebaseSessionError, RebaseError, RebaseSessionExistsError } from '../rebase.js';

describe('RebaseError', () => {
  it('has PATCH_ERROR code', () => {
    const error = new RebaseError('something went wrong');

    expect(error.code).toBe(ExitCode.PATCH_ERROR);
  });

  it('prefixes userMessage with "Rebase Error:"', () => {
    const error = new RebaseError('something went wrong');

    expect(error.userMessage).toBe('Rebase Error: something went wrong');
  });

  it('preserves name and message', () => {
    const error = new RebaseError('oops');

    expect(error.name).toBe('RebaseError');
    expect(error.message).toBe('oops');
  });
});

describe('RebaseSessionExistsError', () => {
  it('has fixed message about existing session', () => {
    const error = new RebaseSessionExistsError();

    expect(error.message).toContain('rebase session is already in progress');
    expect(error.message).toContain('--continue');
    expect(error.message).toContain('--abort');
  });

  it('has PATCH_ERROR code and Rebase Error prefix', () => {
    const error = new RebaseSessionExistsError();

    expect(error.code).toBe(ExitCode.PATCH_ERROR);
    expect(error.userMessage).toMatch(/^Rebase Error:/);
  });
});

describe('NoRebaseSessionError', () => {
  it('has fixed message about no session', () => {
    const error = new NoRebaseSessionError();

    expect(error.message).toContain('No rebase session in progress');
  });

  it('has PATCH_ERROR code and Rebase Error prefix', () => {
    const error = new NoRebaseSessionError();

    expect(error.code).toBe(ExitCode.PATCH_ERROR);
    expect(error.userMessage).toMatch(/^Rebase Error:/);
  });
});
