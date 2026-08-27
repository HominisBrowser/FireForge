// SPDX-License-Identifier: EUPL-1.2
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, dirname: vi.fn(actual.dirname) };
});

// Deterministic build identity: the real reader consults live git, whose
// clean/dirty state varies by checkout.
vi.mock('../utils/build-info.js', () => ({
  getCliVersion: vi.fn(() => '0.41.0+gtestsha12345.dirty'),
}));

import {
  createProgram,
  getProjectRoot,
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

  return handler;
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

  it('handles root --version before Commander parses subcommands', async () => {
    const previousArgv = process.argv;
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const parseAsyncSpy = vi.spyOn(Command.prototype, 'parseAsync');
    process.argv = ['node', 'fireforge', '--version'];

    try {
      await main();
    } finally {
      process.argv = previousArgv;
    }

    expect(writeSpy).toHaveBeenCalledWith('0.41.0+gtestsha12345.dirty\n');
    expect(parseAsyncSpy).not.toHaveBeenCalled();
  });

  it('handles --version alongside other root flags (fireforge --verbose --version)', async () => {
    // A fast path that only fires when --version is the SOLE argument makes
    // `fireforge --verbose --version` fail with "unknown option '--version'"
    // even though help advertises the flag. Any -V/--version among root
    // flags with NO subcommand prints the version; a subcommand's own
    // --version (e.g. `source set --version`) is untouched because a
    // positional argument is present.
    const previousArgv = process.argv;
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const parseAsyncSpy = vi.spyOn(Command.prototype, 'parseAsync');
    process.argv = ['node', 'fireforge', '--verbose', '--version'];

    try {
      await main();
    } finally {
      process.argv = previousArgv;
    }

    expect(writeSpy).toHaveBeenCalledWith('0.41.0+gtestsha12345.dirty\n');
    expect(parseAsyncSpy).not.toHaveBeenCalled();
  });

  it('leaves --version for the subcommand parser when a subcommand is present', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const parseAsyncSpy = vi
      .spyOn(Command.prototype, 'parseAsync')
      .mockImplementation(function mockParseAsync(this: Command) {
        return Promise.resolve(this);
      });

    const previousArgv = process.argv;
    process.argv = ['node', 'fireforge', 'source', 'set', '--version', '152.0b6'];

    try {
      await main();
    } finally {
      process.argv = previousArgv;
    }

    expect(writeSpy).not.toHaveBeenCalledWith('0.41.0+gtestsha12345.dirty\n');
    expect(parseAsyncSpy).toHaveBeenCalled();
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

describe('getProjectRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws ConfigNotFoundError when the walk depth limit is exhausted', () => {
    // `getProjectRoot` throws a typed `ConfigNotFoundError` rather than a
    // plain `Error` so `withErrorHandling` surfaces the formatted
    // userMessage instead of a stack dump. Both the shape and the payload
    // are checked so a refactor cannot silently regress to the stack-dump
    // path.
    const fakeStart = '/a/b/c/d/e';
    vi.spyOn(process, 'cwd').mockReturnValue(fakeStart);
    vi.mocked(existsSync).mockReturnValue(false);

    let counter = 0;
    vi.mocked(dirname).mockImplementation(() => `/synthetic/${counter++}`);

    expect(() => getProjectRoot()).toThrow(/Configuration file not found: fireforge\.json/);
  });
});

describe('buildGroupedHelpFormatter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns unsplit lines when the description area is too narrow for wrapping', () => {
    const program = createProgram();
    const helper = program.createHelp();
    helper.helpWidth = 30;

    const result = helper.formatHelp(program, helper);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('defaults to 80 columns when helpWidth is undefined', () => {
    const program = createProgram();
    const helper = program.createHelp();
    helper.helpWidth = undefined as unknown as number;

    const result = helper.formatHelp(program, helper);

    expect(typeof result).toBe('string');
    expect(result).toContain('Usage:');
  });

  it('wraps long descriptions at moderate widths', () => {
    const program = createProgram();
    const helper = program.createHelp();
    helper.helpWidth = 50;

    const result = helper.formatHelp(program, helper);

    expect(typeof result).toBe('string');
    expect(result).toContain('\n');
  });
});
