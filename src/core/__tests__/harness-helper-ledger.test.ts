// SPDX-License-Identifier: EUPL-1.2
/**
 * The next run's reap of what a killed run recorded, with real processes: only
 * an entry whose writer is gone and whose process still matches its recorded
 * identity, objdir and shape is ever signalled.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createLoggerMock()
);

import {
  type ProcessBirth,
  processHasExitedAsync,
  processIdentity,
  sameProcess,
} from '../../utils/process-birth.js';
import { sleep } from '../../utils/sleep.js';
import {
  createHelperPidTracker,
  openHelperLedger,
  settleDeadRunHelpers,
  wantsOrphanReap,
} from '../harness-helper-pids.js';

describe('settleDeadRunHelpers', () => {
  let root: string;
  let ledgers: string;
  let objDir: string;
  const children: ChildProcess[] = [];

  /** A process whose `ps` command line reads as the harness's xpcshell under `dir`. */
  const startHelper = async (dir: string): Promise<ProcessBirth> => {
    const child = spawn('/bin/sleep', ['60'], {
      argv0: join(dir, 'dist', 'bin', 'xpcshell'),
      stdio: 'ignore',
    });
    children.push(child);
    await new Promise((resolve) => child.once('spawn', resolve));
    await sleep(50);
    const identity = processIdentity(child.pid as number);
    if (identity === undefined) throw new Error('helper has no identity');
    return identity;
  };

  /** The identity a process had, once it has exited. */
  const deadOwner = async (): Promise<ProcessBirth> => {
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('spawn', resolve));
    await sleep(50);
    const identity = processIdentity(child.pid as number);
    if (identity === undefined) throw new Error('owner has no identity');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    return identity;
  };

  const writeLedger = async (owner: ProcessBirth, helpers: ProcessBirth[]): Promise<string> => {
    await mkdir(ledgers, { recursive: true });
    const file = join(ledgers, `${owner.pid}-1.jsonl`);
    const lines = [
      { owner },
      ...helpers.map((identity) => ({ pid: identity.pid, kind: 'Server', identity })),
    ];
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return file;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-ledger-'));
    ledgers = join(root, '.fireforge', 'harness-helpers');
    objDir = join(root, 'engine', 'obj-x');
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  it('terminates what a dead run recorded, counts it, and removes the ledger', async () => {
    const helper = await startHelper(objDir);
    const file = await writeLedger(await deadOwner(), [helper]);
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(1);
    expect(sameProcess(helper)).toBe(false);
    await expect(access(file)).rejects.toThrow();
  });

  it('signals nothing under the report posture, and keeps the record', async () => {
    const helper = await startHelper(objDir);
    const file = await writeLedger(await deadOwner(), [helper]);
    await expect(settleDeadRunHelpers(root, objDir, { reap: false })).resolves.toBe(0);
    await expect(processHasExitedAsync(helper)).resolves.toBe(false);
    await expect(access(file)).resolves.toBeUndefined();
  });

  it('never touches the helpers of a run that is still alive', async () => {
    const helper = await startHelper(objDir);
    const owner = processIdentity(process.pid) as ProcessBirth;
    const file = await writeLedger(owner, [helper]);
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(0);
    await expect(processHasExitedAsync(helper)).resolves.toBe(false);
    await expect(access(file)).resolves.toBeUndefined();
  });

  it('leaves a helper under a sibling objdir alone', async () => {
    const helper = await startHelper(join(root, 'engine', 'obj-sibling'));
    await writeLedger(await deadOwner(), [helper]);
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(0);
    await expect(processHasExitedAsync(helper)).resolves.toBe(false);
  });

  it('leaves a process whose pid was recycled alone', async () => {
    const helper = await startHelper(objDir);
    const file = await writeLedger(await deadOwner(), [
      { pid: helper.pid, start: 'an earlier life' },
    ]);
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(0);
    await expect(processHasExitedAsync(helper)).resolves.toBe(false);
    await expect(access(file)).rejects.toThrow();
  });

  it('leaves a helper-shaped process no ledger names alone', async () => {
    const helper = await startHelper(objDir);
    await writeLedger(await deadOwner(), []);
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(0);
    await expect(processHasExitedAsync(helper)).resolves.toBe(false);
  });

  it('keeps the ledger while a named helper cannot be shown to have exited', async () => {
    const helper = await startHelper(objDir);
    const file = await writeLedger(await deadOwner(), [helper]);
    await expect(settleDeadRunHelpers(root, objDir, { reap: false })).resolves.toBe(0);
    await expect(access(file)).resolves.toBeUndefined();
  });

  it('reads a ledger a killed writer left half-written', async () => {
    const helper = await startHelper(objDir);
    const file = await writeLedger(await deadOwner(), [helper]);
    await writeFile(file, `${(await readFile(file)).toString()}{"pid":12`);
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(1);
  });

  it('is a no-op for a project with no ledgers', async () => {
    await expect(settleDeadRunHelpers(root, objDir, { reap: true })).resolves.toBe(0);
  });

  it('writes what the tracker sees and removes it when the dispatch ends', async () => {
    const helper = await startHelper(objDir);
    const ledger = openHelperLedger(root);
    const tracker = createHelperPidTracker((entry) => {
      ledger?.record(entry);
    });
    tracker.feed('stdout', `INFO runtests.py | Server pid: ${helper.pid}\n`);
    const [name] = await readdir(ledgers);
    expect(name).toMatch(new RegExp(`^${process.pid}-`));
    ledger?.close();
    await expect(readdir(ledgers)).resolves.toEqual([]);
  });

  it('survives the writer being killed outright', async () => {
    const script = `
      const { openHelperLedger, createHelperPidTracker } = await import(${JSON.stringify(
        new URL('../harness-helper-pids.ts', import.meta.url).pathname
      )});
      const ledger = openHelperLedger(${JSON.stringify(root)});
      ledger.record({ pid: 1, kind: 'Server', identity: { pid: 1, start: 'x' } });
      process.kill(process.pid, 'SIGKILL');
    `;
    const killed = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: new URL('../../..', import.meta.url).pathname,
      }
    );
    expect(killed.signal).toBe('SIGKILL');
    await expect(readdir(ledgers)).resolves.toHaveLength(1);
    await settleDeadRunHelpers(root, objDir, { reap: false });
    await expect(readdir(ledgers)).resolves.toEqual([]);
  });
});

describe('wantsOrphanReap', () => {
  it.each([
    [{}, undefined, false],
    [{}, 'report', false],
    [{}, 'reap', true],
    [{}, 'owned', true],
    [{ reapOrphans: true }, 'report', true],
  ] as const)('%j with test.reapOrphans %s is %s', (options, posture, expected) => {
    const config = { test: posture === undefined ? {} : { reapOrphans: posture } };
    expect(wantsOrphanReap(options, config as never)).toBe(expected);
  });
});
