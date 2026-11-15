// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exists } from '../kernel/fs.js';
import { sleep } from '../kernel/time.js';
import { makeEngineProject } from '../testing/engine.js';
import { useTempDir } from '../testing/temp.js';
import {
  declarationHash,
  gateDir,
  type GateEntry,
  openRunRecord,
  prepareGateDir,
  readResumable,
  readRunningGates,
  readRunPosition,
  withFeedbackDir,
  withGateRun,
  writeResult,
} from './record.js';

const dir = useTempDir();

const commit = (prefix: string): string => prefix.padEnd(40, '0');

describe('what a running gate keeps', () => {
  it('makes a second gate on the commit wait instead of erasing the logs of the first', async () => {
    const project = await makeEngineProject(dir());
    const sha = commit('ab');
    await withGateRun(project, sha, 0, async () => {
      const mine = await prepareGateDir(project, sha);
      await mkdir(mine, { recursive: true });
      await writeFile(join(mine, 'output.log'), 'still running\n');
      // Another commit sharing the slot waits as well.
      await expect(
        withGateRun(project, commit('ab1'), 0, () => Promise.resolve('ran'))
      ).rejects.toMatchObject({ code: 'lock-timeout' });
      await expect(
        withGateRun(project, sha, 0, () => Promise.resolve('ran'))
      ).rejects.toMatchObject({
        code: 'lock-timeout',
      });
      expect(await exists(join(mine, 'output.log'))).toBe(true);
    });
    expect(await withGateRun(project, sha, 0, () => Promise.resolve('ran'))).toBe('ran');
  });

  it('never drops the run another gate still holds when it prunes older ones', async () => {
    const project = await makeEngineProject(dir());
    const root = join(project.paths.stateDir, 'gate');
    const names = ['01', '02', '03', '04', '05', '06'].map(commit);
    for (const [index, name] of names.entries()) {
      await mkdir(join(root, name), { recursive: true });
      const at = new Date(Date.now() - (names.length - index) * 60_000);
      await utimes(join(root, name), at, at);
    }
    const kept = async (): Promise<string[]> =>
      (await readdir(root)).filter((name) => /^[0-9a-f]{40}$/.test(name)).sort();
    const fresh = commit('ff');
    const oldest = names[0] ?? '';
    await withGateRun(project, oldest, 0, async () => {
      await withGateRun(project, fresh, 0, async () => {
        await prepareGateDir(project, fresh);
      });
    });
    // The newest four others stay, and so does the oldest, which another gate held.
    expect(await kept()).toEqual([oldest, ...names.slice(2)]);
    expect(await exists(gateDir(project, fresh))).toBe(false);

    await withGateRun(project, fresh, 0, async () => {
      await prepareGateDir(project, fresh);
    });
    expect(await kept()).toEqual(names.slice(2));
  });

  it('gives a feedback run that finds the directory in use another one, and empties it when free', async () => {
    const project = await makeEngineProject(dir());
    const root = join(project.paths.stateDir, 'gate');
    await withFeedbackDir(project, 0, async (first) => {
      expect(first).toBe(join(root, 'feedback'));
      await mkdir(first, { recursive: true });
      await writeFile(join(first, 'output.log'), 'first run\n');
      await withFeedbackDir(project, 0, async (second) => {
        expect(second).toBe(join(root, 'feedback-1'));
        await mkdir(second, { recursive: true });
      });
      expect(await exists(join(first, 'output.log'))).toBe(true);
    });
    await withFeedbackDir(project, 0, async (again) => {
      expect(again).toBe(join(root, 'feedback'));
      expect(await exists(join(again, 'output.log'))).toBe(false);
    });
  });
});

const passed = (id: string): GateEntry => ({ id, status: 'pass', detail: 'ok', durationMs: 1 });

