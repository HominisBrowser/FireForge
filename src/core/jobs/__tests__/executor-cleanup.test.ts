// SPDX-License-Identifier: EUPL-1.2
/** Tearing down an executor whose launch failed, with real process groups. */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ownProcessTree } from '../../../utils/process-group.js';
import { cleanupFailedExecutor } from '../executor-cleanup.js';
import { processIdentityAsync } from '../process.js';
import { OwnedProcessTracker } from '../process-tracker.js';
import type { ProcessIdentity } from '../schema.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function leader(script = 'exec sleep 600'): Promise<ChildProcess> {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  cleanup.push(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already gone, which is what the test wanted. */
    }
    return Promise.resolve();
  });
  return child;
}

const identify = async (child: ChildProcess): Promise<ProcessIdentity> => {
  const identity = await processIdentityAsync(child.pid ?? 0);
  if (identity === undefined) throw new Error('No identity');
  return identity;
};

const gone = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

describe.skipIf(process.platform === 'win32')('a failed executor launch', () => {
  it('has nothing to do when nothing started', async () => {
    const child = spawn(join(tmpdir(), 'fireforge-no-such-executor'), [], { stdio: 'ignore' });
    await once(child, 'error');
    expect(child.pid).toBeUndefined();
    await expect(cleanupFailedExecutor({ child })).resolves.toBeUndefined();
  });

  it('stops an identified leader, group and all, and is certain of it', async () => {
    const child = await leader('sleep 600 & wait');
    const identity = await identify(child);
    await expect(cleanupFailedExecutor({ child, identity })).resolves.toBeUndefined();
    expect(gone(child)).toBe(true);
    // The group is empty now.
    expect(() => process.kill(-identity.pid, 0)).toThrow();
  });

  it('holds what it cannot name: a child with no birth identity is uncertain even once stopped', async () => {
    const child = await leader();
    await expect(cleanupFailedExecutor({ child })).resolves.toMatch(/no authenticated birth/);
    expect(gone(child)).toBe(true);
  });

  it('does not signal a recycled pid: another birth leaves the process, and says so', async () => {
    const child = await leader();
    const identity = await identify(child);
    const uncertain = await cleanupFailedExecutor({
      child,
      identity: { pid: identity.pid, start: `${identity.start}-other` },
    });
    expect(uncertain).toMatch(/unconfirmed process cleanup/);
    expect(gone(child)).toBe(false);
  });

  it('stops a tree it owns, finishing the tracker, and reports a census it cannot complete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fireforge-cleanup-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const child = await leader();
    const identity = await identify(child);
    const ownership = ownProcessTree(child);
    const tracker = new OwnedProcessTracker(
      join(directory, 'processes.json'),
      identity,
      directory,
      'phase'
    );
    await tracker.start();
    await expect(
      cleanupFailedExecutor({
        child,
        identity,
        ...(ownership ? { ownership } : {}),
        tracker,
      })
    ).resolves.toBeUndefined();
    expect(gone(child)).toBe(true);

    const second = await leader();
    const broken = {
      finish: () => Promise.reject(new Error('census failed')),
    } as unknown as OwnedProcessTracker;
    await expect(
      cleanupFailedExecutor({ child: second, identity: await identify(second), tracker: broken })
    ).resolves.toMatch(/census failed/);
  });
});
