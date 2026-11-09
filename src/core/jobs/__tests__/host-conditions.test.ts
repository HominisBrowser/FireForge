// SPDX-License-Identifier: EUPL-1.2
/** What changed on the host while a step ran, from injected readers. */
import { describe, expect, it } from 'vitest';

import {
  hostConditionReaders,
  parseHidIdleSeconds,
  routableInterface,
  steadyHostReaders,
  watchHostConditions,
} from '../host-conditions.js';

/** Readers that answer from scripted sequences, one entry per sample; the last entry repeats. */
function scripted(script: {
  network?: Array<boolean | undefined>;
  display?: Array<{ lidClosed: boolean; displaySlept: boolean } | undefined>;
  idle?: Array<number | undefined>;
}): { readers: Parameters<typeof watchHostConditions>[0]; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const next = <T>(list: T[], counter: { n: number }): T =>
    list[Math.min(counter.n++, list.length - 1)] as T;
  const counters = { network: { n: 0 }, display: { n: 0 }, idle: { n: 0 } };
  return {
    clock,
    readers: {
      network: () => next(script.network ?? [true], counters.network),
      ...(script.display === undefined
        ? {}
        : {
            display: () => Promise.resolve(next(script.display ?? [], counters.display)),
          }),
      ...(script.idle === undefined
        ? {}
        : { idleSeconds: () => Promise.resolve(next(script.idle ?? [], counters.idle)) }),
    },
  };
}

/** Runs a watch over a list of sample times (seconds after the start; the first is the start). */
async function watch(
  readers: Parameters<typeof watchHostConditions>[0],
  clock: { now: number },
  times: number[]
): Promise<ReturnType<Awaited<ReturnType<typeof watchHostConditions>>>> {
  const start = clock.now;
  const stop = watchHostConditions(readers, { tickMs: 3_600_000, now: () => clock.now });
  clock.now = start + (times.at(-1) ?? 0) * 1000;
  return stop();
}

describe('watching host conditions during a step', () => {
  it('records the network going away, and when', async () => {
    const { readers, clock } = scripted({ network: [true, false] });
    expect(await watch(readers, clock, [0, 300])).toEqual({ networkLost: 300 });
  });

  it('does not excuse a step that started without a network', async () => {
    const { readers, clock } = scripted({ network: [false, false] });
    expect(await watch(readers, clock, [0, 300])).toBeUndefined();
  });

  it('records the lid closing and the display sleeping only after they were fine', async () => {
    const { readers, clock } = scripted({
      display: [
        { lidClosed: false, displaySlept: false },
        { lidClosed: true, displaySlept: true },
      ],
    });
    expect(await watch(readers, clock, [0, 90])).toEqual({ lidClosed: 90, displaySlept: 90 });
    const closed = scripted({ display: [{ lidClosed: true, displaySlept: false }] });
    expect(await watch(closed.readers, closed.clock, [0, 90])).toBeUndefined();
  });

  it('records input that came after the start, not before it', async () => {
    const touched = scripted({ idle: [500, 20] });
    expect(await watch(touched.readers, touched.clock, [0, 120])).toEqual({ input: 100 });
    const untouched = scripted({ idle: [500, 620] });
    expect(await watch(untouched.readers, untouched.clock, [0, 120])).toBeUndefined();
  });

  it('treats a reader that throws or cannot tell as no reading', async () => {
    const { clock } = scripted({});
    const readers = {
      network: () => {
        throw new Error('no interfaces');
      },
      display: () => Promise.resolve(undefined),
      idleSeconds: () => Promise.reject(new Error('no ioreg')),
    };
    expect(await watch(readers, clock, [0, 60])).toBeUndefined();
  });
});

describe('reading the host', () => {
  it('counts only a non-loopback, non-tunnel interface with an address beyond link-local', () => {
    const entry = (address: string, internal = false) =>
      ({ address, internal, family: 'IPv4', netmask: '', mac: '', cidr: null }) as const;
    expect(
      routableInterface({
        lo0: [entry('127.0.0.1', true)],
        utun0: [entry('fe80::5865:2b47:1fb1:7183')],
        en0: [entry('169.254.10.2')],
      })
    ).toBe(false);
    expect(routableInterface({ en0: [entry('192.168.1.4')] })).toBe(true);
    // A VPN keeps its address after the link under it is gone.
    expect(
      routableInterface({
        utun4: [entry('100.64.0.7')],
        ipsec0: [entry('10.8.0.2')],
        en0: [entry('fe80::83b:7d42:6aff:f3c8')],
      })
    ).toBe(false);
  });

  it('gives a steady host when asked: online, lid open, display awake, no input', async () => {
    const { clock } = scripted({});
    expect(await watch(steadyHostReaders(true), clock, [0, 600])).toBeUndefined();
    expect(Object.keys(steadyHostReaders(false))).not.toContain('idleSeconds');
  });

  it('reads the HID idle time in seconds', () => {
    expect(parseHidIdleSeconds('      "HIDIdleTime" = 596675791\n')).toBeCloseTo(0.5967, 3);
    expect(parseHidIdleSeconds('nothing')).toBeUndefined();
    expect(parseHidIdleSeconds(undefined)).toBeUndefined();
  });

  it('asks for input only for a step with a window, and for lid and input only on macOS', () => {
    const real = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      expect(Object.keys(hostConditionReaders(true))).toEqual(['network']);
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      expect(Object.keys(hostConditionReaders(false)).sort()).toEqual(['display', 'network']);
      expect(Object.keys(hostConditionReaders(true)).sort()).toEqual([
        'display',
        'idleSeconds',
        'network',
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });
});
