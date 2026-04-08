// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProgram,
  installBrokenPipeHandler,
  main,
  resetBrokenPipeHandlerForTests,
} from '../cli.js';
import * as logger from '../utils/logger.js';

function getInstalledStdoutErrorHandler(
  stdoutListenersBefore: number
): (error: NodeJS.ErrnoException) => void {
  const installedListeners = process.stdout.listeners('error').slice(stdoutListenersBefore);
  const [handler] = installedListeners;
  if (typeof handler !== 'function') {
    throw new Error('Broken-pipe handler was not installed on stdout');
  }

  return handler as (error: NodeJS.ErrnoException) => void;
}

describe('installBrokenPipeHandler', () => {
  afterEach(() => {
    resetBrokenPipeHandlerForTests();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('reuses an existing process-scoped handler when listener state is already present', () => {
    const installedKey = Symbol.for('fireforge.cli.brokenPipeHandlerInstalled');
    const listenerKey = Symbol.for('fireforge.cli.brokenPipeHandlerListener');
    const existingHandler = vi.fn<(error: NodeJS.ErrnoException) => void>();
    const state = process as NodeJS.Process & {
      [installedKey]?: boolean | undefined;
      [listenerKey]?: ((error: NodeJS.ErrnoException) => void) | undefined;
    };

    state[listenerKey] = existingHandler;
    state[installedKey] = undefined;

    const stdoutListenersBefore = process.stdout.listeners('error').length;
    const stderrListenersBefore = process.stderr.listeners('error').length;

    installBrokenPipeHandler();

    expect(process.stdout.listeners('error')).toHaveLength(stdoutListenersBefore + 1);
    expect(process.stderr.listeners('error')).toHaveLength(stderrListenersBefore + 1);
    expect(process.stdout.listeners('error').at(-1)).toBe(existingHandler);
    expect(process.stderr.listeners('error').at(-1)).toBe(existingHandler);
  });

  it('is idempotent across repeated installation attempts', () => {
    const stdoutListenersBefore = process.stdout.listeners('error').length;
    const stderrListenersBefore = process.stderr.listeners('error').length;

    installBrokenPipeHandler();
    installBrokenPipeHandler();

    expect(process.stdout.listeners('error')).toHaveLength(stdoutListenersBefore + 1);
    expect(process.stderr.listeners('error')).toHaveLength(stderrListenersBefore + 1);
  });

  it('treats EPIPE as a clean CLI exit condition', () => {
    const stdoutListenersBefore = process.stdout.listeners('error').length;
    installBrokenPipeHandler();

    const handler = getInstalledStdoutErrorHandler(stdoutListenersBefore);

    process.exitCode = 7;
    handler(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));

    expect(process.exitCode).toBe(0);
  });

  it('rethrows non-EPIPE stream errors', () => {
    const stdoutListenersBefore = process.stdout.listeners('error').length;
    installBrokenPipeHandler();

    const handler = getInstalledStdoutErrorHandler(stdoutListenersBefore);

    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    expect(() => {
      handler(error);
    }).toThrow(error);
  });

  it('resets cleanly even when no handler was installed', () => {
    const stdoutListenersBefore = process.stdout.listeners('error').length;
    const stderrListenersBefore = process.stderr.listeners('error').length;

    resetBrokenPipeHandlerForTests();

    expect(process.stdout.listeners('error')).toHaveLength(stdoutListenersBefore);
    expect(process.stderr.listeners('error')).toHaveLength(stderrListenersBefore);
  });
});

describe('createProgram', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables verbose logging only when the preAction hook sees --verbose', () => {
    const setVerboseSpy = vi.spyOn(logger, 'setVerbose').mockImplementation(() => undefined);
    const program = createProgram() as Command & {
      _lifeCycleHooks: {
        preAction: Array<((command: { opts(): Record<string, unknown> }) => void) | undefined>;
      };
    };

    const [preActionHook] = program._lifeCycleHooks.preAction;
    if (typeof preActionHook !== 'function') {
      throw new Error('Expected Commander preAction hook to be installed');
    }

    preActionHook({ opts: () => ({ verbose: false }) });
    expect(setVerboseSpy).not.toHaveBeenCalled();

    preActionHook({ opts: () => ({ verbose: true }) });
    expect(setVerboseSpy).toHaveBeenCalledWith(true);
  });
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the current process arguments through the Commander program', async () => {
    const parseAsyncSpy = vi
      .spyOn(Command.prototype, 'parseAsync')
      .mockImplementation(function mockParseAsync(this: Command) {
        return Promise.resolve(this);
      });

    const previousArgv = process.argv;
    process.argv = ['node', 'fireforge', 'status'];

    try {
      await main();
    } finally {
      process.argv = previousArgv;
    }

    expect(parseAsyncSpy).toHaveBeenCalledWith(['node', 'fireforge', 'status']);
  });
});
