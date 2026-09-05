// SPDX-License-Identifier: EUPL-1.2
/**
 * Registration-layer tests for `fireforge test`.
 *
 * `createProgram()` in the help/CLI suites registers the command, which
 * marks the option-builder lines executed, but never invokes an argParser
 * callback or the action body. Both numeric flags reject out-of-range input
 * through `commanderArgParser`, whose whole purpose (see `utils/options.ts`)
 * is making those failures surface through commander's invalid-argument
 * channel instead of escaping `withErrorHandling` as an unformatted crash,
 * so the rejection arms are the behaviour worth pinning.
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../test.js', () => ({ testCommand: vi.fn() }));
vi.mock('../../core/engine-session-lock.js', () => ({
  withEngineSessionLock: vi.fn((_root: string, _name: string, operation: () => Promise<unknown>) =>
    operation()
  ),
}));

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import { GeneralError, LockContentionError } from '../../errors/base.js';
import { testCommand } from '../test.js';
import { registerTest } from '../test-register.js';
import { emitFailVerdict, resetVerdictEmission } from '../test-verdict.js';

const PROJECT_ROOT = '/project';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerTest(program, {
    getProjectRoot: () => PROJECT_ROOT,
    withErrorHandling: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
  });
  return program;
}

async function parse(...args: string[]): Promise<void> {
  await makeProgram().parseAsync(['node', 'fireforge', 'test', ...args]);
}

describe('registerTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs testCommand inside the engine session lock', async () => {
    await parse('browser/base/content/test/browser_a.js');

    expect(withEngineSessionLock).toHaveBeenCalledWith(PROJECT_ROOT, 'test', expect.any(Function), {
      waitLockSeconds: undefined,
    });
    expect(testCommand).toHaveBeenCalledWith(
      PROJECT_ROOT,
      ['browser/base/content/test/browser_a.js'],
      expect.any(Object)
    );
  });

  it('resolves --wait-lock into a wait budget for the lock', async () => {
    await parse('--wait-lock', '120');
    expect(withEngineSessionLock).toHaveBeenCalledWith(PROJECT_ROOT, 'test', expect.any(Function), {
      waitLockSeconds: 120,
    });
  });

  it('omits undefined options so exactOptionalPropertyTypes consumers stay clean', async () => {
    await parse();
    const options = vi.mocked(testCommand).mock.calls[0]?.[2] as Record<string, unknown>;
    for (const [key, value] of Object.entries(options)) {
      expect(value, `option "${key}" should not be undefined`).not.toBeUndefined();
    }
  });

  describe('--mach-arg accumulator', () => {
    it('collects repeated occurrences in order', async () => {
      await parse('--mach-arg', '--flavor=xpcshell', '--mach-arg', '--verbose');
      expect(vi.mocked(testCommand).mock.calls[0]?.[2]).toMatchObject({
        machArg: ['--flavor=xpcshell', '--verbose'],
      });
    });

    it('does not leak accumulated values between program instances', async () => {
      // The `[] as string[]` default is a single shared array literal per
      // registration. A fresh program must start empty.
      await parse('--mach-arg', '--first');
      await parse('--mach-arg', '--second');
      expect(vi.mocked(testCommand).mock.calls[1]?.[2]).toMatchObject({
        machArg: ['--second'],
      });
    });
  });

  describe('--harness-retries', () => {
    it.each(['0', '5', '10'])('accepts %s', async (value) => {
      await parse('--harness-retries', value);
      expect(vi.mocked(testCommand).mock.calls[0]?.[2]).toMatchObject({
        harnessRetries: Number(value),
      });
    });

    it.each([
      ['non-numeric', 'abc'],
      ['below the lower bound', '-1'],
      ['above the upper bound', '11'],
    ])('rejects %s input', async (_label, value) => {
      await expect(parse('--harness-retries', value)).rejects.toThrow(
        /--harness-retries must be an integer in 0\.\.10/
      );
      expect(testCommand).not.toHaveBeenCalled();
    });

    it('surfaces the rejection through commander, not as a raw crash', async () => {
      // commanderArgParser rewraps into commander.invalidArgument so the
      // failure does not bypass withErrorHandling.
      await expect(parse('--harness-retries', '99')).rejects.toMatchObject({
        code: 'commander.invalidArgument',
      });
    });
  });

  describe('--marionette-port', () => {
    it.each(['1', '2828', '65535'])('accepts %s', async (value) => {
      await parse('--marionette-port', value);
      expect(vi.mocked(testCommand).mock.calls[0]?.[2]).toMatchObject({
        marionettePort: Number(value),
      });
    });

    it.each([
      ['non-numeric', 'notaport'],
      ['below the lower bound', '0'],
      ['above the upper bound', '65536'],
    ])('rejects %s input', async (_label, value) => {
      await expect(parse('--marionette-port', value)).rejects.toThrow(
        /--marionette-port must be an integer in 1\.\.65535/
      );
      expect(testCommand).not.toHaveBeenCalled();
    });
  });

  it('forwards boolean flags through to testCommand', async () => {
    await parse('--headless', '--build', '--generic-mach-test');
    expect(vi.mocked(testCommand).mock.calls[0]?.[2]).toMatchObject({
      headless: true,
      build: true,
      genericMachTest: true,
    });
  });

  describe('verdict emission when the engine lock fails', () => {
    // The lock is acquired outside testCommand's exactly-one-verdict
    // guarantee, so the registration layer must emit for lock failures or
    // verdict-keyed callers see nothing at all.
    let stdoutLines: string[];
    let restoreStdout: () => void;

    beforeEach(() => {
      stdoutLines = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutLines.push(String(chunk));
        return true;
      });
      restoreStdout = () => {
        spy.mockRestore();
      };
    });

    afterEach(() => {
      restoreStdout();
      resetVerdictEmission();
    });

    function verdictLines(): string[] {
      return stdoutLines.filter((line) => line.startsWith('FIREFORGE-VERDICT:'));
    }

    it('emits exactly one FAIL reason=lock-timeout line when the lock stays contended', async () => {
      vi.mocked(withEngineSessionLock).mockRejectedValueOnce(
        new LockContentionError('Another engine-mutating FireForge command is running.')
      );
      await expect(parse('--wait-lock', '300')).rejects.toThrow(LockContentionError);
      expect(verdictLines()).toEqual(['FIREFORGE-VERDICT: FAIL reason=lock-timeout\n']);
      expect(testCommand).not.toHaveBeenCalled();
    });

    it('emits FAIL reason=preflight for non-contention failures escaping the lock wrapper', async () => {
      vi.mocked(withEngineSessionLock).mockRejectedValueOnce(new GeneralError('boom'));
      await expect(parse()).rejects.toThrow('boom');
      expect(verdictLines()).toEqual(['FIREFORGE-VERDICT: FAIL reason=preflight\n']);
    });

    it('does not double-emit when testCommand already produced its verdict', async () => {
      vi.mocked(withEngineSessionLock).mockImplementationOnce(
        async (_root: string, _name: string, operation: () => Promise<unknown>) => {
          await operation();
          throw new GeneralError('post-verdict failure');
        }
      );
      vi.mocked(testCommand).mockImplementationOnce(() => {
        emitFailVerdict('test-failures');
        return Promise.resolve();
      });
      await expect(parse()).rejects.toThrow('post-verdict failure');
      expect(verdictLines()).toEqual(['FIREFORGE-VERDICT: FAIL reason=test-failures\n']);
    });
  });
});
