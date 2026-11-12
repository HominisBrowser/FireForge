// SPDX-License-Identifier: EUPL-1.2
/**
 * Transactions against real files. A crash is reproduced by leaving the
 * journal a killed process would have left: see `crashedJournal`.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import { exists } from './fs.js';
import { inspectJournal, recoverJournal, type Transaction, transaction } from './journal.js';
import * as log from './log.js';
import { resetShutdown, runShutdown } from './signals.js';

const dir = useTempDir();
const work = (path = ''): string => join(dir(), 'work', path);
const journal = (): string => join(dir(), 'state', 'change.journal');
const logged: string[] = [];
let previousLog: log.LogConfig = {};

beforeEach(async () => {
  logged.length = 0;
  previousLog = log.configureLog({ write: (text) => logged.push(text), verbose: true });
  await writeTree(work(), { 'a.txt': 'a1', 'sub/b.txt': 'b1', 'sub/deep/c.txt': 'c1' });
});

afterEach(() => {
  resetShutdown();
  log.configureLog(previousLog);
});

const BEFORE = { 'a.txt': 'a1', 'sub/b.txt': 'b1', 'sub/deep/c.txt': 'c1' };

/**
 * Runs `body` in a transaction and then stops as a killed process would:
 * changes on disk, journal on disk, nothing undone. The journal is rewritten
 * to name a process that no longer exists.
 */
async function crashedJournal(body: (tx: Transaction) => Promise<void>): Promise<void> {
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(dead, 'exit');
  let snapshot = '';
  const copies = new Map<string, Buffer>();
  await transaction(journal(), 'the crashed update', async (tx) => {
    await body(tx);
    snapshot = await readFile(journal(), 'utf8');
    for (const name of await readdir(`${journal()}.d`).catch(() => [])) {
      copies.set(name, await readFile(join(`${journal()}.d`, name)));
    }
  });
  for (const [name, bytes] of copies) await writeTree(`${journal()}.d`, { [name]: bytes });
  const [header = '', ...entries] = snapshot.split('\n');
  const forged = JSON.stringify({
    ...(JSON.parse(header) as object),
    pid: dead.pid,
    start: 'gone',
  });
  await writeFile(journal(), [forged, ...entries].join('\n'));
}

