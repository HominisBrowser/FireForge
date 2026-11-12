// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { hostPaths } from '../project/index.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { readHostConfig, withBuildSlot, withDisplay } from './hostLocks.js';

const dir = useTempDir();
const host = (): ReturnType<typeof hostPaths> => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

/** Runs `second` while `first` is being held, and reports how `second` ended. */
async function overlap(
  hold: (body: () => Promise<unknown>) => Promise<unknown>,
  second: () => Promise<unknown>
): Promise<unknown> {
  let outcome: unknown;
  await hold(async () => {
    outcome = await second().then(
      () => 'ran',
      (error: unknown) => error
    );
  });
  return outcome;
}

describe('the host configuration', () => {
  it('defaults to one build slot and no secrets directory', async () => {
    expect(await readHostConfig(host())).toEqual({ buildSlots: 1 });
  });

  it('reads host.json and refuses one that does not match its schema', async () => {
    await writeTree(join(dir(), 'home'), {
      'host.json': JSON.stringify({ buildSlots: 3, releaseSecrets: '/secrets' }),
    });
    expect(await readHostConfig(host())).toEqual({ buildSlots: 3, releaseSecrets: '/secrets' });
    await writeTree(join(dir(), 'home'), { 'host.json': JSON.stringify({ buildSlots: 0 }) });
    await expect(readHostConfig(host())).rejects.toMatchObject({
      code: 'host-config-invalid',
      exitCode: ExitCode.CONFIG_ERROR,
    });
    await writeTree(join(dir(), 'home'), {
      'host.json': JSON.stringify({ releaseSecrets: 'relative/dir' }),
    });
    await expect(readHostConfig(host())).rejects.toMatchObject({ code: 'host-config-invalid' });
  });
});

describe('the build slots', () => {
  it('let one compile run at a time by default and name the lock when the wait expires', async () => {
    const outcome = await overlap(
      (body) => withBuildSlot(host(), 0, body),
      () => withBuildSlot(host(), 0, () => Promise.resolve())
    );
    expect(outcome).toMatchObject({
      code: 'lock-timeout',
      exitCode: ExitCode.LOCK_TIMEOUT,
      message: expect.stringContaining('the build lock') as string,
    });
  });

  it('let as many run as host.json allows', async () => {
    await writeTree(join(dir(), 'home'), { 'host.json': JSON.stringify({ buildSlots: 2 }) });
    const second = (): Promise<unknown> => withBuildSlot(host(), 0, () => Promise.resolve());
    expect(await overlap((body) => withBuildSlot(host(), 0, body), second)).toBe('ran');
    const third = await overlap(
      (body) => withBuildSlot(host(), 0, () => withBuildSlot(host(), 0, body)),
      second
    );
    expect(third).toMatchObject({ code: 'lock-timeout' });
  });
});

describe('the display', () => {
  it('belongs to one command at a time, and is free again afterwards', async () => {
    const second = (): Promise<unknown> => withDisplay(host(), 0, () => Promise.resolve());
    expect(await overlap((body) => withDisplay(host(), 0, body), second)).toMatchObject({
      code: 'lock-timeout',
      message: expect.stringContaining('the display lock') as string,
    });
    expect(await second().then(() => 'ran')).toBe('ran');
  });
});
