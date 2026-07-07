// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withEngineSessionLock } from '../engine-session-lock.js';

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
});
