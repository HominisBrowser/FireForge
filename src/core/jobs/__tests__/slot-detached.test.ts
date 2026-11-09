// SPDX-License-Identifier: EUPL-1.2
/** What a phase left detached, remembered by the slot and looked at again at each admission audit. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessObservation, ProcessSnapshot } from '../../../utils/process-birth.js';
import { processIdentityAsync } from '../process.js';
import { SlotIntegrityError } from '../slot-audit.js';
import {
  clearDetachedRecord,
  DETACHED_RECORD,
  DETACHED_RECORD_LIMIT,
  noteDetached,
  readDetachedRecord,
  recordDetached,
  reviewDetached,
} from '../slot-detached.js';
import { slotFootholdHolders } from '../slot-holders.js';
import { stopSlotOrphans } from '../slot-orphans.js';
import type { SlotRecord } from '../slot-types.js';
import { readJson, slotDirectory, writeDurable } from '../store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => Promise<boolean>, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Condition never held');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A namespace holding one slot record whose root is a plain directory. */
async function fixture(): Promise<{ base: string; namespace: string; slot: SlotRecord }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ff-detached-')));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const namespace = join(base, 'ns');
  const root = join(slotDirectory(namespace, 'a'), 'root');
  await mkdir(root, { recursive: true });
  const slot = { schemaVersion: 1, id: 'a', root, quarantined: null } as unknown as SlotRecord;
  await writeDurable(join(slotDirectory(namespace, 'a'), 'slot.json'), slot);
  return { base, namespace, slot };
}

const quarantined = async (namespace: string): Promise<string | null> =>
  (await readJson<SlotRecord>(join(slotDirectory(namespace, 'a'), 'slot.json'))).quarantined;

/**
 * Init's child, working outside the slot, whose command line names nothing of
 * it: it waits for `trigger`, then opens `target` and holds it. The paths come
 * through its environment.
 */
const DELAYED_WRITER = `
const fs = require('node:fs');
const wait = () => {
  if (!fs.existsSync(process.env.FF_TRIGGER)) return setTimeout(wait, 50);
  fs.openSync(process.env.FF_TARGET, 'w');
  setInterval(() => {}, 1000);
};
wait();
`;

async function delayedWriter(cwd: string, trigger: string, target: string): Promise<number> {
  const launcher = spawn(
    '/bin/sh',
    ['-c', `"${process.execPath}" -e "$FF_SCRIPT" >/dev/null 2>&1 </dev/null & echo $!`],
    {
      cwd,
      env: { ...process.env, FF_SCRIPT: DELAYED_WRITER, FF_TRIGGER: trigger, FF_TARGET: target },
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
  const exited = once(launcher, 'exit');
  const [output] = (await once(launcher.stdout, 'data')) as [Buffer];
  await exited;
  const pid = Number(output.toString().trim());
  cleanup.push(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already stopped.
    }
    return Promise.resolve();
  });
  return pid;
}

async function detachedEntry(pid: number): Promise<{ pid: number; group: number; start: string }> {
  const identity = await processIdentityAsync(pid);
  if (identity === undefined) throw new Error('Spawned process has no identity');
  return { pid, group: pid, start: identity.start };
}

