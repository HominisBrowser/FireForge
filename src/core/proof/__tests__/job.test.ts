// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { JobStep } from '../../jobs/schema.js';
import type { SlotRecord } from '../../jobs/slot-types.js';
import type { ObligationStatus } from '../evidence.js';
import { composeProofJob, namedObligation } from '../job.js';
import type { Obligation, ProofPlan } from '../types.js';

const lane: JobStep = { command: 'test', args: ['--headless', 'a/browser_a.js'] };
const stress: JobStep = { command: 'test', args: ['--repeat', '5', 'a/browser_a.js'] };
const smoke: JobStep = { command: 'run', args: ['--smoke-exit', '20'] };
const build: JobStep = { command: 'build', args: ['--ui'] };

const obligation = (id: string, kind: Obligation['kind'], step?: JobStep): Obligation => ({
  id,
  kind,
  reason: '',
  fingerprints: [],
  ...(step === undefined ? {} : { step }),
});

const plan: ProofPlan = {
  schemaVersion: 1,
  id: 'p',
  tier: 'gate',
  source: 's',
  base: {} as ProofPlan['base'],
  compiled: 'c',
  controlPaths: [],
  changed: [],
  obligations: [
    obligation('build', 'build', build),
    obligation('lane:tiles', 'lane', lane),
    obligation('stress:tiles', 'stress', stress),
    obligation('run:smoke', 'run', smoke),
    obligation('accept:scene', 'accept'),
  ],
  notes: [],
  removedTests: [],
};

const outstanding = plan.obligations.map((entry): ObligationStatus => ({
  id: entry.id,
  kind: entry.kind,
  state: 'outstanding',
  reason: '',
  reds: 0,
}));

/** A slot with a binary of this plan's compiled inputs and this source's package. */
const built = {
  id: 'a',
  quarantined: null,
  sourceId: 's',
  fullBuildAnchor: { digest: 'c' },
  trustedBuild: { sourceId: 's' },
} as unknown as SlotRecord;

describe('one obligation of a gate run alone', () => {
  it('names a lane by its ID and anything else by its full ID', () => {
    expect(namedObligation(plan, 'tiles')).toBe('lane:tiles');
    expect(namedObligation(plan, 'stress:tiles')).toBe('stress:tiles');
    expect(namedObligation(plan, 'run:smoke')).toBe('run:smoke');
    expect(() => namedObligation(plan, 'nope')).toThrow(/proof-unknown-obligation: .*lane:tiles/);
    expect(() => namedObligation(plan, 'accept:scene')).toThrow(/proof-lane-acceptance/);
  });

  it('runs exactly the plan step of that obligation, so its evidence is a gate run of it', () => {
    const job = composeProofJob(plan, outstanding, [built], undefined, 'lane:tiles');
    expect(job.steps).toEqual([lane]);
    expect(job.slot).toBe('a');
    // The whole plan, unnarrowed, is what a plain gate run submits.
    expect(composeProofJob(plan, outstanding, [built], undefined).steps).toEqual([
      build,
      lane,
      stress,
      smoke,
    ]);
  });

  it('brings the build the obligation needs when no slot has this source’s package', () => {
    expect(composeProofJob(plan, outstanding, [], undefined, 'run:smoke').steps).toEqual([
      { command: 'build', args: [] },
      smoke,
    ]);
  });

  it('submits nothing for an obligation that already has its evidence', () => {
    const passed = outstanding.map((entry) =>
      entry.id === 'lane:tiles' ? { ...entry, state: 'passed' as const } : entry
    );
    expect(composeProofJob(plan, passed, [built], undefined, 'lane:tiles').steps).toEqual([]);
  });
});
