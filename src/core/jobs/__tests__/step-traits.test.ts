// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { joinsQuiet, quietMode } from '../quiet-phase.js';
import type { JobRecord, JobStep } from '../schema.js';
import { stepTraits } from '../step-traits.js';

const job = (step: JobStep, quiet = false): Pick<JobRecord, 'request' | 'phase'> => ({
  request: { schemaVersion: 1, key: 'k', sourceId: 's', steps: [step], quiet },
  phase: { index: 0, active: false, ticket: 1 },
});

describe('what a step does to the host', () => {
  it('reads a performance sample in either spelling, and only on a test', () => {
    expect(
      stepTraits({ command: 'test', args: ['--perf-samples', 'p.json', 'a.js'] }).perfSampling
    ).toBe(true);
    expect(
      stepTraits({ command: 'test', args: ['--perf-samples=p.json', 'a.js'] }).perfSampling
    ).toBe(true);
    expect(stepTraits({ command: 'test', args: ['a.js'] }).perfSampling).toBe(false);
    expect(stepTraits({ command: 'run', args: ['--perf-samples'] }).perfSampling).toBe(false);
  });

  it('counts the static checks as light, and nothing that builds or opens a browser', () => {
    for (const command of ['check', 'typecheck', 'lint', 'verify', 'status'])
      expect(stepTraits({ command, args: [] }).light).toBe(true);
    for (const command of ['build', 'test', 'run', 'package', 'furnace', 'qualify-native'])
      expect(stepTraits({ command, args: [] }).light).toBe(false);
    expect(stepTraits(undefined).light).toBe(false);
  });
});

describe('how a quiet phase holds the host', () => {
  const lane: JobStep = { command: 'test', args: ['--headless', 'a.js'] };

  it('shares a quiet step with static checks, but not a performance sample or a whole-job request', () => {
    expect(quietMode(job(lane))).toBeUndefined();
    expect(quietMode(job({ ...lane, quiet: true }))).toBe('shared');
    expect(
      quietMode(job({ ...lane, args: ['--perf-samples', 'p.json', 'a.js'], quiet: true }))
    ).toBe('exclusive');
    expect(quietMode(job(lane, true))).toBe('exclusive');
    // A step can still opt out of a whole-job request.
    expect(quietMode(job({ ...lane, quiet: false }, true))).toBeUndefined();
  });

  it('lets only a static check that is not quiet itself join one', () => {
    expect(joinsQuiet(job({ command: 'lint', args: [] }))).toBe(true);
    expect(joinsQuiet(job({ command: 'check', args: [], quiet: true }))).toBe(false);
    expect(joinsQuiet(job({ command: 'lint', args: [] }, true))).toBe(false);
    expect(joinsQuiet(job(lane))).toBe(false);
    const past = job({ command: 'lint', args: [] });
    past.phase = { index: 1, active: false, ticket: 1 };
    expect(joinsQuiet(past)).toBe(false);
  });
});