describe('a gate that outlives its caller', () => {
  it('makes a second gate on the commit wait for the first and read what it recorded', async () => {
    const project = await makeEngineProject(dir());
    const sha = commit('cd');
    const tree = commit('ee');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = withGateRun(project, sha, undefined, async () => {
      started();
      await held;
      await writeResult(project, { commit: sha, tree, pass: true, entries: [passed('check')] });
    });
    await running;
    let read: unknown = 'not yet';
    const second = withGateRun(project, sha, 30_000, async () => {
      read = await readResumable(project, sha, tree, 'any');
      return 'second';
    });
    await sleep(100);
    expect(read).toBe('not yet');
    release();
    await first;
    expect(await second).toBe('second');
    // The second gate saw the first one's result, not an empty directory.
    expect(read).toMatchObject({ why: expect.stringContaining('declaration') as string });
  });

  it('shows the holder and the entry it is on, and no one once it is done', async () => {
    const project = await makeEngineProject(dir());
    const sha = commit('ab');
    expect(await readRunningGates(project)).toEqual([]);
    await withGateRun(project, sha, 0, async () => {
      const recorder = await openRunRecord(project, {
        commit: sha,
        tree: commit('ee'),
        declaration: 'd',
        full: true,
        order: ['check', 'build', 'lane:a'],
        carried: [],
      });
      expect(await readRunningGates(project)).toMatchObject([
        { pid: process.pid, kind: 'full', commit: sha },
      ]);
      expect((await readRunningGates(project))[0]?.entry).toBeUndefined();
      await recorder.begin('build');
      expect(await readRunPosition(project, sha, process.pid)).toMatchObject({
        id: 'build',
        position: 2,
        total: 3,
      });
      // A record that another process wrote is not this holder's progress.
      expect(await readRunPosition(project, sha, process.pid + 1)).toBeUndefined();
      await recorder.complete(passed('build'));
      expect(await readRunPosition(project, sha, process.pid)).toBeUndefined();
      await recorder.close();
    });
    expect(await readRunningGates(project)).toEqual([]);
    await withFeedbackDir(project, 0, async () => {
      expect(await readRunningGates(project)).toMatchObject([
        { pid: process.pid, kind: 'feedback' },
      ]);
    });
  });

  it('leaves a record of each entry that ended for a gate that was killed, under the same declaration only', async () => {
    const project = await makeEngineProject(dir());
    const sha = commit('ab');
    const tree = commit('ee');
    const declaration = declarationHash({ lanes: [{ id: 'a' }] });
    const killed = await openRunRecord(project, {
      commit: sha,
      tree,
      declaration,
      full: true,
      order: ['check', 'build', 'lane:a', 'lane:b'],
      carried: [],
    });
    await killed.complete(passed('check'));
    await killed.complete(passed('lane:a'));
    // The process dies here: nothing closes the record.
    expect(await readResumable(project, sha, tree, declaration)).toMatchObject({
      how: 'interrupted',
      entries: [{ id: 'check' }, { id: 'lane:a' }],
    });
    expect(await readResumable(project, sha, tree, declarationHash({ lanes: [] }))).toEqual({
      why: 'the gate declaration changed since the recorded run',
    });
    expect(await readResumable(project, sha, commit('ff'), declaration)).toEqual({
      why: 'the recorded run is for another tree',
    });
    expect(await readResumable(project, commit('cd'), tree, declaration)).toEqual({
      why: 'no full run of this commit is recorded in this checkout',
    });
    const text = await readFile(join(gateDir(project, sha), 'progress.json'), 'utf8');
    await writeFile(
      join(gateDir(project, sha), 'progress.json'),
      text.replace('"full": true', '"full": false')
    );
    expect(await readResumable(project, sha, tree, declaration)).toMatchObject({
      why: expect.any(String) as string,
    });
  });

  it('hashes a declaration by content, not by the order of its keys', () => {
    expect(declarationHash({ lanes: [{ id: 'a', files: ['x'] }], build: 'ui' })).toBe(
      declarationHash({ build: 'ui', lanes: [{ files: ['x'], id: 'a' }] })
    );
    expect(declarationHash({ lanes: [{ id: 'a' }] })).not.toBe(
      declarationHash({ lanes: [{ id: 'b' }] })
    );
  });

  it('never lets a record that cannot be written fail the run', async () => {
    const project = await makeEngineProject(dir());
    const sha = commit('ab');
    // A file where the run's directory belongs makes every write fail.
    await mkdir(join(project.paths.stateDir, 'gate'), { recursive: true });
    await writeFile(gateDir(project, sha), 'not a directory');
    const recorder = await openRunRecord(project, {
      commit: sha,
      tree: commit('ee'),
      declaration: 'd',
      full: true,
      order: ['check'],
      carried: [],
    });
    await recorder.begin('check');
    await recorder.complete(passed('check'));
    await recorder.interrupted('check', undefined);
    await recorder.close();
  });
});
