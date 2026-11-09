// SPDX-License-Identifier: EUPL-1.2
/** A red phase read against the host load its report recorded. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PhaseVerdict } from '../phase-outcome.js';
import { judgeUnderLoad } from '../phase-report.js';
import type { JobRecord, StepHostState } from '../schema.js';

let ns: string;
const red: PhaseVerdict = { advance: false, state: 'failed', reason: 'Executor exited 8' };

const job = (quiet: boolean): JobRecord =>
  ({
    id: 'j1',
    phase: { index: 0 },
    request: { quiet: false, steps: [{ command: 'test', args: [], quiet }] },
    stepResources: [{ cpu: 2, memory: 1, build: 0, browser: 0, display: 0 }],
  }) as unknown as JobRecord;

async function writeConfig(): Promise<void> {
  await writeFile(
    join(ns, 'config.json'),
    JSON.stringify({ schemaVersion: 1, idleMs: 100, capacity: { cpu: 14 } })
  );
}
async function writeReport(
  peak: { load: number; atSeconds: number } | undefined,
  hostState?: StepHostState
): Promise<void> {
  await mkdir(join(ns, 'artifacts', 'j1'), { recursive: true });
  await writeFile(
    join(ns, 'artifacts', 'j1', 'step-0-execution.json'),
    JSON.stringify({ steps: [{ hostLoadPeak: peak, hostState }] })
  );
}

beforeEach(async () => {
  ns = await mkdtemp(join(tmpdir(), 'fireforge-phase-load-'));
});
afterEach(async () => {
  await rm(ns, { recursive: true, force: true });
});

describe('judgeUnderLoad', () => {
  it('reads a quiet red under outside load as interrupted and records the peak', async () => {
    await writeConfig();
    await writeReport({ load: 20, atSeconds: 7 });
    const { judged, peak } = await judgeUnderLoad(ns, job(true), red);
    expect(peak).toEqual({ load: 20, atSeconds: 7 });
    expect(judged.state).toBe('interrupted');
    expect(judged.reason).toContain('Executor exited 8');
  });

  it('keeps the red when the load less the step own CPU stays under the limit', async () => {
    await writeConfig();
    await writeReport({ load: 15, atSeconds: 3 });
    const { judged, peak } = await judgeUnderLoad(ns, job(true), red);
    expect(judged).toBe(red);
    expect(peak?.load).toBe(15);
  });

  it('keeps the red of a non-quiet phase whatever the load, but records the peak', async () => {
    await writeConfig();
    await writeReport({ load: 90, atSeconds: 1 });
    const { judged, peak } = await judgeUnderLoad(ns, job(false), red);
    expect(judged).toBe(red);
    expect(peak?.load).toBe(90);
  });

  it('keeps a quiet red when the coordinator configuration cannot be read', async () => {
    await writeReport({ load: 90, atSeconds: 1 });
    expect((await judgeUnderLoad(ns, job(true), red)).judged).toBe(red);
  });

  it('gives no peak for a pass, a missing report, a report without a peak, or no phase', async () => {
    await writeConfig();
    const pass: PhaseVerdict = { advance: true, state: 'running' };
    expect(await judgeUnderLoad(ns, job(true), pass)).toEqual({ judged: pass });
    expect(await judgeUnderLoad(ns, job(true), red)).toEqual({ judged: red });
    await writeReport(undefined);
    expect(await judgeUnderLoad(ns, job(true), red)).toEqual({ judged: red });
    const noPhase = { ...job(true), phase: undefined } as unknown as JobRecord;
    expect(await judgeUnderLoad(ns, noPhase, red)).toEqual({ judged: red });
  });

  it('reads a red after the network went away as interrupted and records what changed', async () => {
    await writeReport({ load: 1, atSeconds: 2 }, { networkLost: 300 });
    const { judged, hostState } = await judgeUnderLoad(ns, job(false), red);
    expect(hostState).toEqual({ networkLost: 300 });
    expect(judged.state).toBe('interrupted');
    expect(judged.reason).toContain('network went away 300s in');
  });

  it('reads the lid only for a quiet step and input only for a step with a window', async () => {
    await writeConfig();
    await writeReport(undefined, { lidClosed: 30, input: 5 });
    expect((await judgeUnderLoad(ns, job(true), red)).judged.reason).toMatch(/^The lid closed/);
    expect((await judgeUnderLoad(ns, job(false), red)).judged.state).toBe('interrupted');
    const headless = {
      ...job(false),
      request: { quiet: false, steps: [{ command: 'test', args: ['--headless'] }] },
    } as unknown as JobRecord;
    expect((await judgeUnderLoad(ns, headless, red)).judged).toBe(red);
  });
});
