// SPDX-License-Identifier: EUPL-1.2
/**
 * Commander usage errors must honour the exit-code contract: exit 8
 * (INVALID_ARGUMENT), not commander's own exit 1, and a `--json` refusal
 * envelope on stdout — while `--help` and `--version` keep exiting 0.
 */
import { CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/build-info.js', () => ({
  getCliVersion: vi.fn(() => '0.0.0-test'),
}));

import { createProgram } from '../cli.js';
import { handleParseError } from '../cli-usage-error.js';
import { CommandError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';

function isCommandErrorWith(code: ExitCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof CommandError && error.exitCode === code;
}

describe('handleParseError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a usage error to INVALID_ARGUMENT', () => {
    const error = new CommanderError(1, 'commander.unknownOption', "error: unknown option '--x'");
    expect(() => {
      handleParseError(error, false);
    }).toThrow(CommandError);
    expect(() => {
      handleParseError(error, false);
    }).toSatisfy((thrower: () => void) => {
      try {
        thrower();
      } catch (thrown: unknown) {
        return isCommandErrorWith(ExitCode.INVALID_ARGUMENT)(thrown);
      }
      return false;
    });
  });

  it('writes the refusal envelope to stdout under machine output', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = new CommanderError(1, 'commander.unknownOption', "error: unknown option '--x'");

    expect(() => {
      handleParseError(error, true);
    }).toThrow(CommandError);

    const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(JSON.parse(stdoutText)).toEqual({
      schemaVersion: 1,
      error: "unknown option '--x'",
      code: 'invalid-argument',
    });
  });

  it('treats help and version (exit 0) as success', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(() => {
      handleParseError(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'), true);
    }).not.toThrow();
    expect(() => {
      handleParseError(new CommanderError(0, 'commander.version', '1.0.0'), false);
    }).not.toThrow();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('treats a command group invoked without a subcommand as informational (exit 0)', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    // commander raises `commander.help` with exit 1 for a group lacking an
    // action; the contract is the same exit 0 that `patch`/`token` give.
    expect(() => {
      handleParseError(new CommanderError(1, 'commander.help', '(outputHelp)'), true);
    }).not.toThrow();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('rethrows anything that is not a CommanderError', () => {
    const other = new CommandError(ExitCode.CONFIG_ERROR);
    expect(() => {
      handleParseError(other, false);
    }).toThrow(other);
  });
});

describe('createProgram exit override', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates exitOverride to subcommands so usage errors throw instead of exiting', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = createProgram();

    await expect(program.parseAsync(['node', 'fireforge', 'status', '--bogus'])).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CommanderError && error.code === 'commander.unknownOption'
    );
    await expect(program.parseAsync(['node', 'fireforge', 'nope'])).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CommanderError && error.code === 'commander.unknownCommand'
    );
  });

  it('prints group help to stdout and resolves for tree and source without a subcommand', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const group of ['tree', 'source']) {
      stdoutWrite.mockClear();
      const program = createProgram();
      await expect(program.parseAsync(['node', 'fireforge', group])).resolves.toBeDefined();
      expect(stdoutWrite.mock.calls.map((call) => String(call[0])).join('')).toContain('Usage:');
    }
  });

  it('routes subcommand --help through the override with exit 0', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const program = createProgram();

    await expect(program.parseAsync(['node', 'fireforge', 'status', '--help'])).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CommanderError &&
        error.code === 'commander.helpDisplayed' &&
        error.exitCode === 0
    );
  });
});
