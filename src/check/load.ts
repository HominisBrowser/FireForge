// SPDX-License-Identifier: EUPL-1.2
/**
 * Says what the host was doing around a gate entry that did not pass, so a
 * red that came with a loaded host reads as one. It informs only: nothing here
 * changes a verdict or an exit code.
 */
import { type Busiest, busiestOutsider, type LoadSample, sampleLoad } from './hostLoad.js';
import type { GateLoad } from './record.js';

/** Where the samples come from. */
export interface LoadSources {
  sample: () => LoadSample | undefined;
  busiest: () => Promise<Busiest | undefined>;
}

const HOST: LoadSources = { sample: sampleLoad, busiest: busiestOutsider };

const rounded = (value: number): number => Math.round(value * 100) / 100;

/**
 * The host load over an entry, from the sample taken when it started and one
 * taken now. The busiest process outside this command is named only when the
 * load was above the CPU count at either end.
 *
 * @param start - The sample from when the entry started
 * @param sources - Where samples come from (default the host)
 * @returns Undefined where the platform has no load average
 */
export async function attributeLoad(
  start: LoadSample | undefined,
  sources: LoadSources = HOST
): Promise<GateLoad | undefined> {
  try {
    const end = sources.sample();
    if (start === undefined || end === undefined) return undefined;
    const high = Math.max(start.load, end.load) > end.cpus;
    const busiest = high ? await sources.busiest() : undefined;
    return {
      cpus: end.cpus,
      start: rounded(start.load),
      end: rounded(end.load),
      ...(busiest === undefined ? {} : { busiest }),
    };
  } catch {
    return undefined;
  }
}

/**
 * The note for a person: the load against the CPU count, and the busiest
 * process outside the command when the load was high.
 *
 * @param load - From an entry
 */
export function renderLoad(load: GateLoad): string {
  const high = Math.max(load.start, load.end) > load.cpus;
  const base = `host load ${load.start} at the start, ${load.end} at the end, on ${load.cpus} CPUs${high ? ' (above the CPU count)' : ''}`;
  return load.busiest === undefined
    ? base
    : `${base}; busiest process outside this command: ${load.busiest.name} (PID ${load.busiest.pid}, ${load.busiest.cpu}% CPU)`;
}
