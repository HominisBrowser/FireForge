// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { busiestOutsider, parseBusiest, sampleLoad } from './hostLoad.js';
import { attributeLoad, type LoadSources, renderLoad } from './load.js';

const LISTING = [
  '    1     0  0.1 /sbin/launchd',
  '  100     1  2.0 /Applications/Some App/Contents/MacOS/Some App',
  '  200     1  1.5 node',
  '  201   200 99.0 /usr/bin/python3',
  '  202   201 80.0 clang',
  '  300     1 55.5 /usr/bin/clang++',
  '  310   300 10.0 ld',
  '  400     1  0.0 idle',
  'garbage line',
].join('\n');

describe('parseBusiest', () => {
  it('names the busiest process outside the command own tree', () => {
    // 200 is the command: its children (201, 202) are its own work.
    expect(parseBusiest(LISTING, 200)).toEqual({ pid: 300, name: 'clang++', cpu: 55.5 });
  });

  it('keeps a name with spaces and drops the directory', () => {
    expect(
      parseBusiest('  100     1  2.0 /Applications/Some App/Contents/MacOS/Some App', 5)
    ).toEqual({ pid: 100, name: 'Some App', cpu: 2 });
  });

  it('reports nothing when no other process uses the CPU', () => {
    expect(parseBusiest('  400     1  0.0 idle\n', 5)).toBeUndefined();
    expect(parseBusiest('', 5)).toBeUndefined();
  });
});

describe('attributeLoad', () => {
  const sources = (load: number, calls: { busiest: number }): LoadSources => ({
    sample: () => ({ load, cpus: 10 }),
    busiest: () => {
      calls.busiest += 1;
      return Promise.resolve({ pid: 4242, name: 'clang', cpu: 310 });
    },
  });

  it('names the busiest process only when the load was above the CPU count', async () => {
    const calls = { busiest: 0 };
    const quiet = await attributeLoad({ load: 1.234, cpus: 10 }, sources(2.5, calls));
    expect(quiet).toEqual({ cpus: 10, start: 1.23, end: 2.5 });
    expect(calls.busiest).toBe(0);

    const hot = await attributeLoad({ load: 45.1, cpus: 10 }, sources(3, calls));
    expect(hot).toEqual({
      cpus: 10,
      start: 45.1,
      end: 3,
      busiest: { pid: 4242, name: 'clang', cpu: 310 },
    });
    expect(calls.busiest).toBe(1);
  });

  it('says nothing where there is no load average or the sampling fails', async () => {
    const calls = { busiest: 0 };
    expect(await attributeLoad(undefined, sources(50, calls))).toBeUndefined();
    expect(
      await attributeLoad(
        { load: 1, cpus: 10 },
        { sample: () => undefined, busiest: () => Promise.resolve(undefined) }
      )
    ).toBeUndefined();
    expect(
      await attributeLoad(
        { load: 1, cpus: 10 },
        {
          sample: () => {
            throw new Error('no');
          },
          busiest: () => Promise.resolve(undefined),
        }
      )
    ).toBeUndefined();
  });

  it('reads as a note with the load against the CPU count', () => {
    expect(renderLoad({ cpus: 10, start: 2, end: 3 })).toBe(
      'host load 2 at the start, 3 at the end, on 10 CPUs'
    );
    expect(
      renderLoad({ cpus: 10, start: 45, end: 3, busiest: { pid: 4242, name: 'clang', cpu: 310 } })
    ).toBe(
      'host load 45 at the start, 3 at the end, on 10 CPUs (above the CPU count); ' +
        'busiest process outside this command: clang (PID 4242, 310% CPU)'
    );
  });
});

describe('the host samples', () => {
  it('answer or stay silent, and never throw', async () => {
    const sample = sampleLoad();
    if (process.platform === 'win32') expect(sample).toBeUndefined();
    else expect(sample?.cpus).toBeGreaterThanOrEqual(1);
    const busiest = await busiestOutsider();
    expect(busiest === undefined || busiest.pid !== process.pid).toBe(true);
  });
});
