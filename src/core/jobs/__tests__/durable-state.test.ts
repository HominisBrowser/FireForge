// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { electionDirectory, ElectionLostError, electSupervisor } from '../election.js';
import { socketDirectory } from '../protocol.js';
import { recoverJobJournal } from '../recovery.js';
import { compactJobHistory } from '../retention.js';
import type { JobRecord } from '../schema.js';
import { checkStorageCapacity, diskBlock } from '../storage.js';
import {
  appendTransition,
  readJournal,
  readJournalContents,
  readJson,
  writeDurable,
} from '../store.js';

const control = vi.hoisted(() => ({ shortWrite: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (!control.shortWrite || !String(args[0]).endsWith('journal.jsonl')) return file;
      return new Proxy(file, {
        get(target, property) {
          if (property === 'writeFile')
            return async (bytes: string) => {
              await target.writeFile(bytes.slice(0, 7));
              throw new Error('ENOSPC: no space left on device, write');
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? (value.bind(target) as unknown) : value;
        },
      });
    }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  control.shortWrite = false;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ff-durable-'));
  directories.push(path);
  return path;
}
function record(id: string, state: JobRecord['state'] = 'queued'): JobRecord {
  return {
    schemaVersion: 1,
    id,
    owner: 'fixture',
    request: {
      schemaVersion: 1,
      key: id,
      sourceId: 'a'.repeat(64),
      steps: [{ command: 'status', args: [] }],
      quiet: false,
    },
    state,
    epoch: 1,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancellationRequested: false,
  };
}

describe('the journal', () => {
  it('survives a short write: a failed append leaves no bytes for the next row to join', async () => {
    const namespace = await directory();
    await appendTransition(namespace, record('first'));
    control.shortWrite = true;
    await expect(appendTransition(namespace, record('torn'))).rejects.toThrow(/ENOSPC/);
    control.shortWrite = false;
    await appendTransition(namespace, record('second'));
    const replayed = await readJournal(namespace);
    expect([...replayed.keys()]).toEqual(['first', 'second']);
  });
  it('a damaged interior row costs only its job: it is kept aside and the rest replay', async () => {
    const namespace = await directory();
    const survivor = record('survivor', 'passed');
    await appendTransition(namespace, survivor);
    const queued = record('queued-job');
    await appendTransition(namespace, queued);
    const superseded = record('superseded');
    await appendTransition(namespace, { ...superseded, state: 'running' });
    await appendFile(join(namespace, 'journal.jsonl'), '{broken row\n');
    await appendFile(
      join(namespace, 'journal.jsonl'),
      '{"schemaVersion":1,"id":"queued-job",torn\n'
    );
    await appendTransition(namespace, { ...superseded, state: 'passed' });
    const { jobs, damaged } = await readJournalContents(namespace);
    expect(damaged.map((row) => [row.line, row.job])).toEqual([
      [4, undefined],
      [5, 'queued-job'],
    ]);
    expect(jobs.get('survivor')?.state).toBe('passed');
    expect((await readJournal(namespace)).size).toBe(3);

    const recovered = await recoverJobJournal(namespace, 2);
    expect(recovered.damaged).toBe(2);
    expect(recovered.jobs.get('survivor')?.state).toBe('passed');
    expect(recovered.jobs.get('superseded')?.state).toBe('passed');
    // Its last record is gone, so what it was doing is not known: it does not run again by itself.
    expect(recovered.jobs.get('queued-job')?.state).toBe('interrupted');
    expect(recovered.jobs.get('queued-job')?.reason).toContain('journal.damaged.jsonl');
    const kept = await readFile(join(namespace, 'journal.damaged.jsonl'), 'utf8');
    expect(kept).toContain('{broken row');
    // The journal is clean, so nothing repeats at the next start.
    expect((await readJournalContents(namespace)).damaged).toEqual([]);
  });
  it('compacts to one row per job and forgets terminal jobs past retention', async () => {
    const namespace = await directory();
    const old = record('old', 'passed');
    old.updatedAt = new Date(0).toISOString();
    await mkdir(join(namespace, 'artifacts', 'old'), { recursive: true });
    await writeFile(join(namespace, 'artifacts', 'old', 'report.json'), '{}');
    await mkdir(join(namespace, 'logs'));
    await writeFile(join(namespace, 'logs', 'old.log'), 'log');
    const live = record('live');
    live.updatedAt = new Date(0).toISOString();
    const recent = record('recent', 'failed');
    for (const job of [old, live, live, recent, recent]) await appendTransition(namespace, job);
    const jobs = await readJournal(namespace);
    await compactJobHistory(namespace, jobs);
    expect([...jobs.keys()].sort()).toEqual(['live', 'recent']);
    const rows = (await readFile(join(namespace, 'journal.jsonl'), 'utf8')).trim().split('\n');
    expect(rows).toHaveLength(2);
    await expect(readFile(join(namespace, 'logs', 'old.log'))).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(namespace, 'artifacts', 'old', 'report.json'))).rejects.toThrow(
      /ENOENT/
    );
  });
});

