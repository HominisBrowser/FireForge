// SPDX-License-Identifier: EUPL-1.2
/** The claim's lost races, forced deterministically rather than left to a real collision. */
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimDirectory, SlotBusyError } from '../slot-lock.js';

/** Runs before a claim generation is linked; returns true to report that name taken instead. */
let beforeLink: ((target: string) => Promise<boolean>) | undefined;

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (from: string, to: string): Promise<void> => {
      if (/exclusive\.\d+$/.test(to) && (await beforeLink?.(to)) === true) {
        throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' });
      }
      await real.link(from, to);
    },
  };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fireforge-slot-lock-races-'));
});
afterEach(async () => {
  beforeLink = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe('a claim that loses a race', () => {
  it('tries the next generation when another contender linked the same one first', async () => {
    let lost = false;
    beforeLink = () => {
      if (lost) return Promise.resolve(false);
      lost = true;
      return Promise.resolve(true);
    };
    const release = await claimDirectory(directory, 'Slot a');
    expect(lost).toBe(true);
    expect(await readdir(directory)).toContain('exclusive.1');
    await release();
  });

  it('withdraws a generation a higher one overtook, then takes the next', async () => {
    let overtaken = false;
    beforeLink = async (target) => {
      if (overtaken || !target.endsWith('exclusive.1')) return false;
      overtaken = true;
      // A contender working from a fresher listing took generation 2 and let it go.
      await writeFile(join(directory, 'exclusive.2'), '{}');
      await fs.link(join(directory, 'exclusive.2'), join(directory, 'exclusive.2.free'));
      return false;
    };
    const release = await claimDirectory(directory, 'Slot a');
    const names = await readdir(directory);
    expect(names).toContain('exclusive.3');
    expect(names).not.toContain('exclusive.1');
    await release();
  });

  it('passes on a link failure that is not a lost race', async () => {
    beforeLink = () =>
      Promise.reject(Object.assign(new Error('EACCES: not permitted'), { code: 'EACCES' }));
    await expect(claimDirectory(directory, 'Slot a')).rejects.toThrow(/EACCES/);
  });

  it('gives up as contended when every generation it tries is taken', async () => {
    beforeLink = () => Promise.resolve(true);
    await expect(claimDirectory(directory, 'Slot a')).rejects.toThrow(SlotBusyError);
    await expect(claimDirectory(directory, 'Slot a')).rejects.toThrow(/Slot a is contended/);
    // Nothing of the failed attempts is left as a claim.
    expect((await readdir(directory)).filter((name) => name.startsWith('exclusive.'))).toEqual([]);
  });
});
