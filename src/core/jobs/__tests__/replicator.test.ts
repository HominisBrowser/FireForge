// SPDX-License-Identifier: EUPL-1.2
/** The supervisor's side of a replication: when it starts, what admission sees, how it ends. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { SlotView } from '../admission.js';
import { initializeCoordinator } from '../client.js';
import { type ReplicatorHost, SlotReplicator } from '../replicator.js';
import { derivedResources, type JobRecord, type JobStep, type ResourceVector } from '../schema.js';
import { SlotBusyError } from '../slot-lock.js';
import {
  abandonReplication,
  readReplicationMarker,
  replicateSlotBuild,
  ReplicationDeclined,
  writeReplicationMarker,
} from '../slot-replication.js';
import { slotDirectory, writeDurable } from '../store.js';

vi.mock('../slot-replication.js', async (original) => ({
  ...(await original<typeof import('../slot-replication.js')>()),
  replicateSlotBuild: vi.fn(),
  abandonReplication: vi.fn(),
}));

const capacity: ResourceVector = { cpu: 14, memory: 28, build: 1, browser: 1, display: 1 };
const ui: JobStep = { command: 'build', args: ['--ui'] };

const job = (
  id: string,
  extra: Partial<Omit<JobRecord, 'compiledDigest'>> & { compiledDigest?: string | undefined } = {}
): JobRecord =>
  ({
    schemaVersion: 1,
    id,
    owner: 'fixture',
    request: { schemaVersion: 1, key: randomUUID(), sourceId: 'source', steps: [ui], quiet: false },
    state: 'queued',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    pin: 'pin',
    compiledDigest: 'wanted',
    stepResources: [derivedResources(ui, capacity)],
    phase: { index: 0, active: false, ticket: 1 },
    ...extra,
  }) as JobRecord;
const views = (): Map<string, SlotView> =>
  new Map([
    ['a', { id: 'a', pin: 'pin', quarantined: null, anchorDigest: 'wanted', sourceId: 'x' }],
    ['b', { id: 'b', pin: 'pin', quarantined: null, requiresFullBuild: true }],
  ]);
const waiters = [job('w1'), job('w2')];

let namespace: string;
let host: {
  namespace: string;
  submit: Mock<ReplicatorHost['submit']>;
  requestSchedule: Mock<ReplicatorHost['requestSchedule']>;
  logFault: Mock<ReplicatorHost['logFault']>;
};

beforeEach(async () => {
  namespace = await mkdtemp(join(tmpdir(), 'fireforge-replicator-'));
  for (const id of ['a', 'b']) await mkdir(slotDirectory(namespace, id), { recursive: true });
  await writeDurable(join(slotDirectory(namespace, 'b'), 'snapshot.json'), { id: 'source' });
  host = {
    namespace,
    submit: vi.fn<ReplicatorHost['submit']>().mockResolvedValue({ id: 'relocate' }),
    requestSchedule: vi.fn<ReplicatorHost['requestSchedule']>(),
    logFault: vi.fn<ReplicatorHost['logFault']>(),
  };
  vi.mocked(abandonReplication).mockResolvedValue();
  vi.mocked(replicateSlotBuild).mockResolvedValue();
});

afterEach(async () => {
  vi.mocked(replicateSlotBuild).mockReset();
  vi.mocked(abandonReplication).mockReset();
  await rm(namespace, { recursive: true, force: true });
});

/** Resolves once the replicator asked for the pass that follows its background work. */
const settled = (): Promise<void> =>
  vi.waitFor(() => {
    expect(host.requestSchedule).toHaveBeenCalled();
  });

