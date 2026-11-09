// SPDX-License-Identifier: EUPL-1.2
/** `host upgrade` and the pinned build `host status` reports. */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakePackage } from '../../core/jobs/__tests__/pinned-fixture.js';
import { initializeCoordinator } from '../../core/jobs/client.js';
import * as fingerprint from '../../core/jobs/executor-fingerprint.js';
import { readPinnedRuntime } from '../../core/jobs/pinned-runtime.js';
import type { Endpoint } from '../../core/jobs/protocol.js';
import { writeDurable } from '../../core/jobs/store.js';
import { registerHostUpgrade, runtimeStatus } from '../host-runtime.js';

const CLIENT = 'b'.repeat(64);
let directory: string;
let namespace: string;
let writes: string[];

async function upgrade(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  const host = program.command('host');
  registerHostUpgrade(host, {
    getProjectRoot: () => directory,
    withErrorHandling: (handler) => handler,
  });
  await program.parseAsync([
    'node',
    'fireforge',
    'host',
    'upgrade',
    '--namespace',
    namespace,
    ...args,
  ]);
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-upgrade-')));
  namespace = join(directory, 'coordinator');
  await initializeCoordinator(namespace, { idleMs: 60_000 });
  vi.spyOn(fingerprint, 'executorFingerprint').mockResolvedValue(CLIENT);
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('host upgrade', () => {
  it('pins a build, says when the host takes it up, and rolls back to the previous one', async () => {
    const first = await fakePackage(join(directory, 'one'), { executor: '1'.repeat(64) });
    const second = await fakePackage(join(directory, 'two'), { executor: CLIENT });
    await upgrade('--from', first);
    expect(writes.join('')).toMatch(
      /Pinned FireForge 9\.9\.9\+gabc1234 \([0-9a-f]{16}\) from .*one\. The next supervisor start runs it\./
    );
    const status = await runtimeStatus(namespace);
    expect(status.lines.join('\n')).toMatch(/FireForge: pinned FireForge 9\.9\.9\+gabc1234/);
    expect(status.lines.join('\n')).toMatch(/another build than the pinned one/);
    expect(status.data.runtime.client.pinned).toBe(false);

    // A supervisor of the first build is running when the second is pinned.
    await writeDurable(join(namespace, 'endpoint.json'), {
      schemaVersion: 1,
      socket: join(directory, 'no.sock'),
      epoch: 1,
      owner: { pid: process.pid, start: 'x' },
      executorDigest: '1'.repeat(64),
    } satisfies Endpoint);
    writes = [];
    await upgrade('--from', second);
    expect(writes.join('')).toMatch(/Previous: FireForge 9\.9\.9\+gabc1234/);
    expect(writes.join('')).toMatch(/fireforge host upgrade --previous/);
    const pinned = await runtimeStatus(namespace);
    expect(pinned.data.runtime.client.pinned).toBe(true);
    expect(pinned.lines.join('\n')).toMatch(/This checkout: .*the pinned build/);

    const before = await readPinnedRuntime(namespace);
    await upgrade('--previous');
    const after = await readPinnedRuntime(namespace);
    expect(after?.current.id).toBe(before?.previous?.id);
    expect(after?.previous?.id).toBe(before?.current.id);
  });

  it('says a host without a pinned build runs whichever client starts it', async () => {
    const status = await runtimeStatus(namespace);
    expect(status.lines).toEqual([
      expect.stringMatching(
        /no pinned build; each supervisor start runs the package of the client/
      ),
    ]);
    expect(status.data.runtime.pinned).toBeNull();
  });

  it('refuses --from and --previous together', async () => {
    await expect(upgrade('--previous', '--from', directory)).rejects.toThrow(
      /--from or --previous, not both/
    );
  });
});
