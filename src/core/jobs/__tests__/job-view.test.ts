// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { commitFixture, sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { projectIdentity } from '../guard-project.js';
import { readLogRange, stepMarker, visibleJob } from '../job-view.js';
import type { JobRecord, JobStep } from '../schema.js';
import { compiledControl } from '../step-build.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fireforge-job-view-'));
  directories.push(path);
  return path;
}

describe('what a client sees of a job', () => {
  const job = { id: 'x', executionToken: 'secret' } as JobRecord;

  it('never carries the execution token, and says why it waits when it does', () => {
    expect(visibleJob(job)).not.toHaveProperty('executionToken');
    expect(visibleJob(job).blockedBy).toBeUndefined();
    expect(visibleJob(job, 'capacity').blockedBy).toBe('capacity');
    expect(job.executionToken).toBe('secret');
  });
});

describe('a bounded log read', () => {
  it('reads a range and says where the next one starts', async () => {
    const namespace = await directory();
    await mkdir(join(namespace, 'logs'));
    await writeFile(join(namespace, 'logs', 'job.log'), 'abcdef');
    expect(await readLogRange(namespace, 'job', 1, 2)).toEqual({
      text: 'bc',
      nextOffset: 3,
      totalBytes: 6,
    });
    expect(await readLogRange(namespace, 'job')).toMatchObject({ text: 'abcdef', nextOffset: 6 });
  });

  it('reads a job with no log yet as empty', async () => {
    expect(await readLogRange(await directory(), 'job', 5)).toEqual({
      text: '',
      nextOffset: 5,
      totalBytes: 0,
    });
  });

  it.each([
    [-1, 10],
    [0.5, 10],
    [0, 0],
    [0, 1_048_577],
  ])('refuses the range %d, %d', async (offset, limit) => {
    await expect(readLogRange(await directory(), 'job', offset, limit)).rejects.toThrow(
      /Invalid log range/
    );
  });

  it('propagates a log it cannot open for any other reason', async () => {
    const namespace = await directory();
    await mkdir(join(namespace, 'logs', 'job.log'), { recursive: true });
    await writeFile(join(namespace, 'logs', 'other'), '');
    await expect(readLogRange(join(namespace, 'logs', 'other'), 'job')).rejects.toThrow(/ENOTDIR/);
  });
});

describe('one step of a job log', () => {
  const check: JobStep = { command: 'check', args: [] };
  const test: JobStep = { command: 'test', args: ['a.js'] };
  const steps: JobStep[] = [check, { command: 'build', args: ['--ui'] }, test];
  async function log(text: string): Promise<string> {
    const namespace = await directory();
    await mkdir(join(namespace, 'logs'));
    await writeFile(join(namespace, 'logs', 'job.log'), text);
    return namespace;
  }
  const first = `${stepMarker(0, check)}${'check line\n'.repeat(50)}`;
  const third = `${stepMarker(2, test)}one\ntwo\nTEST-UNEXPECTED-FAIL a.js\n`;

  it('reads a step by its marker, with offsets from the step’s own start', async () => {
    const namespace = await log(`preamble\n${first}${third}`);
    const chunk = await readLogRange(namespace, 'job', 0, 1_000, { step: 2 });
    expect(chunk).toMatchObject({ text: third, step: 2, steps: [0, 2], offset: 0 });
    expect(chunk.totalBytes).toBe(Buffer.byteLength(third));
    const next = await readLogRange(namespace, 'job', chunk.nextOffset - 4, 1_000, { step: 2 });
    expect(next).toMatchObject({ text: '.js\n', nextOffset: chunk.nextOffset });
  });

  it('tails a step from a line start, and keeps a requeued step’s latest run', async () => {
    const rerun = `${stepMarker(2, test)}again\nlast line\n`;
    const namespace = await log(`${first}${third}${rerun}`);
    const tail = await readLogRange(namespace, 'job', 0, 15, { step: 2, tail: true });
    expect(tail.text).toBe('last line\n');
    expect(tail.offset).toBe(Buffer.byteLength(rerun) - 10);
    const head = await readLogRange(namespace, 'job', 0, 30, { step: 0, tail: true });
    expect(head.text).toBe('check line\ncheck line\n');
  });

  it('places markers naming no index by the request, past a step that wrote none', async () => {
    const legacy = (step: JobStep): string => `FIREFORGE-JOB-STEP: ${JSON.stringify(step)}\n`;
    const namespace = await log(`${legacy(check)}a\n${legacy(test)}c\n`);
    expect(await readLogRange(namespace, 'job', 0, 100, { step: 2, steps })).toMatchObject({
      text: `${legacy(test)}c\n`,
      steps: [0, 2],
    });
  });

  it('refuses a step with no output, naming those that have some', async () => {
    const namespace = await log(first);
    await expect(readLogRange(namespace, 'job', 0, 100, { step: 1 })).rejects.toThrow(
      /Step 1 has no output in this job's log; steps with output: 0/
    );
    await expect(readLogRange(await directory(), 'job', 0, 100, { step: 1 })).rejects.toThrow(
      /no log yet/
    );
  });

  it('finds a marker that straddles the scan’s chunk boundary', async () => {
    const filler = 'x'.repeat(1_048_576 - 3) + '\n';
    const namespace = await log(`${first}${filler}${third}`);
    expect((await readLogRange(namespace, 'job', 0, 1_000, { step: 2 })).text).toBe(third);
  });
});

