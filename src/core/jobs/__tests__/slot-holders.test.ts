// SPDX-License-Identifier: EUPL-1.2
/** Who holds a slot: lsof output and a procfs fixture tree everywhere, the real procfs on Linux. */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseLsofHolders, procfsSlotHolders } from '../slot-holders.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(join(directory, 'proc', '13', 'fd'), 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

/** A procfs-shaped tree: each process a directory of links, `maps` and `fdinfo`. */
async function fixture(): Promise<{ proc: string; slot: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-slot-holders-'));
  directories.push(directory);
  const proc = join(directory, 'proc');
  const slot = join(directory, 'slot');
  const process = async (
    pid: number,
    links: Record<string, string>,
    fds: Record<string, { path: string; flags: string }> = {},
    maps = ''
  ): Promise<void> => {
    const root = join(proc, String(pid));
    await mkdir(join(root, 'fd'), { recursive: true });
    await mkdir(join(root, 'fdinfo'), { recursive: true });
    for (const [name, target] of Object.entries(links)) await symlink(target, join(root, name));
    for (const [fd, { path, flags }] of Object.entries(fds)) {
      await symlink(path, join(root, 'fd', fd));
      await writeFile(join(root, 'fdinfo', fd), `pos:\t0\nflags:\t${flags}\nmnt_id:\t1\n`);
    }
    await writeFile(join(root, 'maps'), maps);
  };
  await process(10, { cwd: join(slot, 'engine'), root: '/', exe: '/bin/sh' });
  await process(11, { cwd: '/home' }, { '3': { path: join(slot, 'log'), flags: '0100001' } });
  await process(12, { cwd: '/home' }, { '4': { path: '/etc/hosts', flags: '0100000' } });
  await process(13, { cwd: '/home' });
  await process(
    14,
    { cwd: '/home' },
    { '5': { path: `${join(slot, 'gone')} (deleted)`, flags: '0100000' } },
    `7f00-7f10 r-xp 00000000 08:01 42 ${join(slot, 'obj/libxul.so')}\n`
  );
  await writeFile(join(proc, 'uptime'), '1 1\n');
  // Its open files are not ours to list, as for a process that made itself non-dumpable.
  await chmod(join(proc, '13', 'fd'), 0o000);
  return { proc, slot };
}

describe('procfsSlotHolders', () => {
  it('finds a working directory, a write, a deleted file and a mapping, and passes over an unreadable process', async () => {
    const { proc, slot } = await fixture();
    const holders = await procfsSlotHolders([slot], { procRoot: proc });
    expect(Object.fromEntries(holders ?? [])).toEqual({
      10: { writes: false, held: join(slot, 'engine') },
      11: { writes: true, held: join(slot, 'log') },
      14: { writes: false, held: join(slot, 'obj/libxul.so') },
    });
  });

  it('counts a named process it cannot read as a holder, and a gone one as nothing', async () => {
    const { proc, slot } = await fixture();
    const holders = await procfsSlotHolders([slot], { procRoot: proc, pids: [12, 13, 99] });
    expect([...(holders?.keys() ?? [])]).toEqual([13]);
  });

  it('says nothing for a host with no procfs', async () => {
    const { proc } = await fixture();
    expect(await procfsSlotHolders(['/x'], { procRoot: join(proc, 'absent') })).toBeUndefined();
  });

  it.runIf(process.platform === 'linux')(
    'sees a real process whose working directory is in the slot',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'fireforge-slot-holders-'));
      directories.push(directory);
      const slot = await realpath(directory);
      const child = spawn('sleep', ['30'], { cwd: slot, stdio: 'ignore' });
      try {
        await new Promise((resolve) => child.once('spawn', resolve));
        const holders = await procfsSlotHolders([slot]);
        expect(holders?.get(child.pid ?? 0)).toMatchObject({ writes: false });
        const named = await procfsSlotHolders([slot], { pids: [child.pid ?? 0] });
        expect([...(named?.keys() ?? [])]).toEqual([child.pid]);
      } finally {
        child.kill();
      }
    }
  );
});

describe('parseLsofHolders', () => {
  it('names each process with a file under the slot, and a write as a write', () => {
    const output = [
      'p10',
      'fcwd',
      'n/slots/a/engine',
      'p11',
      'f3',
      'ar',
      'n/etc/hosts',
      'f4',
      'au',
      'n/slots/a/log',
      'p12',
      'f5',
      'aw',
      'n/slots/ab/other',
      'p13',
      'f6',
      'aw',
      'n/private/slots/a',
      '',
    ].join('\n');
    expect(Object.fromEntries(parseLsofHolders(output, ['/slots/a', '/private/slots/a']))).toEqual({
      10: { writes: false, held: '/slots/a/engine' },
      11: { writes: true, held: '/slots/a/log' },
      13: { writes: true, held: '/private/slots/a' },
    });
  });
});
