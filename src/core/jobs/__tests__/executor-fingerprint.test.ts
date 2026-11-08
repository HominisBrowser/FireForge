// SPDX-License-Identifier: EUPL-1.2
import type { Stats } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  skipped: [] as boolean[],
  symlink: false,
  lockError: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((path: string, ...rest: unknown[]) => {
      if (fixture.lockError !== undefined && path.endsWith('package-lock.json'))
        return Promise.reject(
          Object.assign(new Error(fixture.lockError), { code: fixture.lockError })
        );
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }),
  };
});
vi.mock('../tool-files.js', () => ({
  fileDigest: () => Promise.resolve('digest'),
  walkTree: async (
    _directory: string,
    visit: (entry: { path: string; label: string; info: Stats }) => Promise<void>,
    options: { skip: (name: string) => boolean }
  ) => {
    fixture.skipped.push(
      ...['node_modules', '.git', 'docs', 'a.test.ts', 'kept.ts'].map((name) => options.skip(name))
    );
    const info = { isSymbolicLink: () => fixture.symlink, isFile: () => true } as Stats;
    await visit({ path: '/x/kept.ts', label: 'src/kept.ts', info });
  },
}));
vi.mock('../dependency-identity.js', () => ({
  dependencyGraphIdentity: () => Promise.resolve('graph'),
}));
vi.mock('../source-loader.js', () => ({ sourceLoaderIdentity: () => Promise.resolve('loader') }));

const { executorFingerprint } = await import('../executor-fingerprint.js');

describe('executorFingerprint', () => {
  afterEach(() => {
    fixture.skipped = [];
    fixture.symlink = false;
    fixture.lockError = undefined;
  });

  it('leaves out dependencies, Git and tests, keeping tests only in shipped asset trees', async () => {
    await executorFingerprint();
    // src and bin skip tests; templates and runtime keep everything but node_modules and .git.
    expect(fixture.skipped).toEqual([
      ...[true, true, true, true, false],
      ...[true, true, true, true, false],
      ...[true, true, false, false, false],
      ...[true, true, false, false, false],
    ]);
  });

  it('refuses a symbolic link among its own assets', async () => {
    fixture.symlink = true;
    await expect(executorFingerprint()).rejects.toThrow(/alias requires authentication/);
  });

  it('binds a package that ships no lockfile, and refuses an unreadable one', async () => {
    const withLock = await executorFingerprint();
    fixture.lockError = 'ENOENT';
    const lockless = await executorFingerprint();
    expect(lockless).toMatch(/^[0-9a-f]{64}$/);
    expect(lockless).not.toBe(withLock);
    fixture.lockError = 'EACCES';
    await expect(executorFingerprint()).rejects.toThrow(/EACCES/);
  });
});
