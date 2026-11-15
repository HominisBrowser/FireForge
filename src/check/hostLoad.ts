// SPDX-License-Identifier: EUPL-1.2
/**
 * Cheap, bounded samples of how busy the host is: the load average against
 * the CPU count, and the busiest process outside this command's own tree.
 * Both read nothing but the operating system and say nothing on a platform or
 * an error that gives no answer.
 */
import { availableParallelism, loadavg } from 'node:os';
import { basename } from 'node:path';

import { run } from '../kernel/process/index.js';

/** The one-minute load average and the CPU count it is read against. */
export interface LoadSample {
  load: number;
  cpus: number;
}

/** A process using the CPU. */
export interface Busiest {
  pid: number;
  name: string;
  /** Its CPU use in percent of one CPU, as `ps` reports it. */
  cpu: number;
}

/** How long the process listing may take. */
const PS_TIMEOUT_MS = 2_000;

/** The host's load right now, or undefined where the platform has no load average (Windows). */
export function sampleLoad(): LoadSample | undefined {
  if (process.platform === 'win32') return undefined;
  const [load] = loadavg();
  return load === undefined ? undefined : { load, cpus: Math.max(1, availableParallelism()) };
}

/**
 * The process using the most CPU that is not `own` or one of its descendants,
 * from the output of `ps -A -o pid=,ppid=,pcpu=,comm=`.
 *
 * @param output - The listing
 * @param own - The process whose tree is left out
 */
export function parseBusiest(output: string, own: number): Busiest | undefined {
  const rows: { pid: number; ppid: number; cpu: number; name: string }[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpu: Number(match[3]),
      name: basename(match[4] ?? '') || (match[4] ?? ''),
    });
  }
  const tree = new Set([own]);
  for (let grown = true; grown;) {
    grown = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grown = true;
      }
    }
  }
  let busiest: Busiest | undefined;
  for (const row of rows) {
    if (tree.has(row.pid) || row.cpu <= 0) continue;
    if (busiest === undefined || row.cpu > busiest.cpu) {
      busiest = { pid: row.pid, name: row.name, cpu: row.cpu };
    }
  }
  return busiest;
}

/**
 * The busiest process outside this command's own tree, with one `ps` call, or
 * undefined on Windows or any error.
 *
 * @param own - The process whose tree is left out (default this one)
 */
export async function busiestOutsider(own: number = process.pid): Promise<Busiest | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const result = await run('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,comm='], {
      timeoutMs: PS_TIMEOUT_MS,
      timeoutIsResult: true,
    });
    return result.exitCode === 0 && !result.timedOut && !result.truncated
      ? parseBusiest(result.stdout, own)
      : undefined;
  } catch {
    return undefined;
  }
}
