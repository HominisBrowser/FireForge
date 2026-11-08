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

import { info } from '../../utils/logger.js';
import {
  isIndexLockError,
  isUnavailableGenerationToken,
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
          // The line also states this waiter's queue position and the rule
          // that makes the position a promise.
          ` You are next in a queue of 1 \\(granted in arrival order\\)\\.$`
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
