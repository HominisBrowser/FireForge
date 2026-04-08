// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  error: vi.fn(),
  cancel: vi.fn(),
  setVerbose: vi.fn(),
}));

import { withErrorHandling } from '../cli.js';
import { CancellationError, CommandError, GeneralError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import { cancel, error as logError } from '../utils/logger.js';

describe('withErrorHandling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes CancellationError to cancel(), not logError()', async () => {
    const handler = withErrorHandling(() => Promise.reject(new CancellationError()));

    await expect(handler()).rejects.toThrow(CommandError);

    expect(cancel).toHaveBeenCalledWith('Operation cancelled');
    expect(logError).not.toHaveBeenCalled();
  });

  it('routes FireForgeError to logError(), not cancel()', async () => {
    const handler = withErrorHandling(() =>
      Promise.reject(new GeneralError('something went wrong'))
    );

    await expect(handler()).rejects.toThrow(CommandError);

    expect(logError).toHaveBeenCalledWith('something went wrong');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('throws CommandError with the correct exit code', async () => {
    const handler = withErrorHandling(() => Promise.reject(new GeneralError('fail')));

    try {
      await handler();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).exitCode).toBe(ExitCode.GENERAL_ERROR);
    }
  });

  it('does not call process.exit()', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const handler = withErrorHandling(() => Promise.reject(new GeneralError('fail')));

    try {
      await handler();
    } catch {
      /* expected */
    }

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('logs unexpected errors with their stack traces when available', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');
    error.stack = 'mock stack trace';

    const handler = withErrorHandling(() => Promise.reject(error));

    await expect(handler()).rejects.toThrow(CommandError);

    expect(logError).toHaveBeenCalledWith('Unexpected error: boom');
    expect(consoleErrorSpy).toHaveBeenCalledWith('mock stack trace');
  });

  it('skips stack logging when an unexpected error has no stack', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');
    error.stack = '';

    const handler = withErrorHandling(() => Promise.reject(error));

    await expect(handler()).rejects.toThrow(CommandError);

    expect(logError).toHaveBeenCalledWith('Unexpected error: boom');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
