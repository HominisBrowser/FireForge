// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Deterministic build identity: the real reader consults live git, whose
// clean/dirty state varies by checkout.
vi.mock('../utils/build-info.js', () => ({
  getCliVersion: vi.fn(() => '0.41.0+gtestsha12345.dirty'),
}));

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

  // `listeners()` is typed as `Function[]` in @types/node 22. The handler
  // installed by installBrokenPipeHandler has this exact signature.
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
    // A fast path that only fires when --version is the sole argument makes
    // `fireforge --verbose --version` fail with "unknown option '--version'"
    // even though help advertises the flag. Any -V/--version among root
    // flags and no subcommand prints the version. A subcommand's own
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

describe('buildGroupedHelpFormatter', () => {
  it('indents wrapped description continuations to the term column plus four', () => {
    // The wrap path is the only place the formatter deviates from
    // Commander's own layout: a description that overflows `helpWidth` is
    // split and every continuation line is aligned under the first
    // description word, at `termWidth + 4` columns. Asserting the exact
    // indent (rather than "it is a non-empty string") is what makes a
    // regression in `formatHelpLine` visible.
    const program = createProgram();
    const helper = program.createHelp();
    helper.helpWidth = 60;
    const expectedIndent = helper.padWidth(program, helper) + 4;

    const lines = helper.formatHelp(program, helper).split('\n');
    const continuations = lines.filter(
      (line) => /^ +\S/.test(line) && (line.match(/^ +/)?.[0].length ?? 0) === expectedIndent
    );

    expect(continuations.length).toBeGreaterThan(0);

    // The wrapping is width-driven: given room to spare the formatter emits
    // strictly fewer continuation lines for the same command set.
    const wide = program.createHelp();
    wide.helpWidth = 200;
    const wideContinuations = wide
      .formatHelp(program, wide)
      .split('\n')
      .filter(
        (line) =>
          /^ +\S/.test(line) &&
          (line.match(/^ +/)?.[0].length ?? 0) === wide.padWidth(program, wide) + 4
      );
    expect(wideContinuations.length).toBeLessThan(continuations.length);
  });
});
