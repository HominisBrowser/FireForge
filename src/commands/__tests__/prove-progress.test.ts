// SPDX-License-Identifier: EUPL-1.2
/** `prove status` shows where each job running the plan's steps stands. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobProgress } from '../../core/jobs/job-progress.js';
import type { JobView } from '../../core/jobs/schema.js';
import type { ProofStatus } from '../../core/proof/evidence.js';
import type { ProofPlan } from '../../core/proof/types.js';
import { liveProgress, printStatus } from '../prove-report.js';

const plan = {
  id: 'plan',
  tier: 'gate',
  source: 'source',
  base: { commit: 'base', label: 'main' },
  changed: [],
  notes: [],
  removedTests: [],
  obligations: [],
} as unknown as ProofPlan;
const status = {
  obligations: [{ id: 'lane:tiles', kind: 'lane', state: 'running', job: 'g', reds: 0 }],
  failures: [],
  waived: [],
  complete: false,
  finished: 0,
} as unknown as ProofStatus;
const progress: JobProgress = {
  step: 2,
  steps: 4,
  label: 'lane:tiles',
  running: true,
  stepStartedAt: '1970-01-01T01:00:00.000Z',
  stepSeconds: 725,
  startedAt: '1970-01-01T00:00:00.000Z',
  elapsedSeconds: 4325,
  results: [
    { step: 0, label: 'check', state: 'passed' },
    { step: 1, label: 'build', state: 'red' },
  ],
};

let writes: string[];
const argv = process.argv;
beforeEach(() => {
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

describe('prove status while a job runs the plan', () => {
  it('names its current step, its time, and how each finished step ended', () => {
    printStatus(plan, status, { progress: [{ job: 'g', progress }] });
    const text = writes.join('');
    expect(text).toContain(
      '  job g: step 3/4 lane:tiles, running 12m05s, 1h12m in, passed 1 red 1 blocked 0\n'
    );
    expect(text).toContain('    so far: check passed, build red\n');
  });

  it('carries it under --json, and leaves the key out when nothing runs', () => {
    process.argv = [...argv, '--json'];
    printStatus(plan, status, { progress: [{ job: 'g', progress }] });
    printStatus(plan, status, { progress: [] });
    const [running, idle] = writes.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(running?.['progress']).toEqual([{ job: 'g', progress }]);
    expect(idle).not.toHaveProperty('progress');
  });

  it('reads each running job once, and leaves out one that cannot be read or has ended', async () => {
    const obligations = [
      ...status.obligations,
      { id: 'stress:tiles', kind: 'stress', state: 'running', job: 'g', reds: 0 },
      { id: 'run:smoke', kind: 'run', state: 'running', job: 'gone', reds: 0 },
      { id: 'run:done', kind: 'run', state: 'running', job: 'done', reds: 0 },
      { id: 'check', kind: 'check', state: 'passed', job: 'old', reds: 0 },
    ] as ProofStatus['obligations'];
    const read = vi.fn((job: string) =>
      job === 'gone'
        ? Promise.reject(new Error('Unknown job'))
        : Promise.resolve({ id: job, ...(job === 'g' ? { progress } : {}) } as JobView)
    );
    expect(await liveProgress(obligations, read)).toEqual([{ job: 'g', progress }]);
    expect(read.mock.calls.map(([job]) => job)).toEqual(['g', 'gone', 'done']);
  });
});