describe('commit', () => {
  it('keeps every change and deletes the journal', async () => {
    const result = await transaction(journal(), 'the update', async (tx) => {
      await tx.write(work('a.txt'), 'a2');
      await tx.write(work('new/dir/n.txt'), Buffer.from('n1'));
      await tx.remove(work('sub/deep'));
      expect(await exists(journal())).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await readTree(work())).toEqual({
      'a.txt': 'a2',
      'sub/b.txt': 'b1',
      'new/dir/n.txt': 'n1',
    });
    expect(await exists(journal())).toBe(false);
    expect(await inspectJournal(journal())).toBeUndefined();
  });

  // Windows has no POSIX permission bits.
  it.skipIf(process.platform === 'win32')(
    "sets a mode when asked and otherwise keeps the replaced file's",
    async () => {
      await chmod(work('a.txt'), 0o755);
      await transaction(journal(), 'the update', async (tx) => {
        await tx.write(work('a.txt'), 'a2');
        await tx.write(work('tool'), '#!/bin/sh\n', { mode: 0o700 });
      });
      expect((await stat(work('a.txt'))).mode & 0o777).toBe(0o755);
      expect((await stat(work('tool'))).mode & 0o777).toBe(0o700);
    }
  );

  it('refuses a relative path as a bug in the caller', async () => {
    await expect(
      transaction(journal(), 'the update', (tx) => tx.write('relative.txt', 'x'))
    ).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('rollback when the body throws', () => {
  it("restores contents and modes, removes what was added, and rethrows the body's error", async () => {
    await chmod(work('sub/b.txt'), 0o640);
    await expect(
      transaction(journal(), 'the update', async (tx) => {
        await tx.write(work('a.txt'), 'a2');
        await tx.write(work('a.txt'), 'a3');
        await tx.write(work('sub/b.txt'), 'b2', { mode: 0o755 });
        await tx.write(work('new/dir/n.txt'), 'n1');
        throw new Error('step 4 failed');
      })
    ).rejects.toThrow('step 4 failed');
    expect(await readTree(work())).toEqual(BEFORE);
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32')
      expect((await stat(work('sub/b.txt'))).mode & 0o777).toBe(0o640);
    expect(await exists(work('new'))).toBe(false);
    expect(await exists(journal())).toBe(false);
  });

  it('brings back a removed tree, empty directories and symlinks included', async () => {
    await mkdir(work('sub/empty'));
    await chmod(work('sub/empty'), 0o750);
    await symlink('b.txt', work('sub/link'));
    await expect(
      transaction(journal(), 'the removal', async (tx) => {
        await tx.remove(work('sub'));
        await tx.remove(work('a.txt'));
        await tx.remove(work('never-existed'));
        expect(await readdir(work())).toEqual([]);
        throw new Error('changed my mind');
      })
    ).rejects.toThrow('changed my mind');
    expect(await readTree(work())).toEqual(BEFORE);
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32')
      expect((await stat(work('sub/empty'))).mode & 0o777).toBe(0o750);
    expect(await readlink(work('sub/link'))).toBe('b.txt');
  });

  it('undoes changes made by other means to the paths that were named', async () => {
    await expect(
      transaction(journal(), 'the deployment', async (tx) => {
        await tx.change(
          [work('a.txt'), work('sub'), work('generated/out.txt'), work('absent')],
          async () => {
            await writeFile(work('a.txt'), 'rewritten by a tool');
            await writeFile(work('sub/b.txt'), 'b2');
            await writeFile(work('sub/deep/c.txt'), 'c2');
            await mkdir(work('generated'), { recursive: true });
            await writeFile(work('generated/out.txt'), 'out');
            await mkdir(work('absent/tree'), { recursive: true });
            await writeFile(work('absent/tree/x.txt'), 'x');
          }
        );
        throw new Error('validation failed');
      })
    ).rejects.toThrow('validation failed');
    expect(await readTree(work())).toEqual(BEFORE);
    expect(await readdir(work())).toEqual(['a.txt', 'sub']);
  });

  it('restores a file that was replaced by a directory, and the reverse', async () => {
    await expect(
      transaction(journal(), 'the reshape', async (tx) => {
        await tx.remove(work('a.txt'));
        await tx.write(work('a.txt/inside.txt'), 'now a directory');
        await tx.remove(work('sub'));
        await tx.write(work('sub'), 'now a file');
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect(await readTree(work())).toEqual(BEFORE);
  });

  it('replaces a symlink without touching its target, and puts the link back', async () => {
    await symlink(work('a.txt'), work('link'));
    await expect(
      transaction(journal(), 'the update', async (tx) => {
        await tx.write(work('link'), 'a real file now');
        expect(await readFile(work('a.txt'), 'utf8')).toBe('a1');
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect((await lstat(work('link'))).isSymbolicLink()).toBe(true);
    expect(await readFile(work('a.txt'), 'utf8')).toBe('a1');
  });

  it('removes a directory it created on the way even when a later change names it', async () => {
    await expect(
      transaction(journal(), 'the update', async (tx) => {
        await tx.write(work('made/one.txt'), '1');
        await tx.change([work('made')], () => writeFile(work('made/two.txt'), '2'));
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect(await exists(work('made'))).toBe(false);
  });

  it('never restores through a symlink that replaced a directory', async () => {
    await mkdir(join(dir(), 'outside'));
    await expect(
      transaction(journal(), 'the reshape', async (tx) => {
        await tx.change([work('sub')], async () => {
          await rm(work('sub'), { recursive: true });
          await symlink(join(dir(), 'outside'), work('sub'));
        });
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect(await readTree(work())).toEqual(BEFORE);
    expect((await lstat(work('sub'))).isDirectory()).toBe(true);
    expect(await readdir(join(dir(), 'outside'))).toEqual([]);
  });

  it('keeps before-images as file copies beside the journal, not in it, and removes them', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0xab);
    await writeFile(work('big.bin'), big);
    await expect(
      transaction(journal(), 'the update', async (tx) => {
        await tx.write(work('big.bin'), 'small');
        expect((await stat(journal())).size).toBeLessThan(4096);
        expect(await readdir(`${journal()}.d`)).toHaveLength(1);
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect((await readFile(work('big.bin'))).equals(big)).toBe(true);
    expect(await exists(`${journal()}.d`)).toBe(false);
    await transaction(journal(), 'the update', (tx) => tx.write(work('big.bin'), 'small'));
    expect(await exists(`${journal()}.d`)).toBe(false);
  });

  // Windows does not make a directory read-only through its mode.
  it.skipIf(process.platform === 'win32')(
    "keeps the journal and the body's error when the undo itself fails",
    async () => {
      const failure = await transaction(journal(), 'the update', async (tx) => {
        await tx.write(work('sub/b.txt'), 'b2');
        // The undo will need to write into `sub`, which is no longer writable.
        await chmod(work('sub'), 0o500);
        throw new Error('original failure');
      }).catch((error: unknown) => error);
      await chmod(work('sub'), 0o755);
      expect(failure).toMatchObject({ message: 'original failure' });
      if (process.getuid?.() === 0) return;
      expect(logged.join('')).toContain('Could not undo the update');
      expect(await inspectJournal(journal())).toMatchObject({
        label: 'the update',
        paths: [work('sub/b.txt')],
      });
      // The next transaction on this journal finishes the undo first.
      await transaction(journal(), 'the next update', (tx) => tx.write(work('a.txt'), 'a2'));
      expect(await readTree(work())).toEqual({ ...BEFORE, 'a.txt': 'a2' });
    }
  );
});

describe('interrupts', () => {
  it('rolls back in the pipeline, lets a running step finish first, and refuses further steps', async () => {
    let reached = '';
    let started: () => void = () => undefined;
    let proceed: () => void = () => undefined;
    const inStep = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mayFinish = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const running = transaction(journal(), 'the long update', async (tx) => {
      await tx.write(work('a.txt'), 'a2');
      await tx.change([work('sub/b.txt')], async () => {
        started();
        await mayFinish;
        await writeFile(work('sub/b.txt'), 'written late');
      });
      reached = 'after the interrupted step';
      await tx.write(work('sub/deep/c.txt'), 'c2');
      reached = 'past the end';
    }).catch((error: unknown) => error);
    await inStep;
    const shutdown = runShutdown('SIGINT');
    proceed();
    await shutdown;
    // The pipeline is done: the old state is back although the body was mid-step.
    expect(await readTree(work())).toEqual(BEFORE);
    expect(await exists(journal())).toBe(false);
    expect(await running).toMatchObject({ code: 'interrupted' });
    expect(reached).toBe('after the interrupted step');
  });

  it('starts no further step once an interrupt has arrived', async () => {
    let started: () => void = () => undefined;
    let proceed: () => void = () => undefined;
    const inBody = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mayContinue = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const running = transaction(journal(), 'the update', async (tx) => {
      started();
      await mayContinue;
      await tx.write(work('a.txt'), 'a2');
    }).catch((error: unknown) => error);
    await inBody;
    const shutdown = runShutdown('SIGINT');
    proceed();
    await shutdown;
    expect(await running).toMatchObject({ code: 'interrupted' });
    expect(await readFile(work('a.txt'), 'utf8')).toBe('a1');
  });

  it('does not undo a transaction that committed before the signal', async () => {
    await transaction(journal(), 'the update', (tx) => tx.write(work('a.txt'), 'a2'));
    await runShutdown('SIGTERM');
    expect(await readFile(work('a.txt'), 'utf8')).toBe('a2');
  });
});

describe('recovery after a crash', () => {
  it('restores the old state before the next transaction on the same journal runs', async () => {
    await crashedJournal(async (tx) => {
      await tx.write(work('a.txt'), 'a2');
      await tx.remove(work('sub/deep'));
      await tx.write(work('new/n.txt'), 'n1');
    });
    expect(await inspectJournal(journal())).toMatchObject({
      label: 'the crashed update',
      ownerAlive: false,
      paths: expect.arrayContaining([
        work('a.txt'),
        work('sub/deep/c.txt'),
        work('new/n.txt'),
      ]) as string[],
    });
    // The crashed run committed in this simulation, so re-create its half-done state.
    await writeTree(work(), { 'a.txt': 'a2', 'new/n.txt': 'n1' });
    await transaction(journal(), 'the next update', async (tx) => {
      expect(await readTree(work())).toEqual(BEFORE);
      await tx.write(work('a.txt'), 'a3');
    });
    expect(await readTree(work())).toEqual({ ...BEFORE, 'a.txt': 'a3' });
    expect(logged.join('')).toContain('Undid an interrupted run of the crashed update');
  });

  it('recovers a change that was recorded but never made', async () => {
    await crashedJournal((tx) => tx.write(work('a.txt'), 'a2'));
    await writeFile(work('a.txt'), 'a1');
    expect(await recoverJournal(journal())).toBe(true);
    expect(await readTree(work())).toEqual(BEFORE);
    expect(await recoverJournal(journal())).toBe(false);
  });

  it('refuses to overwrite a file edited after the crash, naming the way out', async () => {
    await crashedJournal(async (tx) => {
      await tx.write(work('a.txt'), 'a2');
      await tx.write(work('sub/b.txt'), 'b2');
    });
    await writeFile(work('a.txt'), 'edited by hand since');
    await expect(recoverJournal(journal())).rejects.toMatchObject({
      code: 'journal-conflict',
      message: expect.stringContaining(work('a.txt')) as string,
    });
    // Nothing was restored by the refused attempt.
    expect(await readFile(work('sub/b.txt'), 'utf8')).toBe('b2');
    await expect(
      transaction(journal(), 'the next update', () => Promise.resolve())
    ).rejects.toMatchObject({
      code: 'journal-conflict',
      hint: expect.stringContaining('fireforge doctor --recover') as string,
    });
    // Put back as the run left it, the file no longer blocks the undo.
    await writeFile(work('a.txt'), 'a2');
    expect(await recoverJournal(journal())).toBe(true);
    expect(await readTree(work())).toEqual(BEFORE);
  });

  it('ignores a torn final record: its change was never started', async () => {
    await crashedJournal((tx) => tx.write(work('a.txt'), 'a2'));
    await writeFile(
      journal(),
      `${await readFile(journal(), 'utf8')}{"op":"save","path":"${work('sub/b.txt')}","bef`
    );
    expect(await recoverJournal(journal())).toBe(true);
    expect(await readTree(work())).toEqual(BEFORE);
  });

  it('removes a journal that holds no record at all', async () => {
    await mkdir(join(dir(), 'state'));
    await writeFile(journal(), '');
    expect(await recoverJournal(journal())).toBe(true);
    expect(await exists(journal())).toBe(false);
  });

  it('reports damage in the middle of a journal instead of guessing', async () => {
    await crashedJournal((tx) => tx.write(work('a.txt'), 'a2'));
    const [header = '', ...rest] = (await readFile(journal(), 'utf8')).split('\n');
    await writeFile(journal(), [header, 'not json', ...rest].join('\n'));
    await expect(recoverJournal(journal())).rejects.toMatchObject({ code: 'journal-corrupt' });
  });

  it('leaves the journal of a transaction that is still running alone', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      await crashedJournal((tx) => tx.write(work('a.txt'), 'a2'));
      const [header = '', ...rest] = (await readFile(journal(), 'utf8')).split('\n');
      // No recorded start: only the pid identifies the writer, and it is alive.
      const live = { ...(JSON.parse(header) as object), pid: other.pid, start: undefined };
      await writeFile(journal(), [JSON.stringify(live), ...rest].join('\n'));
      expect((await inspectJournal(journal()))?.ownerAlive).toBe(true);
      await expect(recoverJournal(journal())).rejects.toMatchObject({ code: 'journal-busy' });
      expect(await readFile(work('a.txt'), 'utf8')).toBe('a2');
    } finally {
      other.kill('SIGKILL');
    }
  });
});
