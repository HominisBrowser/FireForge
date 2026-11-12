// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  CancelledError,
  defined,
  errnoCode,
  ExitCode,
  FireForgeError,
  invariant,
  toError,
} from './errors.js';

describe('ExitCode', () => {
  it('keeps the published numbers', () => {
    expect(ExitCode).toEqual({
      SUCCESS: 0,
      GENERAL_ERROR: 1,
      CONFIG_ERROR: 2,
      DOWNLOAD_ERROR: 3,
      GIT_ERROR: 4,
      BUILD_ERROR: 5,
      PATCH_ERROR: 6,
      MISSING_DEPENDENCY: 7,
      INVALID_ARGUMENT: 8,
      FURNACE_ERROR: 9,
      RESOLUTION_ERROR: 10,
      INTERNAL_ERROR: 11,
      SMOKE_EXIT_FAILURE: 12,
      SMOKE_LAUNCH_FAILURE: 13,
      INCONCLUSIVE: 14,
      LOCK_TIMEOUT: 15,
      USER_CANCELLED: 130,
      TERMINATED: 143,
    });
  });
});

describe('FireForgeError', () => {
  it('defaults to a general failure and carries code, hint and cause', () => {
    const cause = new Error('disk');
    const error = new FireForgeError('engine-missing', 'No engine', { hint: 'Run setup', cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('engine-missing');
    expect(error.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(error.hint).toBe('Run setup');
    expect(error.cause).toBe(cause);
    expect(new FireForgeError('x', 'y').cause).toBeUndefined();
  });

  it('gives a cancellation its own class and exit code', () => {
    const error = new CancelledError();
    expect(error).toBeInstanceOf(FireForgeError);
    expect(error.exitCode).toBe(130);
    expect(error.code).toBe('cancelled');
  });
});

describe('toError', () => {
  it('passes an Error through and wraps anything else, keeping the original as cause', () => {
    const original = new TypeError('boom');
    expect(toError(original)).toBe(original);
    expect(toError('text').message).toBe('text');
    const plain = { message: 'from another realm', code: 'EIO' };
    expect(toError(plain).message).toBe('from another realm');
    expect(toError(plain).cause).toBe(plain);
    expect(toError(undefined).message).toBe('undefined');
  });
});

describe('errnoCode', () => {
  it('reads a string code structurally', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errnoCode({ code: 'EACCES' })).toBe('EACCES');
    expect(errnoCode({ code: 5 })).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });
});

describe('invariant', () => {
  it('throws an internal error, building a lazy message only on failure', () => {
    let built = 0;
    const message = (): string => {
      built += 1;
      return 'journal registered before the first write';
    };
    invariant(true, message);
    expect(built).toBe(0);
    expect(() => {
      invariant(false, message);
    }).toThrow(
      expect.objectContaining({ code: 'internal', exitCode: ExitCode.INTERNAL_ERROR }) as Error
    );
    expect(built).toBe(1);
  });

  it('returns a present value and refuses null or undefined', () => {
    expect(defined(0, 'present')).toBe(0);
    expect(() => defined(undefined, 'the row exists')).toThrow('the row exists');
    expect(() => defined(null, 'the row exists')).toThrow('the row exists');
  });
});
