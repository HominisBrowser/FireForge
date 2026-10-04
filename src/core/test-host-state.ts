// SPDX-License-Identifier: EUPL-1.2
import { loadavg } from 'node:os';

import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { notice } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { isObject } from '../utils/validation.js';

export interface TestHostState {
  load: number;
  topProcess?: { cpu: number; command: string };
  power: 'ac' | 'battery' | 'unknown';
}

/** Samples load/top process and the macOS power SOURCE (including charging on AC). */
export async function sampleTestHost(): Promise<TestHostState> {
  const state: TestHostState = { load: loadavg()[0] ?? 0, power: 'unknown' };
  try {
    const result = await exec('ps', ['-axo', 'pcpu=,comm='], { timeout: 5000 });
    const processes = result.stdout
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*([\d.]+)\s+(.+)$/.exec(line);
        return match ? [{ cpu: Number(match[1]), command: match[2] ?? '' }] : [];
      })
      .sort((a, b) => b.cpu - a.cpu);
    if (processes[0]) state.topProcess = processes[0];
  } catch {
    /* Host diagnostics remain best effort. */
  }
  if (process.platform === 'darwin') {
    try {
      const result = await exec('pmset', ['-g', 'ps'], { timeout: 5000 });
      state.power = /'AC Power'/.test(result.stdout)
        ? 'ac'
        : /'Battery Power'/.test(result.stdout)
          ? 'battery'
          : 'unknown';
    } catch {
      /* Keep unknown when power tooling is unavailable. */
    }
  }
  return state;
}

/** Reports host contention alongside a suite's result, without inventing a test failure. */
export function reportTestHost(state: TestHostState, phase: string): boolean {
  const pegged = (state.topProcess?.cpu ?? 0) >= 90;
  if (state.load < 4 && !pegged) return false;
  notice(
    `Host load at ${phase}: ${state.load.toFixed(2)}; top process ${state.topProcess?.command ?? '(unknown)'} ${state.topProcess?.cpu ?? 0}% CPU. Timing failures may reflect host contention.`
  );
  return true;
}

/** Stamps each perf artifact before the verdict, preserving the producer's schema and data. */
export async function stampPerfHost(
  env: Record<string, string> | undefined,
  start: TestHostState,
  end: TestHostState
): Promise<boolean> {
  if (!env) return false;
  const artifacts = [
    ...new Set(
      Object.entries(env)
        .filter(([key]) => key.endsWith('_PERF_SAMPLE_JSON'))
        .map(([, path]) => path)
    ),
  ];
  if (artifacts.length === 0) return false;
  const changed = start.power !== 'unknown' && end.power !== 'unknown' && start.power !== end.power;
  if (changed)
    notice(
      `Perf power source changed during the run (${start.power} → ${end.power}); this sample is inconclusive.`
    );
  for (const artifact of artifacts) {
    try {
      if (!(await pathExists(artifact))) continue;
      const sample = await readJson<unknown>(artifact);
      if (!isObject(sample)) throw new Error('sample JSON is not an object');
      await writeJson(artifact, {
        ...sample,
        fireforgeHost: { start, end, powerSourceChanged: changed },
      });
    } catch (error: unknown) {
      notice(
        `Could not annotate perf artifact ${artifact}: ${toError(error).message}. The harness outcome is preserved; inspect or regenerate this artifact before using it as perf evidence.`
      );
    }
  }

  return changed;
}
