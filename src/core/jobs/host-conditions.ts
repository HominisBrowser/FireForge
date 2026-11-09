// SPDX-License-Identifier: EUPL-1.2
/** Host conditions that change what a test or run step measures, watched while it runs. */
import { networkInterfaces } from 'node:os';

import {
  clamshellClosed,
  hostReading,
  readDisplayProfile,
  readDisplayState,
  readRootDomain,
} from './display-probe.js';
import type { StepHostState } from './schema.js';

/** Reads the host. A reader that cannot tell gives undefined, and a missing one is never asked. */
export interface HostConditionReaders {
  /** Whether the lid is closed and whether no display stays active. */
  display?: () => Promise<{ lidClosed: boolean; displaySlept: boolean } | undefined>;
  /** Whether a non-tunnel interface other than loopback has a routable address. */
  network: () => boolean | undefined;
  /** Seconds since the last keyboard or pointer input. */
  idleSeconds?: () => Promise<number | undefined>;
}

/** Link-local addresses, which every interface (and every macOS tunnel) carries with no network at all. */
const LINK_LOCAL = /^(?:169\.254\.|fe[89ab][0-9a-f]:)/i;

/**
 * Tunnels, which ride on another interface: a VPN's address can outlast the
 * link under it, so it says nothing about the network.
 */
const TUNNEL = /^(?:utun|ipsec|ppp|gif|stf|tun|tap|wg)\d/;

/**
 * Whether an interface other than loopback or a tunnel has an address beyond link-local.
 *
 * @param interfaces - `os.networkInterfaces()`
 */
export function routableInterface(interfaces: ReturnType<typeof networkInterfaces>): boolean {
  return Object.entries(interfaces).some(
    ([name, entries]) =>
      !TUNNEL.test(name) &&
      (entries ?? []).some((entry) => !entry.internal && !LINK_LOCAL.test(entry.address))
  );
}

/**
 * Seconds since the last HID input, from `ioreg -c IOHIDSystem -r -d 1 -k HIDIdleTime`,
 * which counts nanoseconds.
 */
export function parseHidIdleSeconds(text: string | undefined): number | undefined {
  const match = text === undefined ? null : /"HIDIdleTime"\s*=\s*(\d+)/.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]) / 1e9;
}

/**
 * This host's readers: network everywhere; lid, display and, for a step with a
 * window, input on macOS.
 */
export function hostConditionReaders(headed: boolean): HostConditionReaders {
  const network = (): boolean => routableInterface(networkInterfaces());
  if (process.platform !== 'darwin') return { network };
  return {
    network,
    display: async () => {
      const rootDomain = await readRootDomain();
      if (rootDomain === undefined) return undefined;
      return {
        lidClosed: clamshellClosed(rootDomain),
        displaySlept:
          readDisplayState(rootDomain, await readDisplayProfile()).state === 'unavailable',
      };
    },
    ...(headed
      ? {
          idleSeconds: async () =>
            parseHidIdleSeconds(
              await hostReading('/usr/sbin/ioreg', [
                '-c',
                'IOHIDSystem',
                '-r',
                '-d',
                '1',
                '-k',
                'HIDIdleTime',
              ])
            ),
        }
      : {}),
  };
}

/**
 * A host where nothing changes: network up, lid open, display awake and, for a
 * step with a window, no input since long before it started. A namespace
 * initialized with `steadyHost` reads these, so a test's step is judged on its
 * own result whatever the machine running the test is doing.
 */
export function steadyHostReaders(headed: boolean): HostConditionReaders {
  return {
    network: () => true,
    display: () => Promise.resolve({ lidClosed: false, displaySlept: false }),
    ...(headed ? { idleSeconds: () => Promise.resolve(Number.POSITIVE_INFINITY) } : {}),
  };
}

type Transition = 'lidClosed' | 'displaySlept' | 'networkLost';

/**
 * Samples the host while a step runs: at once, every `tickMs` and when stopped,
 * as the load watch does. Lid, display and network count as a change only once
 * a sample saw them fine, so a step that started without a network is not
 * excused by it; input counts when the host's idle time is shorter than the
 * step has run. The timer never keeps the process alive.
 *
 * @returns Stops watching, and gives what changed, or undefined when nothing did
 */
export function watchHostConditions(
  readers: HostConditionReaders,
  options: { tickMs: number; now?: () => number }
): () => Promise<StepHostState | undefined> {
  const now = options.now ?? Date.now;
  const started = now();
  const state: StepHostState = {};
  const fine = new Set<Transition>();
  const seconds = (at: number): number => Math.max(0, Math.round((at - started) / 1000));
  const note = (key: Transition, bad: boolean | undefined, at: number): void => {
    if (bad === undefined) return;
    if (!bad) fine.add(key);
    else if (fine.has(key)) state[key] ??= seconds(at);
  };
  const quietly = async <T>(read: (() => T | Promise<T>) | undefined): Promise<T | undefined> => {
    try {
      return await read?.();
    } catch {
      return undefined;
    }
  };
  const sample = async (): Promise<void> => {
    // Read before the idle time, so input from before the start never counts.
    const at = now();
    const online = await quietly(readers.network);
    note('networkLost', online === undefined ? undefined : !online, at);
    const display = await quietly(readers.display);
    note('lidClosed', display?.lidClosed, at);
    note('displaySlept', display?.displaySlept, at);
    if (state.input === undefined) {
      const idle = await quietly(readers.idleSeconds);
      const elapsed = (at - started) / 1000;
      if (idle !== undefined && idle < elapsed) state.input = Math.round(elapsed - idle);
    }
  };
  let pending = sample();
  const timer = setInterval(() => {
    pending = pending.then(sample);
  }, options.tickMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    pending = pending.then(sample);
    await pending;
    return Object.keys(state).length === 0 ? undefined : state;
  };
}
