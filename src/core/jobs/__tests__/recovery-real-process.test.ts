// SPDX-License-Identifier: EUPL-1.2
/** What a restarted supervisor does to a process a journal names, decided by the process's real birth. */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { initializeCoordinator } from '../client.js';
import { observeHost } from '../host-quarantine.js';
import { processIdentityAsync } from '../process.js';
import type { JobRecord, ProcessIdentity } from '../schema.js';
import { createSlot } from '../slot-lifecycle.js';
import { readSlot } from '../slots.js';
import { appendTransition, readJournal } from '../store.js';
import { LocalSupervisor } from '../supervisor.js';

const cleanup: Array<() => Promise<unknown>> = [];
// Last in, first out: a supervisor closes before the namespace it is writing to goes.
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

/** A detached group leader, like an executor, that does not exit by itself. */
async function sleeper(
  script = 'exec sleep 600'
): Promise<{ child: ChildProcess; identity: ProcessIdentity }> {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    await once(child, 'exit');
  });
  const identity = await processIdentityAsync(child.pid ?? 0);
  if (identity === undefined) throw new Error('The sleeper has no identity');
  return { child, identity };
}

/** A coordinator whose journal says a job on slot a is running as this process. */
async function interruptedCoordinator(process: ProcessIdentity): Promise<string> {
  const f = await sourceFixture();
  cleanup.push(() => rm(dirname(f.root), { recursive: true, force: true }));
  const namespace = join(dirname(f.root), 'coordinator');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src'],
    pristineRepository: f.pristine,
  });
  await initializeCoordinator(namespace, { idleMs: 60_000, legacyExcluded: true });
  await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
  const job: JobRecord = {
    schemaVersion: 1,
    id: 'job',
    owner: 'fixture',
    request: {
      schemaVersion: 1,
      key: 'fixture',
      slot: 'a',
      sourceId: snapshot.id,
      steps: [{ command: 'status', args: [] }],
      resources: { cpu: 1, memory: 1, build: 0, browser: 0, display: 0 },
      quiet: false,
    },
    state: 'running',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    phase: { index: 0, active: true, ticket: 1 },
    process,
    executionToken: 'token',
  };
  await appendTransition(namespace, job);
  return namespace;
}

/** The identity after `exec`: the birth is the same, which is the point of naming a process by it. */
async function settledIdentity(before: ProcessIdentity): Promise<ProcessIdentity> {
  const after = await processIdentityAsync(before.pid);
  expect(after?.start).toBe(before.start);
  return before;
}

async function restart(namespace: string): Promise<void> {
  const supervisor = await LocalSupervisor.start(namespace);
  cleanup.push(() => supervisor.close().catch(() => undefined));
}

describe.skipIf(process.platform === 'win32')('recovery on a real restart', () => {
  it('stops a process whose birth matches the record: it is that job’s own', async () => {
    const { child, identity } = await sleeper();
    const namespace = await interruptedCoordinator(identity);
    const exited = once(child, 'exit');
    await restart(namespace);
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGTERM');
    expect((await readJournal(namespace)).get('job')?.state).toBe('interrupted');
    expect((await readSlot(namespace, 'a')).quarantined).toMatch(/interruption/);
    // Gone, so nothing is left to hold.
    expect((await observeHost(namespace)).groups).toEqual([]);
  });

  it('escalates on its own process when a polite signal is not enough', async () => {
    const ready = join(tmpdir(), `fireforge-recovery-${randomUUID()}`);
    const { child, identity } = await sleeper(`trap '' TERM; : > '${ready}'; exec sleep 600`);
    cleanup.push(() => rm(ready, { force: true }));
    await vi.waitFor(() => access(ready), { timeout: 10_000, interval: 20 });
    const namespace = await interruptedCoordinator(await settledIdentity(identity));
    const exited = once(child, 'exit');
    await restart(namespace);
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGKILL');
    expect((await readJournal(namespace)).get('job')?.state).toBe('interrupted');
  });

  it('never signals another process on the same pid: a recycled pid is not the job’s', async () => {
    const { child, identity } = await sleeper();
    const namespace = await interruptedCoordinator({
      pid: identity.pid,
      start: `${identity.start}-another-birth`,
    });
    await restart(namespace);
    // Long enough for the SIGTERM and SIGKILL path to have run, had it been taken.
    await new Promise((settle) => setTimeout(settle, 1_500));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect((await processIdentityAsync(identity.pid))?.start).toBe(identity.start);
    expect((await readJournal(namespace)).get('job')?.state).toBe('interrupted');
    // The slot was interrupted all the same. The number is not the job's, so nothing holds it.
    expect((await readSlot(namespace, 'a')).quarantined).toMatch(/interruption/);
    expect((await observeHost(namespace)).groups).toEqual([]);
  });
});
