// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it, vi } from 'vitest';

import { getNodeErrorCode, isProcessAlive, toError } from '../errors.js';

describe('toError', () => {
  it('returns Error instances unchanged', () => {
    const error = new Error('boom');

    expect(toError(error)).toBe(error);
  });

  it('wraps objects with a string message and preserves the original cause', () => {
    const original = { message: 'object failure', code: 'EFAIL' };
    const error = toError(original);

    expect(error.message).toBe('object failure');
    expect(error.cause).toBe(original);
  });

  it('wraps string throwables', () => {
    const error = toError('plain failure');

    expect(error.message).toBe('plain failure');
    expect(error.cause).toBe('plain failure');
  });

  it('stringifies non-string primitives', () => {
    const error = toError(404);

    expect(error.message).toBe('404');
    expect(error.cause).toBe(404);
  });
});

describe('getNodeErrorCode', () => {
  it('extracts a string code from an Error carrying one', () => {
    expect(getNodeErrorCode(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe('ENOENT');
  });

  it('extracts a string code from a plain object', () => {
    // The four copies in utils/fs.ts gated on `instanceof Error` and so
    // misclassified this shape — exactly what toError exists to normalise.
    expect(getNodeErrorCode({ code: 'EACCES' })).toBe('EACCES');
  });

  it('returns undefined for a non-string code, a codeless error, and non-objects', () => {
    expect(getNodeErrorCode({ code: 42 })).toBeUndefined();
    expect(getNodeErrorCode(new Error('plain'))).toBeUndefined();
    expect(getNodeErrorCode(null)).toBeUndefined();
    expect(getNodeErrorCode('ENOENT')).toBeUndefined();
    expect(getNodeErrorCode(undefined)).toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('treats ESRCH as dead', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    try {
      expect(isProcessAlive(12345)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats EPERM as ALIVE — the process exists under another uid', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats an unknown errno as alive, so callers refuse rather than destroy', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('something unexpected');
    });
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
