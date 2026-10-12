// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathExists } from '../../utils/fs.js';
import {
  describeBuildRunState,
  readBuildRunState,
  withBuildRunRecord,
} from '../build-run-record.js';

describe('build run record', () => {
  let root: string;
  let recordFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-build-run-'));
    recordFile = join(root, '.fireforge', 'build-run.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeRecord(record: Record<string, unknown>): Promise<void> {
    await mkdir(join(root, '.fireforge'), { recursive: true });
    await writeFile(recordFile, JSON.stringify(record));
  }

  it('reads "running" while the build runs and removes the record on success', async () => {
    let during: Awaited<ReturnType<typeof readBuildRunState>> | undefined;
    await withBuildRunRecord(root, 'mach build', async () => {
      during = await readBuildRunState(root);
      return { exitCode: 0 };
    });
    expect(during).toMatchObject({
      kind: 'running',
      record: { pid: process.pid, machCommand: 'mach build', status: 'running' },
    });
    expect(await pathExists(recordFile)).toBe(false);
    expect(await readBuildRunState(root)).toEqual({ kind: 'none' });
  });

  it('keeps a failed record with the exit code on a non-zero exit', async () => {
    await withBuildRunRecord(root, 'mach build faster', () => Promise.resolve({ exitCode: 2 }));
    const state = await readBuildRunState(root);
    expect(state).toMatchObject({ kind: 'failed', record: { exitCode: 2, status: 'failed' } });
    expect(describeBuildRunState(state)).toMatch(/^The last build failed: .*with exit code 2\.$/);
  });

  it('keeps a failed record without an exit code when the build throws', async () => {
    await expect(
      withBuildRunRecord(root, 'mach build', () => Promise.reject(new Error('spawn failed')))
    ).rejects.toThrow('spawn failed');
    const state = await readBuildRunState(root);
    expect(state.kind).toBe('failed');
    expect(describeBuildRunState(state)).not.toContain('exit code');
  });

  it('reads a running record whose process is gone as interrupted', async () => {
    await writeRecord({
      status: 'running',
      pid: 2 ** 22 + 12345,
      command: 'fireforge build',
      machCommand: 'mach build',
      startedAt: '2026-10-03T21:10:00.000Z',
    });
    const state = await readBuildRunState(root);
    expect(state.kind).toBe('interrupted');
    expect(describeBuildRunState(state)).toContain(
      'The last build never finished: "fireforge build" (mach build, PID 4206649, started 2026-10-03T21:10:00.000Z)'
    );
  });

  it('describes a live build as running', async () => {
    await writeRecord({
      status: 'running',
      pid: process.pid,
      command: 'fireforge build',
      machCommand: 'mach build',
      startedAt: '2026-10-03T21:10:00.000Z',
    });
    expect(describeBuildRunState(await readBuildRunState(root))).toMatch(
      /^A build is running right now: /
    );
  });

  it('reads a missing, unparsable or malformed record as none, and never fails a build on write', async () => {
    expect(describeBuildRunState(await readBuildRunState(root))).toBeUndefined();
    await writeRecord({ status: 'running' });
    expect(await readBuildRunState(root)).toEqual({ kind: 'none' });
    await writeFile(recordFile, '{');
    expect(await readBuildRunState(root)).toEqual({ kind: 'none' });

    // `.fireforge` is a file here, so the record cannot be written at all.
    const blocked = join(root, 'blocked');
    await mkdir(blocked);
    await writeFile(join(blocked, '.fireforge'), '');
    await expect(
      withBuildRunRecord(blocked, 'mach build', () => Promise.resolve({ exitCode: 1 }))
    ).resolves.toEqual({ exitCode: 1 });
    expect(await readFile(join(blocked, '.fireforge'), 'utf8')).toBe('');
  });
});
