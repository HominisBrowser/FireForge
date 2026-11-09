// SPDX-License-Identifier: EUPL-1.2
/** `slot list` names a replication under way into a slot, in text and in JSON. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../cli.js';
import { readReplicationMarker } from '../../core/jobs/slot-replication.js';
import type { SlotRecord } from '../../core/jobs/slot-types.js';
import { readSlot } from '../../core/jobs/slots.js';

vi.mock('../../core/source-guard.js', () => ({ runSourceGuardHook: vi.fn() }));
vi.mock('../../core/tree-guard.js', () => ({ runTreeGuardHook: vi.fn() }));
vi.mock('../../core/jobs/guard.js', () => ({
  coordinatorNamespace: () => '/private/test',
  assertJobAdmission: vi.fn(),
}));
vi.mock('../../core/jobs/slots.js', async (original) => ({
  ...(await original<typeof import('../../core/jobs/slots.js')>()),
  readSlot: vi.fn(),
}));
vi.mock('../../core/jobs/slot-replication.js', async (original) => ({
  ...(await original<typeof import('../../core/jobs/slot-replication.js')>()),
  readReplicationMarker: vi.fn(),
}));

const originalArgv = process.argv;
let namespace: string;
let stdout: string[];

const record = (id: string, extra: Partial<SlotRecord> = {}): SlotRecord => ({
  schemaVersion: 1,
  id,
  root: `/slots/${id}/root`,
  pristineRepository: `/slots/${id}/engine.git`,
  pin: 'p'.repeat(40),
  sourceId: 's'.repeat(64),
  generation: 3,
  successfulBuildGeneration: 1,
  inputs: [],
  quarantined: null,
  ...extra,
});

beforeEach(async () => {
  namespace = await mkdtemp(join(tmpdir(), 'fireforge-slot-list-'));
  for (const id of ['a', 'b']) await mkdir(join(namespace, 'slots', id), { recursive: true });
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.mocked(readSlot).mockImplementation((_namespace, id) =>
    Promise.resolve(record(id, id === 'b' ? { requiresBuild: true } : {}))
  );
  vi.mocked(readReplicationMarker).mockImplementation((_namespace, id) =>
    Promise.resolve(
      id === 'b' ? { from: 'a', phase: 'relocating', startedAt: '', job: 'relocate' } : undefined
    )
  );
});

afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  await rm(namespace, { recursive: true, force: true });
});

async function list(...extra: string[]): Promise<string> {
  process.argv = ['node', 'fireforge', 'slot', 'list', '--namespace', namespace, ...extra];
  await createProgram().parseAsync(process.argv);
  return stdout.join('');
}

describe('slot list during a replication', () => {
  it('shows where the replication into a slot has got to', async () => {
    const text = await list();
    expect(text).toContain(
      `b source=ssssssssssss generation=3 needs=build replicating="slot a's build into b: relocating by job relocate"`
    );
    expect(text).toMatch(/^a source=s{12} generation=3$/m);
  });

  it('carries the record in JSON', async () => {
    const document = JSON.parse(await list('--json')) as {
      slots: Array<{ id: string; replication?: unknown }>;
    };
    expect(document.slots.find((slot) => slot.id === 'b')?.replication).toEqual({
      from: 'a',
      phase: 'relocating',
      startedAt: '',
      job: 'relocate',
    });
    expect(document.slots.find((slot) => slot.id === 'a')).not.toHaveProperty('replication');
  });
});
