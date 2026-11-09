// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AmbiguousJobError, UnknownJobError } from '../../../errors/job.js';
import { resolveJobId } from '../client.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const first = '0f3a9c1e-1111-4aaa-8bbb-000000000001';
const ids = [first, '0f3a9c1e-2222-4aaa-8bbb-000000000002', '7d41b2c0-3333-4aaa-8bbb-000000000003'];

/** A namespace whose journal holds these jobs and no supervisor runs. */
async function namespaceWith(jobIds: readonly string[]): Promise<string> {
  const namespace = await mkdtemp(join(tmpdir(), 'fireforge-job-prefix-'));
  directories.push(namespace);
  const row = (id: string): string =>
    `${JSON.stringify({ schemaVersion: 1, id, state: 'passed', submittedAt: id, request: { steps: [] } })}\n`;
  await writeFile(join(namespace, 'journal.jsonl'), jobIds.map(row).join(''));
  return namespace;
}

describe('a job named by a prefix of its ID', () => {
  it('resolves a unique prefix of 8 or more hex characters, in either case', async () => {
    const namespace = await namespaceWith(ids);
    await expect(resolveJobId(namespace, '7d41b2c0')).resolves.toBe(ids[2]);
    await expect(resolveJobId(namespace, '0F3A9C1E-2')).resolves.toBe(ids[1]);
  });

  it('passes a whole ID through without reading the journal', async () => {
    await expect(resolveJobId('/nonexistent', first.toUpperCase())).resolves.toBe(first);
  });

  it('refuses an ambiguous prefix, naming every job it matches', async () => {
    const namespace = await namespaceWith(ids);
    const refused = await resolveJobId(namespace, '0f3a9c1e').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AmbiguousJobError);
    expect((refused as Error).message).toBe(
      `Job prefix 0f3a9c1e names 2 jobs: ${ids[0]}, ${ids[1]}. Name more of the ID`
    );
  });

  it('refuses a prefix naming no job, and one too short or not hex', async () => {
    const namespace = await namespaceWith(ids);
    await expect(resolveJobId(namespace, 'aaaaaaaa')).rejects.toThrow(
      new UnknownJobError(
        'Unknown job: no job ID starts with aaaaaaaa; fireforge job list shows what exists'
      )
    );
    for (const given of ['7d41b2c', 'job-1', '7d41b2c0;rm'])
      await expect(resolveJobId(namespace, given)).rejects.toThrow(
        /at least 8 hex characters; fireforge job list shows them/
      );
  });
});
