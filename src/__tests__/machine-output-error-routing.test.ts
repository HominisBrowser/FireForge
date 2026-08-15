// SPDX-License-Identifier: EUPL-1.2
/**
 * Machine-output stream routing through error propagation (FORGE I1).
 *
 * `status --json --fail-on` (and every other machine-mode command) promises
 * that stdout belongs exclusively to the machine payload and diagnostics
 * route to stderr. Pre-0.41.0 the command's `finally` restored machine mode
 * WHILE the refusal was still propagating, so by the time `withErrorHandling`
 * logged it, clack's styled error landed on stdout after the JSON. These
 * tests use the real logger and the real `withErrorHandling` — the defect is
 * invisible to suites that mock either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withErrorHandling } from '../cli.js';
import { emitFailVerdict, resetVerdictEmission } from '../commands/test-verdict.js';
import { treeListCommand } from '../commands/tree.js';
import { listTrees } from '../core/tree-store.js';
import { CancellationError, CommandError, GeneralError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import {
  info,
  isMachineOutputMode,
  setMachineOutputMode,
  setStdoutSealed,
} from '../utils/logger.js';

vi.mock('../core/tree-store.js', () => ({
  listTrees: vi.fn(() => Promise.resolve([])),
}));

describe('machine-output error routing (FORGE I1)', () => {
  afterEach(() => {
    setMachineOutputMode(false);
    setStdoutSealed(false);
    vi.restoreAllMocks();
  });

  it('routes an error thrown while machine mode is engaged to stderr, not stdout', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const handler = withErrorHandling(async () => {
      setMachineOutputMode(true);
      await Promise.resolve();
      throw new GeneralError('status --check failed: 1 unmanaged');
    });

    await expect(handler()).rejects.toSatisfy(
      (error: unknown) => error instanceof CommandError && error.exitCode === ExitCode.GENERAL_ERROR
    );

    const stderrText = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).toContain('error: status --check failed: 1 unmanaged');
    const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(stdoutText).not.toContain('status --check failed');
    expect(stdoutText).toBe('');
  });

  it('resets machine mode centrally after the error is routed (no leak across invocations)', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const handler = withErrorHandling(async () => {
      setMachineOutputMode(true);
      await Promise.resolve();
      throw new GeneralError('boom');
    });

    await expect(handler()).rejects.toBeInstanceOf(CommandError);
    expect(isMachineOutputMode()).toBe(false);
  });

  describe('verdict-line stdout seal (FORGE I12)', () => {
    it('an error thrown after the verdict line routes to stderr; the verdict stays the last stdout write', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const handler = withErrorHandling(async () => {
        resetVerdictEmission();
        await Promise.resolve();
        emitFailVerdict('preflight');
        throw new GeneralError('Firefox source not found');
      });

      await expect(handler()).rejects.toBeInstanceOf(CommandError);

      const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join('');
      expect(stdoutText).toBe('FIREFORGE-VERDICT: FAIL reason=preflight\n');
      const stderrText = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText).toContain('error: Firefox source not found');
    });

    it('a CancellationError after the verdict routes cancel() to stderr', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const handler = withErrorHandling(async () => {
        resetVerdictEmission();
        await Promise.resolve();
        emitFailVerdict('preflight');
        throw new CancellationError();
      });

      await expect(handler()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof CommandError && error.exitCode === ExitCode.USER_CANCELLED
      );

      const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join('');
      expect(stdoutText).toBe('FIREFORGE-VERDICT: FAIL reason=preflight\n');
      const stderrText = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText).toContain('cancelled: Operation cancelled');
    });

    it('withErrorHandling clears the seal centrally, so the next invocation logs to stdout again', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const sealing = withErrorHandling(async () => {
        resetVerdictEmission();
        await Promise.resolve();
        emitFailVerdict('preflight');
        throw new GeneralError('boom');
      });
      await expect(sealing()).rejects.toBeInstanceOf(CommandError);

      const next = withErrorHandling(async () => {
        await Promise.resolve();
        info('back on stdout');
      });
      await next();

      const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join('');
      expect(stdoutText).toContain('back on stdout');
    });
  });

  it('tree list --json keeps stdout exclusive to JSON when listing fails', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(listTrees).mockRejectedValue(new GeneralError('lock file unreadable'));

    const handler = withErrorHandling(async () => {
      await treeListCommand('/p', { json: true });
    });

    await expect(handler()).rejects.toBeInstanceOf(CommandError);

    const stderrText = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrText).toContain('error: lock file unreadable');
    const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(stdoutText).toBe('');
  });
});
