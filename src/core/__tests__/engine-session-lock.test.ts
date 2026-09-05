// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FireForgeError, LockContentionError } from '../../errors/base.js';

vi.mock('../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger.js')>()),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { InconclusiveVerdictError } from '../../errors/base.js';
import { ExitCode } from '../../errors/codes.js';
import { info, warn } from '../../utils/logger.js';
import {
  assertEngineGenerationUnchanged,
  isIndexLockError,
  isUnavailableGenerationToken,
  snapshotEngineGeneration,
  unavailableGenerationReason,
  withEngineSessionLock,
} from '../engine-session-lock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path}`);
      }
      await sleep(10);
    }
  }
}

describe('withEngineSessionLock', () => {
  let projectRoot: string;
  let previousEnable: string | undefined;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-engine-session-lock-'));
    previousEnable = process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'];
    process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] = '1';
  });

  afterEach(async () => {
    if (previousEnable === undefined) {
      delete process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'];
    } else {
      process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] = previousEnable;
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('refuses a second engine-mutating session while one is active', async () => {
    const release = deferred();
    const first = withEngineSessionLock(projectRoot, 'test', () => release.promise);
    await waitForPath(join(projectRoot, '.fireforge', 'engine-session.lock', 'pid'));

    await expect(
      withEngineSessionLock(projectRoot, 'build', () => Promise.resolve(undefined))
    ).rejects.toThrow(/engine-mutating command is already running/);

    release.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  it('waits under --wait-lock and proceeds once the holder releases', async () => {
    const release = deferred();
    const first = withEngineSessionLock(projectRoot, 'build', () => release.promise);
    await waitForPath(join(projectRoot, '.fireforge', 'engine-session.lock', 'pid'));

    const waiter = withEngineSessionLock(projectRoot, 'test', () => Promise.resolve('ran'), {
      waitLockSeconds: 10,
    });
    // Release while the waiter is polling (well under the 10 s budget).
    setTimeout(() => {
      release.resolve();
    }, 250);

    await expect(waiter).resolves.toBe('ran');
    await expect(first).resolves.toBeUndefined();
  });

  it(
    'prints periodic waiting lines naming the holder PID and command',
    { timeout: 15_000 },
    async () => {
      const release = deferred();
      const first = withEngineSessionLock(projectRoot, 'build', () => release.promise);
      await waitForPath(join(projectRoot, '.fireforge', 'engine-session.lock', 'pid'));

      const waiter = withEngineSessionLock(projectRoot, 'test', () => Promise.resolve('ran'), {
        waitLockSeconds: 12,
      });
      // Hold past the ~5 s progress interval so at least one line prints.
      setTimeout(() => {
        release.resolve();
      }, 5_600);

      await expect(waiter).resolves.toBe('ran');
      await first;

      const lines = vi.mocked(info).mock.calls.map(([message]) => message);
      const waitLinePattern = new RegExp(
        `^Waiting for the FireForge engine lock held by PID ${String(process.pid)} ` +
          `\\(command=build, started=\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z\\) — \\d+s of up to 12s\\.` +
          // The line also states this waiter's queue position.
          ` You are next in a queue of 1\\.$`
      );
      expect(lines.some((line) => waitLinePattern.test(line))).toBe(true);
    }
  );

  it('fails with the reason-first, remedy-second refusal once the --wait-lock budget expires', async () => {
    const release = deferred();
    const first = withEngineSessionLock(projectRoot, 'build', () => release.promise);
    await waitForPath(join(projectRoot, '.fireforge', 'engine-session.lock', 'pid'));

    const contended = withEngineSessionLock(projectRoot, 'test', () => Promise.resolve(undefined), {
      waitLockSeconds: 1,
    });
    const rejection = await contended.then(
      () => undefined,
      (error: unknown) => error
    );

    release.resolve();
    await expect(first).resolves.toBeUndefined();

    // Typed as a FireForgeError so the CLI boundary prints ONE line, no
    // stack.
    expect(rejection).toBeInstanceOf(LockContentionError);
    expect(rejection).toBeInstanceOf(FireForgeError);
    const message = (rejection as Error).message;
    // Reason first (the historical contract sentence), remedy second
    // naming --wait-lock, then the holder identified from lock metadata.
    expect(message).toContain(
      'Another FireForge engine-mutating command is already running. ' +
        'Wait for it to finish, then retry `test`'
    );
    expect(message).toContain('--wait-lock');
    expect(message).toContain(`The lock is held by PID ${String(process.pid)}`);
    expect(message).toContain('command=build');
  });
});

describe('engine generation guard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ff-engine-gen-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('warns instead of silently passing when the probe cannot measure the engine', async () => {
    // `dir` is not a git checkout, so both probes fail with the same
    // message. Comparing failure tokens for equality makes them compare
    // equal, take the `after === before` early return, and bless a verdict
    // the guard never verified, with no output at all. engine/ legitimately
    // may not be a git checkout (download extracts a tarball), so this must
    // not throw, and it must not be silent either.
    const before = await snapshotEngineGeneration(dir);
    expect(before).toMatch(/^unavailable:/);

    await expect(assertEngineGenerationUnchanged(dir, before)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not verify that engine/ stayed unchanged')
    );
  });

  it('does not report an unmeasurable engine as a detected change', async () => {
    // Two differing failure messages must not fall through to the mutation
    // branch and report a spurious "engine/ changed".
    const before = `unavailable:some earlier failure`;
    await expect(assertEngineGenerationUnchanged(dir, before)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('engine/ changed while'));
  });

  it('returns silently when a real checkout is genuinely unchanged', async () => {
    const { runGit } = await import('../../test-utils/index.js');
    await runGit(dir, ['init']);
    await runGit(dir, ['config', 'user.email', 't@e.st']);
    await runGit(dir, ['config', 'user.name', 'T']);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.txt'), 'x');
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-m', 'init']);

    const before = await snapshotEngineGeneration(dir);
    expect(before).not.toMatch(/^unavailable:/);
    await expect(assertEngineGenerationUnchanged(dir, before)).resolves.toBeUndefined();

    // A real mutation is still detected as a change, and the refusal names
    // it. Reconstructing the writer by hand (`find -newermt` against the
    // run window, minus the objdir, minus git's own bookkeeping) is the
    // cost this diagnostic exists to remove.
    await writeFile(join(dir, 'b.txt'), 'y');
    let refusal: unknown;
    try {
      await assertEngineGenerationUnchanged(dir, before);
      expect.unreachable('should have refused');
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(InconclusiveVerdictError);
    const inconclusive = refusal as InconclusiveVerdictError;
    expect(inconclusive.message).toMatch(/engine\/ changed while/);
    expect(inconclusive.message).toContain('What moved:');
    expect(inconclusive.message).toContain('b.txt');
    expect(inconclusive.code).toBe(ExitCode.INCONCLUSIVE);
  });

  it('throws when a measurable engine becomes unmeasurable mid-run', async () => {
    // The tolerance covers a probe that fails both times, the steady state of
    // a non-git engine/. An available -> unavailable transition is a different
    // thing: the second probe measured nothing about a checkout that
    // demonstrably had something to measure, so the verdict is unverifiable.
    const { runGit } = await import('../../test-utils/index.js');
    await runGit(dir, ['init']);
    await runGit(dir, ['config', 'user.email', 't@e.st']);
    await runGit(dir, ['config', 'user.name', 'T']);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.txt'), 'x');
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-m', 'init']);

    const before = await snapshotEngineGeneration(dir);
    expect(before).not.toMatch(/^unavailable:/);

    await rm(join(dir, '.git'), { recursive: true, force: true });

    await expect(assertEngineGenerationUnchanged(dir, before)).rejects.toThrow(
      /could not be probed afterwards/
    );
  });

  it('throws when there was no baseline probe to compare against', async () => {
    // unavailable -> available: the `before` probe captured nothing, so there
    // is literally nothing the `after` token can be compared with.
    const { runGit } = await import('../../test-utils/index.js');
    await runGit(dir, ['init']);
    await runGit(dir, ['config', 'user.email', 't@e.st']);
    await runGit(dir, ['config', 'user.name', 'T']);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.txt'), 'x');
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-m', 'init']);

    await expect(
      assertEngineGenerationUnchanged(dir, 'unavailable:no baseline was captured')
    ).rejects.toThrow(/no baseline to compare against/);
  });
});

describe('transient index-lock probe failures', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ff-engine-lockprobe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('classifies index-lock contention as transient and everything else as durable', () => {
    expect(
      isIndexLockError(new Error("Unable to create '/x/engine/.git/index.lock': File exists."))
    ).toBe(true);
    expect(isIndexLockError(new Error('not a git repository'))).toBe(false);
    expect(isIndexLockError(new Error('fatal: bad object HEAD'))).toBe(false);
  });
});

describe('generation token helpers', () => {
  it('classifies failure tokens and extracts their reason', () => {
    expect(isUnavailableGenerationToken('unavailable:not a git repository')).toBe(true);
    expect(unavailableGenerationReason('unavailable:not a git repository')).toBe(
      'not a git repository'
    );
  });

  it('does not classify a real generation token as unavailable', () => {
    expect(isUnavailableGenerationToken('abc123\0 M capture.txt')).toBe(false);
  });
});