describe('a replication the supervisor runs', () => {
  it('withholds both slots, copies, then submits the relocation as its own job', async () => {
    vi.mocked(replicateSlotBuild).mockImplementation(async () => {
      await writeReplicationMarker(namespace, 'b', {
        from: 'a',
        phase: 'relocating',
        startedAt: '',
      });
    });
    const replicator = new SlotReplicator(host);
    const seen = await replicator.pass(waiters, views(), {});
    expect(seen.get('a')?.replicating).toBe("replicating slot a's build into b");
    expect(seen.get('b')?.replicating).toBe("replicating slot a's build into b");
    expect(replicator.busy).toBe(true);
    await settled();
    expect(replicator.busy).toBe(false);
    expect(replicateSlotBuild).toHaveBeenCalledWith(namespace, 'a', 'b');
    expect(host.submit).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'b', steps: [{ command: 'qualify-native', args: [] }] }),
      { id: 'source' },
      'fireforge replication'
    );
    expect(await readReplicationMarker(namespace, 'b')).toMatchObject({ job: 'relocate' });
    // The source serves again; the destination only takes its relocation.
    const queued = job('relocate', { slot: 'b', compiledDigest: undefined });
    const after = await replicator.pass([...waiters, queued], views(), {});
    expect(after.get('a')?.replicating).toBeUndefined();
    expect(after.get('b')).toMatchObject({
      replicating: "replicating slot a's build into b",
      replicationJob: 'relocate',
    });
    expect(abandonReplication).not.toHaveBeenCalled();
  });

  it('starts nothing with replication switched off', async () => {
    const replicator = new SlotReplicator(host);
    const seen = await replicator.pass(waiters, views(), { replicateDepth: 0 });
    expect(seen.get('a')?.replicating).toBeUndefined();
    expect(replicateSlotBuild).not.toHaveBeenCalled();
  });

  it('does not try a declined pair again for the same build, but retries a busy one', async () => {
    vi.mocked(replicateSlotBuild).mockRejectedValueOnce(new ReplicationDeclined('no CoW'));
    const replicator = new SlotReplicator(host);
    await replicator.pass(waiters, views(), {});
    await settled();
    expect(host.logFault).toHaveBeenCalledWith(
      "Replicating slot a's build into b did not run",
      expect.objectContaining({ message: 'no CoW' })
    );
    await replicator.pass(waiters, views(), {});
    expect(replicateSlotBuild).toHaveBeenCalledTimes(1);

    const retrying = new SlotReplicator(host);
    vi.mocked(replicateSlotBuild).mockRejectedValueOnce(new ReplicationDeclined('locked', true));
    host.requestSchedule.mockClear();
    host.logFault.mockClear();
    await retrying.pass(waiters, views(), {});
    await settled();
    expect(host.logFault).not.toHaveBeenCalled();
    vi.mocked(replicateSlotBuild).mockResolvedValueOnce();
    host.requestSchedule.mockClear();
    await retrying.pass(waiters, views(), {});
    await settled();
    expect(replicateSlotBuild).toHaveBeenCalledTimes(3);
  });

  it('clears the marker once its relocation passed', async () => {
    await writeReplicationMarker(namespace, 'b', {
      from: 'a',
      phase: 'relocating',
      startedAt: '',
      job: 'relocate',
    });
    const replicator = new SlotReplicator(host);
    const relocating = job('relocate', { state: 'running', slot: 'b' });
    await replicator.pass([relocating], views(), {});
    expect(await readReplicationMarker(namespace, 'b')).toBeDefined();
    await replicator.pass([{ ...relocating, state: 'passed' }], views(), {});
    await settled();
    expect(await readReplicationMarker(namespace, 'b')).toBeUndefined();
    expect(abandonReplication).not.toHaveBeenCalled();
  });

  it('abandons a replication whose relocation failed, or that nothing carries on', async () => {
    const marker = {
      from: 'a',
      phase: 'relocating' as const,
      startedAt: '',
      job: 'relocate',
    };
    await writeReplicationMarker(namespace, 'b', marker);
    const replicator = new SlotReplicator(host);
    const failed = job('relocate', { state: 'failed', slot: 'b', reason: 'configure failed' });
    await replicator.pass([failed], views(), {});
    await settled();
    expect(abandonReplication).toHaveBeenCalledWith(
      namespace,
      'b',
      marker,
      'relocating job relocate ended failed: configure failed'
    );
    expect(host.logFault).toHaveBeenCalledWith(
      "Replicating slot a's build into b failed",
      'relocating job relocate ended failed: configure failed'
    );

    // A copy a crash interrupted: no task, no job.
    const copying = { from: 'a', phase: 'copying' as const, startedAt: '' };
    await writeReplicationMarker(namespace, 'b', copying);
    host.requestSchedule.mockClear();
    vi.mocked(abandonReplication).mockRejectedValueOnce(new SlotBusyError('Slot b is busy'));
    await new SlotReplicator(host).pass([], views(), {});
    await settled();
    expect(abandonReplication).toHaveBeenLastCalledWith(
      namespace,
      'b',
      copying,
      'the replication was interrupted'
    );
    // Busy only means the next pass tries again.
    expect(host.logFault).toHaveBeenCalledTimes(1);
  });

  it('keeps the depth host init stated, 0 included, across a rerun that states none', async () => {
    const coordinator = join(namespace, 'coordinator');
    expect((await initializeCoordinator(coordinator, { replicateDepth: 0 })).replicateDepth).toBe(
      0
    );
    expect((await initializeCoordinator(coordinator)).replicateDepth).toBe(0);
  });

  it('keeps a slot whose marker cannot be read out of every job’s way', async () => {
    await mkdir(join(slotDirectory(namespace, 'b'), 'replication.json'));
    const seen = await new SlotReplicator(host).pass(waiters, views(), {});
    expect(seen.get('b')?.replicating).toMatch(/unable to read a replication into slot b/);
  });
});
