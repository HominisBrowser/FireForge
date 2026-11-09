// SPDX-License-Identifier: EUPL-1.2
/** Which build the scheduler copies where, and how admission treats slots while it does. */
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { planAdmission, type SlotView } from '../admission.js';
import { planReplication } from '../replicator.js';
import { derivedResources, type JobRecord, type JobStep, type ResourceVector } from '../schema.js';

const capacity: ResourceVector = { cpu: 14, memory: 28, build: 1, browser: 1, display: 1 };
const ui: JobStep = { command: 'build', args: ['--ui'] };
const full: JobStep = { command: 'build', args: [] };
const browser: JobStep = { command: 'test', args: ['--headless', 'browser/a.js'] };

function job(
  id: string,
  ticket: number,
  steps: JobStep[] = [ui],
  extra: Partial<Omit<JobRecord, 'compiledDigest'>> & { compiledDigest?: string | undefined } = {}
): JobRecord {
  const state = extra.state ?? 'queued';
  return {
    schemaVersion: 1,
    id,
    owner: 'fixture',
    request: { schemaVersion: 1, key: randomUUID(), sourceId: 'source', steps, quiet: false },
    state,
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    pin: 'pin',
    compiledDigest: 'wanted',
    stepResources: steps.map((step) => derivedResources(step, capacity)),
    phase: { index: 0, active: state === 'running', ticket },
    ...extra,
  } as JobRecord;
}

const slot = (id: string, extra: Partial<SlotView> = {}): SlotView => ({
  id,
  pin: 'pin',
  quarantined: null,
  ...extra,
});
const views = (...slots: SlotView[]): Map<string, SlotView> =>
  new Map(slots.map((view) => [view.id, view]));
const built = slot('a', { anchorDigest: 'wanted', sourceId: 'other' });
const waiters = [job('w1', 1), job('w2', 2)];

describe('choosing a build to replicate', () => {
  it('copies the only built slot into an idle one once two jobs wait for it', () => {
    expect(
      planReplication(waiters, views(built, slot('b', { requiresFullBuild: true })), 2)
    ).toEqual({ from: 'a', to: 'b', waiting: 2 });
  });

  it('does nothing when switched off, or for a queue shorter than the depth per holder', () => {
    const slots = views(built, slot('b'));
    expect(planReplication(waiters, slots, 0)).toBeUndefined();
    expect(planReplication(waiters.slice(0, 1), slots, 2)).toBeUndefined();
    // Two slots already hold it: two waiters are one each.
    expect(
      planReplication(waiters, views(built, slot('c', { anchorDigest: 'wanted' }), slot('b')), 2)
    ).toBeUndefined();
    expect(
      planReplication(
        [...waiters, job('w3', 3), job('w4', 4)],
        views(built, slot('c', { anchorDigest: 'wanted' }), slot('b')),
        2
      )
    ).toEqual({ from: 'a', to: 'b', waiting: 4 });
  });

  it('copies only from a holder between jobs, never under a running one', () => {
    const running = job('peer', 0, [browser], { state: 'running', slot: 'a' });
    expect(planReplication([running, ...waiters], views(built, slot('b')), 2)).toBeUndefined();
  });

  it('never takes a slot a queued job could start on, names, or needs the build of', () => {
    const cold = slot('b');
    const fullBuild = job('full', 3, [full], { compiledDigest: 'other' });
    expect(planReplication([...waiters, fullBuild], views(built, cold), 2)).toBeUndefined();
    const named = job('named', 3, [full], { request: { ...fullBuild.request, slot: 'b' } });
    expect(planReplication([...waiters, named], views(built, cold), 2)).toBeUndefined();
    const needsOther = job('other', 3, [ui], { compiledDigest: 'elsewhere' });
    expect(
      planReplication(
        [...waiters, needsOther],
        views(built, slot('b', { anchorDigest: 'elsewhere' })),
        2
      )
    ).toBeUndefined();
  });

  it('prefers a destination with no build, then one that needs a full build anyway', () => {
    const slots = views(
      built,
      slot('b', { anchorDigest: 'unwanted' }),
      slot('c', { anchorDigest: 'stale', requiresFullBuild: true }),
      slot('d')
    );
    expect(planReplication(waiters, slots, 2)?.to).toBe('d');
    slots.delete('d');
    expect(planReplication(waiters, slots, 2)?.to).toBe('c');
  });

  it('skips a pair that already declined, a slot on another pin, and a quarantined or busy one', () => {
    expect(planReplication(waiters, views(built, slot('b')), 2, () => true)).toBeUndefined();
    expect(planReplication(waiters, views(built, slot('b', { pin: 'other' })), 2)).toBeUndefined();
    expect(
      planReplication(waiters, views(built, slot('b', { quarantined: 'uncertain' })), 2)
    ).toBeUndefined();
    expect(
      planReplication(waiters, views(built, slot('b', { replicating: 'busy' })), 2)
    ).toBeUndefined();
    expect(
      planReplication(waiters, views({ ...built, replicating: 'busy' }, slot('b')), 2)
    ).toBeUndefined();
  });

  it('leaves jobs that only read a package to the slot that built it', () => {
    const tests = [job('t1', 1, [browser]), job('t2', 2, [browser])];
    expect(
      planReplication(tests, views({ ...built, packagedSource: 'source' }, slot('b')), 2)
    ).toBeUndefined();
  });

  it('counts only queued jobs that named no slot and wait on this pin', () => {
    const cancelled = waiters.map((entry) => ({ ...entry, cancellationRequested: true }));
    expect(planReplication(cancelled, views(built, slot('b')), 2)).toBeUndefined();
    const elsewhere = waiters.map((entry) => ({ ...entry, pin: 'other' }));
    expect(planReplication(elsewhere, views(built, slot('b')), 2)).toBeUndefined();
  });
});

describe('admission while a build replicates', () => {
  const config = { capacity };
  const text = "replicating slot a's build into b";

  it('admits nothing to either slot and tells the waiters why', () => {
    const plan = planAdmission(waiters, {
      config,
      slots: views({ ...built, replicating: text }, slot('b', { replicating: text })),
    });
    expect(plan.admit).toEqual([]);
    expect(plan.refuse.size).toBe(0);
    expect(plan.blocked.get('w1')).toBe(
      `Waiting while ${text}, so more than one slot can serve this job`
    );
  });

  it('lets only the relocating job onto the destination', () => {
    const relocate = job('relocate', 3, [{ command: 'qualify-native', args: [] }], {
      slot: 'b',
      compiledDigest: undefined,
    });
    const other = job('other', 2, [full], { slot: 'b', compiledDigest: undefined });
    const plan = planAdmission([other, relocate], {
      config,
      slots: views(built, slot('b', { replicating: text, replicationJob: 'relocate' })),
    });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['relocate']);
    expect(plan.blocked.get('other')).toBe(`Slot b is busy ${text}`);
  });

  it('sends a job that needs no build elsewhere while a slot replicates', () => {
    const fullBuild = job('full', 1, [full], { compiledDigest: undefined });
    const plan = planAdmission([fullBuild], {
      config,
      slots: views(slot('b', { replicating: text }), slot('c')),
    });
    expect(plan.admit).toEqual([{ job: fullBuild, slot: 'c' }]);
  });
});