describe('snapshot retention', () => {
  it('releases what no remembered job or slot needs, and keeps the rest', async () => {
    const namespace = await directory();
    await writeDurable(join(namespace, 'snapshots', `${'a'.repeat(64)}.json`), {});
    await writeDurable(join(namespace, 'snapshots', 'held-by-slot.json'), {});
    await writeDurable(join(namespace, 'snapshots', 'unused.json'), {});
    await writeDurable(join(namespace, 'slots', 's', 'slot.json'), { sourceId: 'held-by-slot' });
    await compactJobHistory(namespace, new Map([['live', record('live')]]));
    expect((await readdir(join(namespace, 'snapshots'))).sort()).toEqual([
      `${'a'.repeat(64)}.json`,
      'held-by-slot.json',
    ]);
  });
  it('keeps every snapshot when a slot cannot say what it holds', async () => {
    const namespace = await directory();
    await writeDurable(join(namespace, 'snapshots', 'unused.json'), {});
    await mkdir(join(namespace, 'slots', 's'), { recursive: true });
    await writeFile(join(namespace, 'slots', 's', 'slot.json'), '{broken');
    await compactJobHistory(namespace, new Map());
    expect(await readdir(join(namespace, 'snapshots'))).toEqual(['unused.json']);
  });
});

describe('the election', () => {
  /** A claim by a process that has exited, as a crash would leave it. */
  async function deadClaim(directory_: string, generation: number): Promise<void> {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(dead, 'exit');
    await mkdir(directory_, { recursive: true });
    await writeDurable(join(directory_, `exclusive.${String(generation)}`), {
      owner: { pid: dead.pid, start: 'long-gone' },
      nonce: 'dead',
    });
  }

  it('recovers from a crash at any point, and counts epochs across it', async () => {
    const namespace = await directory();
    const first = await electSupervisor(namespace);
    expect(first.epoch).toBe(1);
    await first.release();
    await deadClaim(electionDirectory(namespace), 40);
    const second = await electSupervisor(namespace);
    expect(second.epoch).toBe(2);
    await second.release();
  });

  it('lets exactly one of several contenders win a dead owner’s claim', async () => {
    const namespace = await directory();
    await deadClaim(electionDirectory(namespace), 1);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => electSupervisor(namespace))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ElectionLostError);
  });

  it('names a live holder, and never takes over from one', async () => {
    const namespace = await directory();
    const held = await electSupervisor(namespace);
    await expect(electSupervisor(namespace)).rejects.toThrow(
      new RegExp(`already running \\(pid ${String(process.pid)}\\)`)
    );
    await held.release();
    await (await electSupervisor(namespace)).release();
  });

  it('does not disturb a claim another owner has since taken', async () => {
    const namespace = await directory();
    const election = await electSupervisor(namespace);
    const other = { owner: { pid: 1, start: 'other' }, nonce: 'other' };
    const taken = join(electionDirectory(namespace), 'exclusive.2');
    await writeDurable(taken, other);
    await election.release();
    expect(await readJson(taken)).toEqual(other);
    await expect(readFile(`${taken}.free`)).rejects.toThrow(/ENOENT/);
  });
});

describe('a durable write', () => {
  it('leaves no temporary behind when it fails', async () => {
    const namespace = await directory();
    const target = join(namespace, 'occupied');
    await mkdir(join(target, 'in-the-way'), { recursive: true });
    await expect(writeDurable(target, { a: 1 })).rejects.toThrow();
    expect((await readdir(namespace)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('storage', () => {
  const reservation = {
    expectedBytes: 2 ** 40,
    reservedBytes: 2 ** 41,
    memoryBytes: 1,
    floorBytes: 1,
  };
  async function slotWith(namespace: string, id: string, storage: unknown): Promise<void> {
    await writeDurable(join(namespace, 'slots', id, 'slot.json'), { storage });
  }
  it('counts only what a slot can still grow by', async () => {
    const namespace = await directory();
    await slotWith(namespace, 'a', reservation);
    await expect(checkStorageCapacity(namespace)).rejects.toThrow(/Disk floor/);
    await slotWith(namespace, 'a', { ...reservation, consumedBytes: reservation.reservedBytes });
    await expect(checkStorageCapacity(namespace)).resolves.toBeUndefined();
  });
  it('enforces the slot limit from the typed configuration', async () => {
    const namespace = await directory();
    await writeDurable(join(namespace, 'config.json'), { maxSlots: 1 });
    const small = { ...reservation, reservedBytes: 1 };
    await slotWith(namespace, 'a', small);
    await expect(checkStorageCapacity(namespace)).resolves.toBeUndefined();
    await expect(checkStorageCapacity(namespace, small)).rejects.toThrow(/--max-slots/);
  });
  it('applies only the floor at admission', async () => {
    const namespace = await directory();
    await slotWith(namespace, 'a', reservation);
    expect(await diskBlock(namespace)).toBeUndefined();
    await slotWith(namespace, 'a', { ...reservation, floorBytes: Number.MAX_SAFE_INTEGER });
    expect(await diskBlock(namespace)).toMatch(/Waiting for disk/);
  });
});

describe('the socket path', () => {
  it('stays in the namespace when it fits and ignores TMPDIR when it does not', () => {
    vi.stubEnv('TMPDIR', '/some/agent/session');
    expect(socketDirectory('/short/ns')).toBe('/short/ns/run');
    const long = socketDirectory(`/${'x'.repeat(120)}`);
    expect(long.startsWith('/tmp/ff-jobs-')).toBe(true);
    vi.unstubAllEnvs();
  });
});
