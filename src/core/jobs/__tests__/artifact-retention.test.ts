// SPDX-License-Identifier: EUPL-1.2
/** The age and size bounds on job artifacts. */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { artifactBounds, pruneArtifacts } from '../retention.js';
import type { JobRecord, JobState } from '../schema.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-30T00:00:00Z');
let ns: string;

function job(id: string, owner: string, state: JobState, daysOld: number): JobRecord {
  return {
    id,
    owner,
    state,
    updatedAt: new Date(NOW - daysOld * DAY).toISOString(),
  } as unknown as JobRecord;
}

async function artifact(id: string, blocks: number): Promise<void> {
  const directory = join(ns, 'artifacts', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'blob'), Buffer.alloc(blocks * 4096, 1));
}

const names = async (): Promise<string[]> => (await readdir(join(ns, 'artifacts'))).sort();
const bounds = (
  maxBytes: number,
  maxAgeDays: number,
  keepPerOwner = 0
): { maxBytes: number; maxAgeMs: number; keepPerOwner: number } => ({
  maxBytes,
  maxAgeMs: maxAgeDays * DAY,
  keepPerOwner,
});

beforeEach(async () => {
  ns = await mkdtemp(join(tmpdir(), 'fireforge-artifacts-'));
});
afterEach(async () => {
  await rm(ns, { recursive: true, force: true });
});

describe('artifactBounds', () => {
  it('defaults to 10 GiB, 14 days and the newest 3 per owner, and takes configured values', () => {
    expect(artifactBounds({})).toEqual({
      maxBytes: 10 * 1024 ** 3,
      maxAgeMs: 14 * DAY,
      keepPerOwner: 3,
    });
    expect(artifactBounds({ artifactMaxGib: 2, artifactMaxAgeDays: 1 })).toMatchObject({
      maxBytes: 2 * 1024 ** 3,
      maxAgeMs: DAY,
    });
  });
});

describe('pruneArtifacts', () => {
  it('drops finished jobs past the age bound and never a job still running', async () => {
    await artifact('old-done', 4);
    await artifact('old-running', 4);
    await artifact('young-done', 4);
    const jobs = new Map([
      ['old-done', job('old-done', 'a', 'passed', 30)],
      ['old-running', job('old-running', 'a', 'running', 30)],
      ['young-done', job('young-done', 'a', 'failed', 1)],
    ]);
    const result = await pruneArtifacts(ns, jobs, bounds(1e12, 14), { now: NOW });
    expect(result.removed.map((entry) => [entry.id, entry.reason])).toEqual([['old-done', 'age']]);
    expect(result.freedBytes).toBeGreaterThanOrEqual(4 * 4096);
    expect(await names()).toEqual(['old-running', 'young-done']);
  });

  it('keeps the newest few of each owner whatever their age', async () => {
    for (const id of ['a1', 'a2', 'a3', 'b1']) await artifact(id, 1);
    const jobs = new Map([
      ['a1', job('a1', 'a', 'passed', 90)],
      ['a2', job('a2', 'a', 'passed', 60)],
      ['a3', job('a3', 'a', 'passed', 50)],
      ['b1', job('b1', 'b', 'passed', 80)],
    ]);
    const result = await pruneArtifacts(ns, jobs, bounds(1e12, 14, 2), { now: NOW });
    expect(result.removed.map((entry) => entry.id)).toEqual(['a1']);
    expect(await names()).toEqual(['a2', 'a3', 'b1']);
  });

  it('removes the oldest finished jobs until the total is within the size bound', async () => {
    for (const id of ['o1', 'o2', 'o3', 'live']) await artifact(id, 8);
    const jobs = new Map([
      ['o1', job('o1', 'a', 'passed', 5)],
      ['o2', job('o2', 'b', 'passed', 4)],
      ['o3', job('o3', 'c', 'passed', 3)],
      ['live', job('live', 'd', 'queued', 9)],
    ]);
    const before = await pruneArtifacts(ns, jobs, bounds(1e12, 14), { now: NOW, dryRun: true });
    const each = before.remainingBytes / 4;
    const result = await pruneArtifacts(ns, jobs, bounds(each * 2.5, 14), { now: NOW });
    expect(result.removed.map((entry) => [entry.id, entry.reason])).toEqual([
      ['o1', 'size'],
      ['o2', 'size'],
    ]);
    expect(result.remainingBytes).toBeLessThanOrEqual(each * 2.5);
    expect(await names()).toEqual(['live', 'o3']);
  });

  it('removes a directory no job names only once it is a day old, and counts nothing on a dry run', async () => {
    await artifact('stray', 1);
    await artifact('fresh-stray', 1);
    const then = new Date(NOW - 3 * DAY);
    await utimes(join(ns, 'artifacts', 'stray'), then, then);
    const dry = await pruneArtifacts(ns, new Map(), bounds(1e12, 14), { now: NOW, dryRun: true });
    expect(dry.removed).toMatchObject([{ id: 'stray', reason: 'orphan' }]);
    expect(await names()).toEqual(['fresh-stray', 'stray']);
    await pruneArtifacts(ns, new Map(), bounds(1e12, 14), { now: NOW });
    expect(await names()).toEqual(['fresh-stray']);
  });

  it('has nothing to do for a namespace with no artifacts', async () => {
    expect(await pruneArtifacts(ns, new Map(), bounds(0, 0), { now: NOW })).toEqual({
      removed: [],
      freedBytes: 0,
      remainingBytes: 0,
    });
  });
});
