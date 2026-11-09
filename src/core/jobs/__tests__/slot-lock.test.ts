// SPDX-License-Identifier: EUPL-1.2
/** The exclusive claim every slot mutation takes, against real files and real processes. */
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { processIdentityAsync } from '../process.js';
import {
  acquireSlot,
  claimDirectory,
  claimHolder,
  ClaimReplacedError,
  SlotBusyError,
} from '../slot-lock.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fireforge-slot-lock-'));
  directories.push(path);
  return path;
}

/** The identity of a process that has really exited. */
async function deadOwner(): Promise<{ pid: number; start: string }> {
  const child = spawn('sleep', ['5'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const identity = await processIdentityAsync(child.pid ?? 0);
  child.kill('SIGKILL');
  await once(child, 'exit');
  if (identity === undefined) throw new Error('No identity');
  return identity;
}

describe.skipIf(process.platform === 'win32')('a slot claim', () => {
  it('names the live holder and its job', async () => {
    const root = await directory();
    const release = await claimDirectory(root, 'Slot a', { jobId: 'the-job' });
    await expect(claimDirectory(root, 'Slot a')).rejects.toThrow(
      new RegExp(`Slot a is in use by process ${String(process.pid)} \\(job the-job\\)`)
    );
    await release();
    const again = await claimDirectory(root, 'Slot a');
    await again();
  });

  it('takes over from a holder that has exited, leaving its claim out of the way', async () => {
    const root = await directory();
    await writeFile(
      join(root, 'exclusive.7'),
      JSON.stringify({ owner: await deadOwner(), nonce: 'old' })
    );
    const release = await claimDirectory(root, 'Slot a');
    const claim = JSON.parse(await readFile(join(root, 'exclusive.8'), 'utf8')) as {
      nonce: string;
    };
    expect(claim.nonce).not.toBe('old');
    await expect(readFile(join(root, 'exclusive.7'))).rejects.toThrow(/ENOENT/);
    await release();
    expect((await readdir(root)).sort()).toEqual(['exclusive.8', 'exclusive.8.free']);
  });

  it('refuses a claim it cannot read rather than assuming it is free', async () => {
    const root = await directory();
    await writeFile(join(root, 'exclusive.1'), 'not json');
    const refused = claimDirectory(root, 'Slot a');
    await expect(refused).rejects.toBeInstanceOf(SlotBusyError);
    await expect(refused).rejects.toThrow(/unreadable lock/);
    expect(await readFile(join(root, 'exclusive.1'), 'utf8')).toBe('not json');
  });

  it('will not release a claim it can no longer read, and names no holder from one', async () => {
    const claim = await directory();
    const release = await claimDirectory(claim, 'Fixture');
    const generations = (await readdir(claim)).filter((name) => !name.endsWith('.free'));
    expect(generations.length).toBeGreaterThan(0);
    for (const name of generations) await writeFile(join(claim, name), '{broken');
    expect(await claimHolder(claim)).toBeUndefined();
    await expect(release()).rejects.toThrow(ClaimReplacedError);
  });

  it('will not release a claim someone else now holds', async () => {
    const root = await directory();
    const release = await claimDirectory(root, 'Slot a');
    await writeFile(join(root, 'exclusive.2'), JSON.stringify({ nonce: 'other' }));
    await expect(release()).rejects.toBeInstanceOf(ClaimReplacedError);
    await expect(readFile(join(root, 'exclusive.2.free'))).rejects.toThrow(/ENOENT/);
  });

  it('lets go without writing any new data, so a full disk cannot strand it', async () => {
    const root = await directory();
    const release = await claimDirectory(root, 'Slot a');
    await release();
    const [claim, free] = await Promise.all([
      stat(join(root, 'exclusive.1')),
      stat(join(root, 'exclusive.1.free')),
    ]);
    expect(free.ino).toBe(claim.ino);
  });

  // Real processes, a real barrier. Holders write their own interval, so an overlap cannot hide.
  it('has one holder at a time among six processes racing for a dead claim', async () => {
    const worker = fileURLToPath(new URL('../slot-lock.ts', import.meta.url));
    const loader = fileURLToPath(new URL('../source-loader-bootstrap.cjs', import.meta.url));
    const script = `
      import { claimDirectory } from ${JSON.stringify(worker)};
      const [root, barrier] = process.argv.slice(1);
      while (Date.now() < Number(barrier));
      try {
        const release = await claimDirectory(root, 'Slot');
        const start = Date.now();
        await new Promise((settle) => setTimeout(settle, 150));
        const end = Date.now();
        await release();
        console.log(JSON.stringify([start, end]));
      } catch (error) {
        console.log(JSON.stringify(error.name));
      }
    `;
    const contender = (root: string, barrier: number): Promise<string> =>
      new Promise((settle) => {
        execFile(
          process.execPath,
          ['--import', loader, '--input-type=module', '-e', script, root, String(barrier)],
          { encoding: 'utf8' },
          (_error, stdout) => {
            settle(stdout.trim());
          }
        );
      });
    for (let round = 0; round < 8; round += 1) {
      const root = await directory();
      await writeFile(
        join(root, 'exclusive.1'),
        JSON.stringify({ owner: { pid: 2 ** 22 + 13, start: 'gone' }, nonce: 'dead' })
      );
      const barrier = Date.now() + 1_200;
      const results = await Promise.all(Array.from({ length: 6 }, () => contender(root, barrier)));
      const held = results
        .filter((line) => line.startsWith('['))
        .map((line) => JSON.parse(line) as [number, number])
        .sort((a, b) => a[0] - b[0]);
      expect(held.length, results.join(' | ')).toBeGreaterThanOrEqual(1);
      for (const [index, interval] of held.entries())
        if (index > 0) expect(interval[0]).toBeGreaterThanOrEqual(held[index - 1]?.[1] ?? 0);
      for (const line of results)
        if (!line.startsWith('[')) expect(line, results.join(' | ')).toBe('"SlotBusyError"');
      expect((await readdir(root)).filter((name) => name.includes('stale'))).toEqual([]);
    }
  }, 120_000);
});

describe.skipIf(process.platform === 'win32')('acquiring a slot', () => {
  it('leaves nothing behind for a name that was never a slot', async () => {
    const namespace = await directory();
    await expect(acquireSlot(namespace, 'typo')).rejects.toThrow(/does not exist/);
    const release = await acquireSlot(namespace, 'made', undefined, { create: true });
    await release();
    await mkdir(join(namespace, 'slots', 'a'), { recursive: true });
    const held = await acquireSlot(namespace, 'a', { jobId: 'j' });
    await expect(acquireSlot(namespace, 'a')).rejects.toBeInstanceOf(SlotBusyError);
    await held();
  });
});