describe('a process a phase left detached', () => {
  it('leaves the slot alone while footholdless, and quarantines it by name once it holds a file', async () => {
    const { base, namespace, slot } = await fixture();
    const trigger = join(base, 'trigger');
    const target = join(slot.root, 'late.txt');
    const pid = await delayedWriter(base, trigger, target);
    await recordDetached(namespace, 'a', 'job-1', [
      { ...(await detachedEntry(pid)), command: 'node delayed' },
    ]);

    await expect(reviewDetached(namespace, slot)).resolves.toBeUndefined();
    expect(await quarantined(namespace)).toBeNull();
    expect((await readDetachedRecord(namespace, 'a')).map((entry) => entry.pid)).toEqual([pid]);

    await writeFile(trigger, '');
    await until(async () => (await slotFootholdHolders([pid], [slot.root])).has(pid));
    const refusal = reviewDetached(namespace, slot);
    await expect(refusal).rejects.toBeInstanceOf(SlotIntegrityError);
    await expect(refusal).rejects.toThrow(
      new RegExp(
        `process ${String(pid)} \\(.+\\) left detached by job job-1, now holds .*late\\.txt`
      )
    );
    expect(await quarantined(namespace)).toMatch(/left detached by job job-1, now holds/);

    // It is an orphan by the rules `slot restore --stop-orphans` applies.
    const stopped = await stopSlotOrphans(namespace, slot.root, { graceMs: 3_000 });
    expect(stopped.map((entry) => entry.pid)).toEqual([pid]);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('is forgotten once it has gone, with no quarantine', async () => {
    const { base, namespace, slot } = await fixture();
    const pid = await delayedWriter(base, join(base, 'never'), join(slot.root, 'never.txt'));
    await recordDetached(namespace, 'a', 'job-1', [await detachedEntry(pid)]);
    process.kill(pid, 'SIGKILL');
    await until(() => Promise.resolve(!alive(pid)));

    await expect(reviewDetached(namespace, slot)).resolves.toBeUndefined();
    expect(await quarantined(namespace)).toBeNull();
    await expect(readFile(join(slotDirectory(namespace, 'a'), DETACHED_RECORD))).rejects.toThrow(
      /ENOENT/
    );
  }, 30_000);
});

describe('reviewDetached', () => {
  const observation = (pid: number, start: string): ProcessObservation => ({
    pid,
    start,
    parent: 1,
    group: pid,
  });
  const table =
    (...rows: ProcessObservation[]): (() => Promise<ProcessSnapshot>) =>
    () =>
      Promise.resolve(new Map(rows.map((row) => [row.pid, row])));

  it('never takes a reused pid for the process it remembers', async () => {
    const { namespace, slot } = await fixture();
    await recordDetached(namespace, 'a', 'job-1', [{ pid: 7001, group: 7001, start: 'born-1' }]);
    const holds = (): Promise<Map<number, { writes: boolean; held: string }>> =>
      Promise.resolve(new Map([[7001, { writes: true, held: join(slot.root, 'x') }]]));
    const commands = (): Promise<Map<number, string>> => Promise.resolve(new Map<number, string>());

    await reviewDetached(namespace, slot, {
      snapshot: table(observation(7001, 'born-2')),
      footholds: holds,
      commands,
    });
    expect(await quarantined(namespace)).toBeNull();
    expect(await readDetachedRecord(namespace, 'a')).toEqual([]);

    await recordDetached(namespace, 'a', 'job-2', [{ pid: 7001, group: 7001, start: 'born-1' }]);
    await expect(
      reviewDetached(namespace, slot, {
        snapshot: table(observation(7001, 'born-1')),
        footholds: holds,
        commands,
      })
    ).rejects.toThrow(/process 7001 \(command unreadable\) left detached by job job-2, now holds/);
  });

  it('quarantines one whose command line has come to name the slot', async () => {
    const { namespace, slot } = await fixture();
    await recordDetached(namespace, 'a', 'job-1', [
      { pid: 7002, group: 7002, start: 'b', command: 'daemon' },
    ]);
    await expect(
      reviewDetached(namespace, slot, {
        snapshot: table(observation(7002, 'b')),
        footholds: () => Promise.resolve(new Map()),
        commands: () => Promise.resolve(new Map([[7002, `daemon --dir ${slot.root}/engine`]])),
      })
    ).rejects.toThrow(/left detached by job job-1, now names the slot in its command line/);
  });

  it('keeps one still footholdless, drops the gone, and changes nothing without a census', async () => {
    const { namespace, slot } = await fixture();
    await recordDetached(namespace, 'a', 'job-1', [
      { pid: 7003, group: 7003, start: 'c' },
      { pid: 7004, group: 7004, start: 'd' },
    ]);
    await reviewDetached(namespace, slot, { snapshot: () => Promise.resolve(undefined) });
    expect(await readDetachedRecord(namespace, 'a')).toHaveLength(2);
    await reviewDetached(namespace, slot, {
      snapshot: table(observation(7003, 'c')),
      footholds: () => Promise.resolve(new Map()),
      commands: () => Promise.resolve(new Map([[7003, 'daemon']])),
    });
    expect((await readDetachedRecord(namespace, 'a')).map((entry) => entry.pid)).toEqual([7003]);
    expect(await quarantined(namespace)).toBeNull();
  });
});

describe('recordDetached', () => {
  it('identifies an entry without a birth while it lives, and skips one already gone', async () => {
    const { namespace } = await fixture();
    await recordDetached(
      namespace,
      'a',
      'job-1',
      [
        { pid: 7101, group: 7101 },
        { pid: 7102, group: 7102 },
      ],
      {
        snapshot: () =>
          Promise.resolve(new Map([[7101, { pid: 7101, start: 's', parent: 1, group: 7101 }]])),
      }
    );
    expect(await readDetachedRecord(namespace, 'a')).toMatchObject([
      { pid: 7101, start: 's', job: 'job-1' },
    ]);
  });

  it('keeps the newest entries within its limit, one per birth', async () => {
    const { namespace } = await fixture();
    const many = Array.from({ length: DETACHED_RECORD_LIMIT + 8 }, (_, index) => ({
      pid: 8000 + index,
      group: 8000 + index,
      start: 's',
    }));
    await recordDetached(namespace, 'a', 'job-1', many);
    const last = 8000 + DETACHED_RECORD_LIMIT + 7;
    await noteDetached(namespace, 'a', 'job-2', [{ pid: last, group: last, start: 's' }]);
    const kept = await readDetachedRecord(namespace, 'a');
    expect(kept).toHaveLength(DETACHED_RECORD_LIMIT);
    expect(kept[0]?.pid).toBe(8008);
    expect(kept.at(-1)).toMatchObject({ pid: last, job: 'job-2' });
    expect(kept.filter((entry) => entry.pid === last)).toHaveLength(1);
    await clearDetachedRecord(namespace, 'a');
    expect(await readDetachedRecord(namespace, 'a')).toEqual([]);
  });

  it('reads a damaged record as remembering nothing', async () => {
    const { namespace } = await fixture();
    await writeFile(join(slotDirectory(namespace, 'a'), DETACHED_RECORD), '{');
    expect(await readDetachedRecord(namespace, 'a')).toEqual([]);
  });
});
