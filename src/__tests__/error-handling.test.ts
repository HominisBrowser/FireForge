// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../test-utils/module-mocks.js';

vi.mock('../utils/logger.js', () => createLoggerMock());

import { withErrorHandling } from '../cli.js';
import {
  CancellationError,
  CommandError,
  GeneralError,
  InconclusiveVerdictError,
  InternalInvariantError,
  LockContentionError,
} from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import { ConfigNotFoundError } from '../errors/config.js';
import { cancel, error as logError, isStdoutSealed, isVerbose } from '../utils/logger.js';

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

  it('prints the stack for an InternalInvariantError and exits INTERNAL_ERROR', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = withErrorHandling(() =>
      Promise.reject(new InternalInvariantError('furnace lock held before the body runs'))
    );

    try {
      await handler();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).exitCode).toBe(ExitCode.INTERNAL_ERROR);
    }

    // The userMessage explains it is a bug; the stack is what makes the
    // report actionable, and it must go to stderr so a --json payload on
    // stdout stays parseable.
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('furnace lock held before the body runs')
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('InternalInvariantError: furnace lock held before the body runs')
    );
    expect(cancel).not.toHaveBeenCalled();

    consoleError.mockRestore();
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

  it.each([
    // Red, never-ran and thrown-away are three different facts. Two of them
    // shared exit 1 before 0.44.0, which invited scripts to treat a discarded
    // verdict as a failing suite.
    [new InconclusiveVerdictError('engine/ changed'), ExitCode.INCONCLUSIVE],
    [new LockContentionError('another command holds the lock'), ExitCode.LOCK_TIMEOUT],
  ])('gives %s its own exit code rather than a general failure', async (thrown, expected) => {
    const handler = withErrorHandling(() => Promise.reject(thrown));

    try {
      await handler();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CommandError).exitCode).toBe(expected);
    }
  });

  it('passes an already-rendered CommandError through without logging it again', async () => {
    const sentinel = new CommandError(ExitCode.INVALID_ARGUMENT);
    const handler = withErrorHandling(() => Promise.reject(sentinel));

    await expect(handler()).rejects.toBe(sentinel);
    expect(logError).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
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

  describe('cause chain', () => {
    it('prints the chain under --verbose so a wrapped error surfaces its origin', async () => {
      // Nine error classes declare a `cause` and 22 throw sites pass one;
      // without the boundary reading it back, the underlying git stderr or
      // errno never reaches the operator and each command has to hand-roll
      // the rendering to make its own --verbose promise true.
      vi.mocked(isVerbose).mockReturnValue(true);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const root = new Error('ENOSPC: no space left on device');

      await expect(
        withErrorHandling(() =>
          Promise.reject(new GeneralError('Could not write the patch manifest', root))
        )()
      ).rejects.toBeInstanceOf(CommandError);

      const printed = consoleError.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Caused by: Error: ENOSPC: no space left on device');
      consoleError.mockRestore();
      vi.mocked(isVerbose).mockReturnValue(false);
    });

    it('stays silent about the cause without --verbose', async () => {
      vi.mocked(isVerbose).mockReturnValue(false);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        withErrorHandling(() =>
          Promise.reject(new GeneralError('Could not write', new Error('ENOSPC')))
        )()
      ).rejects.toBeInstanceOf(CommandError);

      const printed = consoleError.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('Caused by:');
      consoleError.mockRestore();
    });
  });

  describe('--json error envelope', () => {
    const originalArgv = process.argv;

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('emits a parseable refusal on stdout when the run asked for --json', async () => {
      // Engaging machine mode inside each command body leaves anything that
      // throws on the way in — most visibly getProjectRoot's
      // ConfigNotFoundError — rendering a clack block to STDOUT, so a --json
      // consumer gets un-parseable output plus exit 2.
      process.argv = ['node', 'fireforge', 'status', '--json'];
      vi.mocked(isStdoutSealed).mockReturnValue(false);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      await expect(
        withErrorHandling(() => Promise.reject(new ConfigNotFoundError('/p/fireforge.json')))()
      ).rejects.toBeInstanceOf(CommandError);

      const written = stdout.mock.calls.map((c) => String(c[0])).join('');
      const payload = JSON.parse(written.trim()) as { code: string; schemaVersion: number };
      expect(payload.schemaVersion).toBe(1);
      // The tag is derived from the class name, so a new error class gets a
      // sensible code without a hand-maintained map.
      expect(payload.code).toBe('config-not-found');
      stdout.mockRestore();
    });

    it('does not append an envelope when a payload already owns stdout', async () => {
      // `status --json --fail-on` writes its full document and THEN refuses.
      // A second JSON document would break the "exactly one" contract.
      process.argv = ['node', 'fireforge', 'status', '--json', '--fail-on', 'unmanaged'];
      vi.mocked(isStdoutSealed).mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      await expect(
        withErrorHandling(() => Promise.reject(new GeneralError('check failed')))()
      ).rejects.toBeInstanceOf(CommandError);

      expect(stdout).not.toHaveBeenCalled();
      stdout.mockRestore();
      vi.mocked(isStdoutSealed).mockReturnValue(false);
    });

    it('leaves stdout alone when the run did not ask for machine output', async () => {
      process.argv = ['node', 'fireforge', 'status'];
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      await expect(
        withErrorHandling(() => Promise.reject(new GeneralError('boom')))()
      ).rejects.toBeInstanceOf(CommandError);

      expect(stdout).not.toHaveBeenCalled();
      stdout.mockRestore();
    });
  });
});