describe('a checkout’s project identity', () => {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  };

  it('is the shared Git directory, from a main checkout and from a linked worktree alike', async () => {
    const root = await directory();
    const main = join(root, 'main');
    await mkdir(main);
    git(main, 'init', '-q');
    git(
      main,
      '-c',
      'user.email=f@e.invalid',
      '-c',
      'user.name=f',
      'commit',
      '-qm',
      'a',
      '--allow-empty'
    );
    git(main, 'worktree', 'add', '-q', '--detach', join(root, 'linked'));
    const common = await realpath(join(main, '.git'));
    expect(await projectIdentity(main)).toBe(common);
    expect(await projectIdentity(join(root, 'linked'))).toBe(common);
  });

  it('is the gitdir itself for a submodule-shaped checkout with no common directory', async () => {
    const root = await directory();
    await mkdir(join(root, 'store'));
    await writeFile(join(root, '.git'), 'gitdir: store\n');
    expect(await projectIdentity(root)).toBe(await realpath(join(root, 'store')));
  });

  it('is the plain root outside Git, whether or not it exists', async () => {
    const root = await directory();
    expect(await projectIdentity(root)).toBe(await realpath(root));
    expect(await projectIdentity(join(root, 'missing'))).toBe(join(root, 'missing'));
  });

  it('falls back to the root for a .git naming nothing, and propagates anything else', async () => {
    const root = await directory();
    await writeFile(join(root, '.git'), 'gitdir: missing\n');
    expect(await projectIdentity(root)).toBe(await realpath(root));
    await expect(projectIdentity(join(root, '.git'))).rejects.toThrow(/ENOTDIR/);
  });
});

describe('whether a negative control touches compiled output', () => {
  const diff = (path: string): string => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

  it('reads it from the captured diff, and takes what it cannot read as compiled', async () => {
    const f = await sourceFixture();
    directories.push(join(f.root, '..'));
    await writeAt(f.root, 'tools/ui.diff', diff('browser/a.css'));
    await writeAt(f.root, 'tools/native.diff', diff('dom/a.cpp'));
    await writeAt(f.root, 'tools/broken.diff', 'not a diff at all\n');
    await commitFixture(f.root);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src', 'tools/ui.diff', 'tools/native.diff', 'tools/broken.diff'],
      pristineRepository: f.pristine,
    });
    const control = (path: string): Parameters<typeof compiledControl>[1] => ({
      command: 'test',
      args: ['--negative-control', path, 'a.js'],
    });
    expect(await compiledControl(snapshot, control('tools/ui.diff'))).toBe(false);
    expect(await compiledControl(snapshot, control('tools/native.diff'))).toBe(true);
    expect(await compiledControl(snapshot, control('tools/broken.diff'))).toBe(true);
    expect(await compiledControl(snapshot, control('tools/absent.diff'))).toBe(true);
    const unreadable = { ...snapshot, repository: join(f.root, 'not-a-repository') };
    expect(await compiledControl(unreadable, control('tools/ui.diff'))).toBe(true);
  });
});
