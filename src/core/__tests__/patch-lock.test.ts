// SPDX-License-Identifier: EUPL-1.2
/**
 * Behavioural tests for the patch directory lock's `--wait-lock` plumbing:
 * the wait budget overrides the default timeout, the timeout message leads
 * with the wait remedy instead of `rm -rf`, and the default (no options)
 * path stays untouched for existing callers.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger.js')>()),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { info } from '../../utils/logger.js';
import { withPatchDirectoryLock } from '../patch-lock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('withPatchDirectoryLock', () => {
  let patchesDir: string;

  beforeEach(async () => {
    patchesDir = await mkdtemp(join(tmpdir(), 'ff-patch-lock-'));
  });

  afterEach(async () => {
    await rm(patchesDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('runs the operation and returns its value with no options (default path)', async () => {
    await expect(withPatchDirectoryLock(patchesDir, () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('re-throws non-EEXIST errors from mkdir', async () => {
    // A path beneath a REGULAR FILE: mkdir cannot create the parent, so the
    // helper must surface the error rather than treating it as a held lock.
    const regularFile = join(patchesDir, 'not-a-directory');
    await writeFile(regularFile, 'x');

    await expect(
      withPatchDirectoryLock(join(regularFile, 'fireforge-lock-test'), () =>
        Promise.resolve('nope')
      )
    ).rejects.toThrow();
  });

  it('times out a contended lock within the waitLockSeconds budget and names --wait-lock', async () => {
    const holdersInside = deferred();
    const releaseHolder = deferred();
    const holder = withPatchDirectoryLock(patchesDir, async () => {
      holdersInside.resolve();
      await releaseHolder.promise;
    });
    await holdersInside.promise;

    const started = Date.now();
    await expect(
      withPatchDirectoryLock(patchesDir, () => Promise.resolve(), {
        waitLockSeconds: 1,
        command: 'patch delete',
      })
    ).rejects.toThrow(/--wait-lock/);
    // 1 s budget, not the 30 s default.
    expect(Date.now() - started).toBeLessThan(10_000);

    releaseHolder.resolve();
    await holder;
  });

  it('records the command in the lock owner metadata surfaced to waiters', async () => {
    const holdersInside = deferred();
    const releaseHolder = deferred();
    const holder = withPatchDirectoryLock(
      patchesDir,
      async () => {
        holdersInside.resolve();
        await releaseHolder.promise;
      },
      { command: 're-export' }
    );
    await holdersInside.promise;

    await expect(
      withPatchDirectoryLock(patchesDir, () => Promise.resolve(), { waitLockSeconds: 1 })
    ).rejects.toThrow(/command=re-export/);

    releaseHolder.resolve();
    await holder;
  });

  it('emits a progress line while waiting when a wait budget is set', async () => {
    const holdersInside = deferred();
    const releaseHolder = deferred();
    const holder = withPatchDirectoryLock(patchesDir, async () => {
      holdersInside.resolve();
      await releaseHolder.promise;
    });
    await holdersInside.promise;

    const waiter = withPatchDirectoryLock(patchesDir, () => Promise.resolve('done'), {
      waitLockSeconds: 30,
    });
    // Release after the first progress interval (~5 s is the production
    // cadence; poll for the call instead of sleeping a fixed 5 s).
    const deadline = Date.now() + 8_000;
    while (
      !vi
        .mocked(info)
        .mock.calls.some(([line]) =>
          line.includes('Waiting for the FireForge patch directory lock')
        )
    ) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    releaseHolder.resolve();
    await holder;
    await expect(waiter).resolves.toBe('done');

    expect(
      vi
        .mocked(info)
        .mock.calls.some(([line]) =>
          line.includes('Waiting for the FireForge patch directory lock')
        )
    ).toBe(true);
  }, 15_000);
});
