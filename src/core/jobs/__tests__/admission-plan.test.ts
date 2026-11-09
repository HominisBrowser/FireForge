// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { chooseSlot, planAdmission, type SlotView, whyNoSlotCanRun } from '../admission.js';
import {
  derivedResources,
  type JobRecord,
  type JobStep,
  normalizeRequest,
  type ResourceVector,
  validateRequest,
} from '../schema.js';

const capacity: ResourceVector = { cpu: 14, memory: 28, build: 1, browser: 1, display: 1 };
const config = { capacity };
const build: JobStep = { command: 'build', args: [] };
const browser: JobStep = { command: 'test', args: ['--headless', 'browser/a.js'] };
const status: JobStep = { command: 'status', args: [] };

function record(
  name: string,
  ticket: number,
  step: JobStep,
  state: JobRecord['state'] = 'queued',
  named: string | null = name
): JobRecord {
  const slot = named ?? undefined;
  return {
    schemaVersion: 1,
    id: name,
    owner: 'fixture',
    request: {
      schemaVersion: 1,
      key: randomUUID(),
      sourceId: 'a'.repeat(64),
      steps: [step],
      quiet: false,
      ...(slot === undefined ? {} : { slot }),
    },
    state,
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    stepResources: [step.resources ?? derivedResources(step, capacity)],
    phase: { index: 0, active: state === 'running', ticket },
    ...(slot === undefined ? {} : { slot }),
  };
}

const ids = (jobs: readonly JobRecord[]): string[] =>
  planAdmission(jobs, { config }).admit.map((entry) => entry.job.id);

describe('capacity from the host', () => {
  it('derives a build from 75% of the CPU budget, capped by the project, and static work at 2', () => {
    expect(derivedResources(build, capacity)).toMatchObject({ cpu: 10, build: 1 });
    expect(derivedResources(build, capacity, 6).cpu).toBe(6);
    expect(derivedResources(status, capacity)).toMatchObject({ cpu: 2, memory: 2, build: 0 });
    expect(derivedResources(browser, capacity)).toMatchObject({ cpu: 2, memory: 4, browser: 1 });
  });
  it('never derives more than a small host has', () => {
    const small: ResourceVector = { cpu: 1, memory: 1, build: 1, browser: 1, display: 1 };
    expect(derivedResources(build, small)).toMatchObject({ cpu: 1, memory: 1 });
    expect(derivedResources(browser, small)).toMatchObject({ cpu: 1, memory: 1 });
  });
  it('runs a build, a browser test and a static check together on a 14-CPU host', () => {
    expect(ids([record('a', 1, build), record('b', 2, browser), record('c', 3, status)])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('work-conserving admission', () => {
  it('admits a static check past a build waiting on the build lane', () => {
    const running = record('a', 1, build, 'running');
    const waiting = record('b', 2, build);
    const lint = record('c', 3, status);
    const plan = planAdmission([running, waiting, lint], { config });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['c']);
    expect(plan.blocked.get('b')).toMatch(/build/);
  });
  it('keeps a later build behind the one reserving the lane', () => {
    const running = record('a', 1, build, 'running');
    const first = record('b', 2, build);
    const second = record('c', 3, build);
    const plan = planAdmission([running, first, second], { config });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('c')).toMatch(/build/);
  });
  it('lets lint overtake a test waiting for the browser', () => {
    expect(
      ids([record('a', 1, browser, 'running'), record('b', 2, browser), record('c', 3, status)])
    ).toEqual(['c']);
  });
  it('cannot starve a CPU waiter: once CPU alone blocks it, CPU is reserved', () => {
    const wide: JobStep = {
      command: 'status',
      args: [],
      resources: { cpu: 13, memory: 2, build: 0, browser: 0, display: 0 },
    };
    const running = record('a', 1, status, 'running');
    expect(ids([running, record('b', 2, wide), record('c', 3, status)])).toEqual([]);
    running.state = 'passed';
    expect(ids([running, record('b', 2, wide), record('c', 3, status)])).toEqual(['b']);
  });
  it('drains for a quiet waiter and blocks everything behind it, saying why', () => {
    const quiet = record('b', 2, { ...status, quiet: true });
    const plan = planAdmission([record('a', 1, build, 'running'), quiet, record('c', 3, status)], {
      config,
    });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('b')).toBe('Draining the host for this quiet phase: waiting for job a');
    expect(plan.blocked.get('c')).toMatch(/quiet phase of job b \(step 1\/1 status, not started\)/);
  });
  it('starts a quiet phase on a drained host only below the quiet load limit, saying the load', () => {
    const quiet = (): JobRecord => record('q', 1, { ...status, quiet: true });
    const loaded = planAdmission([quiet(), record('c', 2, status)], { config, hostLoad: 35.2 });
    expect(loaded.admit).toEqual([]);
    expect(loaded.blocked.get('q')).toBe(
      'host-load: one-minute load 35.20 is at or above the quiet limit 14'
    );
    expect(loaded.blocked.get('c')).toMatch(/quiet phase of job q/);
    expect(planAdmission([quiet()], { config, hostLoad: 13.9 }).admit).toHaveLength(1);
    // The namespace's own limit wins over the CPU-count default.
    const strict = { capacity, quietLoad: 4 };
    expect(planAdmission([quiet()], { config: strict, hostLoad: 5 }).admit).toEqual([]);
    expect(planAdmission([quiet()], { config: strict, hostLoad: 3 }).admit).toHaveLength(1);
    // A host whose load cannot be read waits on nothing, and a step that is not quiet never waits on it.
    expect(planAdmission([quiet()], { config }).admit).toHaveLength(1);
    expect(ids([record('s', 1, status)])).toEqual(['s']);
    expect(planAdmission([record('s', 1, status)], { config, hostLoad: 99 }).admit).toHaveLength(1);
  });
  it('ends a quiet phase the load kept waiting past its deadline, with no verdict on the step', () => {
    const queued = { ...record('q', 1, { ...status, quiet: true, deadlineSeconds: 60 }) };
    queued.updatedAt = new Date(0).toISOString();
    const waiting = planAdmission([queued], { config, hostLoad: 20, now: 59_000 });
    expect(waiting.interrupt.size).toBe(0);
    expect(waiting.blocked.get('q')).toMatch(/^host-load: /);
    const expired = planAdmission([queued], { config, hostLoad: 20, now: 61_000 });
    expect(expired.admit).toEqual([]);
    expect(expired.interrupt.get(queued)).toMatch(
      /kept this quiet phase from starting for its 60s deadline: one-minute load 20.00/
    );
  });
});

describe('quiet phases', () => {
  const lane: JobStep = { ...browser, quiet: true };
  const perf: JobStep = {
    command: 'test',
    args: ['--headless', '--perf-samples', 'perf.json', 'browser/perf.js'],
    quiet: true,
  };
  const lint: JobStep = { command: 'lint', args: [] };
  const holding = (step: JobStep, startedAt = new Date(0).toISOString()): JobRecord => {
    const job = record('q', 1, step, 'running');
    job.request.steps = [build, step, build];
    job.stepResources = job.request.steps.map((each) => derivedResources(each, capacity));
    job.phase = { index: 1, active: true, ticket: 1, startedAt };
    return job;
  };
  const now = 64 * 60_000 + 5_000;

  it('names the job, its step and how long it has held the host', () => {
    const plan = planAdmission([holding(lane), record('b', 2, build)], { config, now });
    expect(plan.blocked.get('b')).toBe(
      'Waiting for the quiet phase of job q (step 2/3 test --headless browser/a.js, holding the host for 1h04m); only a static check runs beside it'
    );
  });

  it('lets a static check start beside a quiet lane while the load stays under the limit', () => {
    const jobs = [
      holding(lane),
      record('l', 2, lint),
      record('s', 3, status),
      record('b', 4, build),
    ];
    const plan = planAdmission(jobs, { config, now, hostLoad: 6 });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['l', 's']);
    expect(plan.blocked.get('b')).toMatch(/only a static check runs beside it/);
  });

  it('counts the CPU it just admitted beside a quiet lane against the load limit', () => {
    const jobs = [holding(lane), record('l', 2, lint), record('s', 3, status)];
    const plan = planAdmission(jobs, { config, now, hostLoad: 10.5 });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['l']);
    expect(plan.blocked.get('s')).toMatch(
      /stays under the quiet limit 14: load 10.50 plus 2 CPU just admitted plus its 2 CPU reaches it/
    );
    const laned: JobStep = {
      ...lint,
      resources: { cpu: 1, memory: 1, build: 0, browser: 1, display: 0 },
    };
    expect(
      planAdmission([holding(lane), record('w', 2, laned)], {
        config,
        now,
        hostLoad: 0,
      }).blocked.get('w')
    ).toMatch(/only a static check runs beside it$/);
    expect(
      planAdmission([holding(lane), record('l', 2, lint)], {
        config,
        now,
        hostLoad: 13,
      }).blocked.get('l')
    ).toMatch(/: load 13.00 plus its 2 CPU reaches it$/);
    const unread = planAdmission([holding(lane), record('l', 2, lint)], { config, now });
    expect(unread.admit).toEqual([]);
    expect(unread.blocked.get('l')).toMatch(/only while the load can be read/);
  });

  it('starts nothing beside a performance sample, nor beside a whole-job quiet request', () => {
    expect(
      planAdmission([holding(perf), record('l', 2, lint)], { config, now, hostLoad: 0 }).admit
    ).toEqual([]);
    const whole = holding(browser);
    whole.request.quiet = true;
    const plan = planAdmission([whole, record('l', 2, lint)], { config, now, hostLoad: 0 });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('l')).toMatch(/^Waiting for the quiet phase of job q/);
  });

  it('never runs a quiet static check, or one behind a quiet waiter, beside a quiet lane', () => {
    const quietCheck = record('c', 2, { ...status, quiet: true });
    const plan = planAdmission([holding(lane), quietCheck, record('l', 3, lint)], {
      config,
      now,
      hostLoad: 0,
    });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('c')).toMatch(/quiet phase of job q/);
    expect(plan.blocked.get('l')).toMatch(/quiet phase of job c/);
  });

  it('starts a quiet lane beside static checks, but a performance sample only once they drain', () => {
    const running = record('l', 1, lint, 'running');
    const shared = planAdmission([running, record('q', 2, lane)], { config, hostLoad: 3 });
    expect(shared.admit.map((entry) => entry.job.id)).toEqual(['q']);
    const exclusive = planAdmission([running, record('p', 2, perf)], { config, hostLoad: 3 });
    expect(exclusive.admit).toEqual([]);
    expect(exclusive.blocked.get('p')).toBe(
      'Draining the host for this quiet phase: waiting for job l'
    );
  });

  it('waits for room beside the static checks still running', () => {
    const wide: JobStep = {
      ...lane,
      resources: { cpu: 13, memory: 4, build: 0, browser: 1, display: 0 },
    };
    const plan = planAdmission([record('l', 1, lint, 'running'), record('q', 2, wide)], {
      config,
    });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('q')).toMatch(/waiting for job l/);
  });

  it('releases the host between two quiet steps: what waited goes before the next one', () => {
    const gate = record('g', 5, lane);
    gate.state = 'running';
    gate.request.steps = [lane, lane];
    gate.stepResources = [derivedResources(lane, capacity), derivedResources(lane, capacity)];
    // The finished quiet step's job queues its next one with a fresh ticket.
    gate.phase = { index: 1, active: false, ticket: 5 };
    const waited = record('b', 3, build);
    const plan = planAdmission([gate, waited, record('s', 6, status)], { config });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['b']);
    expect(plan.blocked.get('g')).toMatch(/^Draining the host for this quiet phase/);
    // A static check that arrived after the quiet waiter does not pass it.
    expect(plan.blocked.get('s')).toMatch(/quiet phase of job g/);
  });
});

describe('admission context', () => {
  const view = (id: string, extra: Partial<SlotView> = {}): SlotView => ({
    id,
    quarantined: null,
    ...extra,
  });
  it('blocks every waiting job for a host-wide reason', () => {
    const plan = planAdmission([record('a', 1, status), record('b', 2, status)], {
      config,
      blocked: 'Waiting for disk',
    });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('a')).toBe('Waiting for disk');
    expect(plan.blocked.get('b')).toBe('Waiting for disk');
  });
  it('counts what a surviving group still holds against capacity', () => {
    const held: ResourceVector = { cpu: 2, memory: 4, build: 0, browser: 1, display: 0 };
    const plan = planAdmission([record('a', 1, browser), record('b', 2, status)], { config, held });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['b']);
    expect(plan.blocked.get('a')).toMatch(/browser/);
  });
  it('holds a job for a quarantined or missing named slot, and names the way out', () => {
    const slots = new Map([['a', view('a', { quarantined: 'drift' })]]);
    const plan = planAdmission([record('a', 1, status), record('b', 2, status)], { config, slots });
    expect(plan.admit).toEqual([]);
    expect(plan.blocked.get('a')).toMatch(/quarantined: drift.*slot restore a/);
    expect(plan.blocked.get('b')).toMatch(/does not exist/);
  });
  it('assigns a free slot to a job naming none, skipping quarantined and busy ones', () => {
    const slots = new Map([
      ['a', view('a')],
      ['b', view('b', { quarantined: 'drift' })],
      ['c', view('c')],
    ]);
    const plan = planAdmission(
      [record('x', 1, status, 'running', 'a'), record('y', 2, status, 'queued', null)],
      { config, slots }
    );
    expect(plan.admit).toEqual([expect.objectContaining({ slot: 'c' })]);
  });
  it('queues a job naming no slot when none is free, without double-booking one', () => {
    const slots = new Map([['a', view('a')]]);
    const plan = planAdmission(
      [record('x', 1, status, 'queued', null), record('y', 2, status, 'queued', null)],
      { config, slots }
    );
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['x']);
    expect(plan.blocked.get('y')).toMatch(/free slot/);
  });
  it('prefers a slot already on the source and refuses a different pin', () => {
    const fresh = record('x', 1, status, 'queued', null);
    fresh.pin = 'p1';
    expect(
      chooseSlot(fresh, [
        view('a', { pin: 'p1' }),
        view('b', { pin: 'p1', sourceId: fresh.request.sourceId }),
      ])?.id
    ).toBe('b');
    expect(chooseSlot(fresh, [view('a', { pin: 'p2' })])).toBeUndefined();
  });
});

describe('a hand-written request', () => {
  const id = 'a'.repeat(64);
  it('needs only its steps; the rest is derived', () => {
    const request = normalizeRequest(
      { steps: [{ command: 'test', args: ['--headless', 'browser/a.js'] }] },
      id
    );
    validateRequest(request);
    expect(request).toMatchObject({ schemaVersion: 1, sourceId: id, quiet: false });
    expect(request.key).toMatch(/^auto-[a-f0-9]{40}$/);
    expect(request.steps[0]?.expected?.files).toEqual(['browser/a.js']);
    expect(normalizeRequest({ steps: request.steps }, id).key).toBe(request.key);
  });
  it('does not mistake an option value for a test file', () => {
    const request = normalizeRequest(
      { steps: [{ command: 'test', args: ['--profile-file', 'a.js=user.js', 'browser/b.js'] }] },
      id
    );
    expect(request.steps[0]?.expected?.files).toEqual(['browser/b.js']);
  });
  it.each([
    [{ schemaVersion: 2, steps: [status] }, /schemaVersion/],
    [{ sourceId: 'b'.repeat(64), steps: [status] }, /names source/],
    [[], /JSON object/],
  ])('refuses %j with a message naming the field', (value, expected) => {
    expect(() => normalizeRequest(value, id)).toThrow(expected);
  });
  it.each([
    [{ steps: [] }, /steps/],
    [{ steps: [status], key: 'not a key!' }, /key/],
    [{ steps: [status], slot: '../up' }, /slot/],
    [{ steps: [{ command: 'test', args: ['--headless'] }] }, /roster/],
    [{ steps: [{ command: 'lint', args: ['--help'] }] }, /Unsupported immutable-job option/],
    [{ steps: [{ command: 'typecheck', args: ['--help'] }] }, /Unsupported immutable-job option/],
    [{ steps: [{ command: 'verify', args: ['-h'] }] }, /Unsupported immutable-job option/],
    [{ steps: [{ command: 'build', args: ['--help'] }] }, /Unsupported immutable-job option/],
    [{ steps: [{ command: 'package', args: ['--allow-stale-build'] }] }, /Unsupported/],
    [{ steps: [{ command: 'furnace', args: ['create', 'x'] }] }, /furnace job action/],
    [{ steps: [{ ...status, deadlineSeconds: 0 }] }, /deadline/],
  ])('validates %j', (value, expected) => {
    expect(() => {
      validateRequest(normalizeRequest(value, id));
    }).toThrow(expected);
  });
  it('admits the argument forms a real step uses', () => {
    for (const step of [
      { command: 'lint', args: ['browser/a.css', '--max-warnings', '0', '--json'] },
      { command: 'typecheck', args: ['--source-files', 'a.ts', 'b.ts'] },
      { command: 'verify', args: [] },
      { command: 'status', args: ['--json'] },
      { command: 'build', args: ['--ui', '-j4'] },
      { command: 'furnace', args: ['validate', '--max-warnings', '0'] },
    ])
      validateRequest(normalizeRequest({ steps: [step] }, id));
  });
});

describe('a run’s profile', () => {
  it('is always fresh: no path keeps one run’s state for the next run’s verdict', () => {
    for (const profile of ['.fireforge/profiles/kept', 'engine/obj-x/p', '.fireforge/p'])
      expect(() => {
        validateRequest(
          normalizeRequest(
            { steps: [{ command: 'run', args: ['--profile', profile] }] },
            'a'.repeat(64)
          )
        );
      }).toThrow(/fresh profile/);
  });

  const validate = (steps: unknown[]): void => {
    validateRequest(normalizeRequest({ steps }, 'a'.repeat(64)));
  };

  it('is kept only by an interactive run, at an absolute normal path, in its job’s last step', () => {
    validate([
      { command: 'build', args: ['--ui'] },
      { command: 'run', args: [], interactive: true, profile: '/home/a/profiles/dev' },
    ]);
    validate([{ command: 'run', args: ['--', 'about:blank'], interactive: true }]);
    expect(() => {
      validate([{ command: 'run', args: [], profile: '/home/a/profiles/dev' }]);
    }).toThrow(/Only an interactive run keeps a profile/);
    for (const profile of ['profiles/dev', '/home/a/../b', '/home/a/', '', 7])
      expect(() => {
        validate([{ command: 'run', args: [], interactive: true, profile }]);
      }).toThrow(/absolute, normalized/);
    expect(() => {
      validate([{ command: 'test', args: ['a.js'], interactive: true }]);
    }).toThrow(/applies to a run step/);
    expect(() => {
      validate([{ command: 'run', args: [], interactive: 'yes' }]);
    }).toThrow(/applies to a run step/);
    expect(() => {
      validate([
        { command: 'run', args: [], interactive: true },
        { command: 'run', args: [], interactive: true },
      ]);
    }).toThrow(/last step of its job/);
    // A kept profile never reaches the browser any other way.
    for (const args of [
      ['--', '-P', 'dev'],
      ['--', '-profile', '/x'],
      ['--profile', 'p'],
    ])
      expect(() => {
        validate([{ command: 'run', args, interactive: true }]);
      }).toThrow(/profile/);
  });
});

describe('a request', () => {
  it('carries no plan version: nothing decides on one', () => {
    const request = normalizeRequest({ steps: [status] }, 'a'.repeat(64));
    expect(request).not.toHaveProperty('planVersion');
    validateRequest(request);
  });
  it('takes a short, printable label on a step, which progress shows', () => {
    const labelled = (label: unknown): unknown =>
      normalizeRequest({ steps: [{ ...status, label }] }, 'a'.repeat(64));
    validateRequest(labelled('lane:tiles'));
    for (const bad of ['', 'a\nb', 'x'.repeat(121), 7])
      expect(() => {
        validateRequest(labelled(bad));
      }).toThrow(/Step label must be 1 to 120 characters/);
  });
});

describe('choosing a slot for a job that named none', () => {
  const job = (compiledDigest?: string): Parameters<typeof chooseSlot>[0] =>
    ({
      pin: 'pin',
      request: { sourceId: 'source', steps: [] as JobStep[] },
      ...(compiledDigest === undefined ? {} : { compiledDigest }),
    }) as Parameters<typeof chooseSlot>[0];
  const slot = (id: string, extra: Partial<SlotView> = {}): SlotView => ({
    id,
    pin: 'pin',
    quarantined: null,
    ...extra,
  });

  it('prefers the slot already on this source, then a matching anchor, then any built slot', () => {
    const free = [
      slot('cold'),
      slot('other-anchor', { anchorDigest: 'other' }),
      slot('match', { anchorDigest: 'wanted' }),
      slot('same', { sourceId: 'source' }),
    ];
    expect(chooseSlot(job('wanted'), free)?.id).toBe('same');
    expect(chooseSlot(job('wanted'), free.slice(0, 3))?.id).toBe('match');
    expect(chooseSlot(job('wanted'), free.slice(0, 2))?.id).toBe('other-anchor');
    expect(chooseSlot(job('wanted'), free.slice(0, 1))?.id).toBe('cold');
    expect(chooseSlot(job(), [])).toBeUndefined();
  });

  it('never picks a slot on another pin', () => {
    expect(chooseSlot(job(), [slot('elsewhere', { pin: 'other' })])).toBeUndefined();
  });

  const uiJob = (extra: Partial<JobRecord> = {}): JobRecord => ({
    ...record('ui', 1, { command: 'build', args: ['--ui'] }, 'queued', null),
    pin: 'pin',
    compiledDigest: 'wanted',
    ...extra,
  });
  const views = (...slots: SlotView[]): Map<string, SlotView> =>
    new Map(slots.map((view) => [view.id, view]));

  it('never sends a job that needs a built slot to a cold one', () => {
    const cold = slot('cold');
    expect(chooseSlot(uiJob(), [cold])).toBeUndefined();
    expect(chooseSlot(uiJob(), [cold, slot('built', { anchorDigest: 'wanted' })])?.id).toBe(
      'built'
    );
    // Its compiled inputs differ, so the anchor it has is no use.
    expect(chooseSlot(uiJob(), [slot('other', { anchorDigest: 'other' })])).toBeUndefined();
    // The same source, condemned to a full build: preparing it changes nothing.
    expect(
      chooseSlot(uiJob({ request: { ...uiJob().request, sourceId: 'source' } }), [
        slot('stale', { anchorDigest: 'wanted', sourceId: 'source', requiresFullBuild: true }),
      ])
    ).toBeUndefined();
  });

  it('a job that reads a package goes only where that source’s package is', () => {
    const test = uiJob({
      request: {
        ...uiJob().request,
        sourceId: 'source',
        steps: [{ command: 'test', args: ['--headless', 'browser/a.js'] }],
      },
    });
    expect(chooseSlot(test, [slot('other', { packagedSource: 'elsewhere' })])).toBeUndefined();
    expect(chooseSlot(test, [slot('here', { packagedSource: 'source' })])?.id).toBe('here');
  });

  it('a full build needs nothing from a slot, and provides for the steps after it', () => {
    const full = uiJob({
      request: {
        ...uiJob().request,
        steps: [
          { command: 'build', args: [] },
          { command: 'build', args: ['--ui'] },
        ],
      },
    });
    expect(chooseSlot(full, [slot('cold')])?.id).toBe('cold');
  });

  it('waits, naming the slot, while a peer holds the only built slot', () => {
    const peer = { ...record('peer', 1, status, 'running', null), slot: 'built' };
    const plan = planAdmission([peer, uiJob()], {
      config,
      slots: views(slot('built', { anchorDigest: 'wanted' }), slot('cold')),
    });
    expect(plan.admit).toEqual([]);
    expect(plan.refuse.size).toBe(0);
    expect(plan.blocked.get('ui')).toMatch(/slot built, which has the build.*job peer/);
  });

  it('waits for a job that is building what it needs', () => {
    const peer = {
      ...record('peer', 1, build, 'running', null),
      slot: 'a',
      compiledDigest: 'wanted',
    };
    const plan = planAdmission([peer, uiJob()], { config, slots: views(slot('a'), slot('cold')) });
    expect(plan.refuse.size).toBe(0);
    expect(plan.blocked.get('ui')).toMatch(/job peer, which builds/);
  });

  it('waits for a job of the same source building the package its test reads', () => {
    const tester = {
      ...record('tester', 2, browser, 'queued', null),
      compiledDigest: 'wanted',
    };
    const peer = {
      ...record('peer', 1, { command: 'build', args: ['--ui'] }, 'running', null),
      slot: 'a',
      compiledDigest: 'wanted',
    };
    const waiting = planAdmission([peer, tester], {
      config,
      slots: views(slot('a'), slot('cold')),
    });
    expect(waiting.refuse.size).toBe(0);
    expect(waiting.blocked.get('tester')).toMatch(/job peer, which builds/);
    // Another source's build makes nothing this test can read.
    const elsewhere = {
      ...peer,
      request: { ...peer.request, sourceId: 'b'.repeat(64) },
    };
    const refused = planAdmission([elsewhere, tester], {
      config,
      slots: views(slot('a'), slot('cold')),
    });
    expect([...refused.refuse.values()][0]).toMatch(/no package of this source/);
  });

  it('refuses, saying what to run, when nothing on the host can ever serve the job', () => {
    const plan = planAdmission([uiJob()], { config, slots: views(slot('cold')) });
    expect([...plan.refuse.values()][0]).toMatch(/no full build.*fireforge job run --build full/);
    expect(
      whyNoSlotCanRun(uiJob(), views(slot('built', { anchorDigest: 'wanted' })), [])
    ).toBeUndefined();
    expect(whyNoSlotCanRun(uiJob(), views(slot('cold')), [])).toMatch(/no full build/);
  });

  it('names the quarantined slot that holds the build the job needs, and its remedy', () => {
    const held = views(
      slot('a'),
      slot('c', { anchorDigest: 'wanted', quarantined: 'cleanup uncertain' })
    );
    const full = whyNoSlotCanRun(uiJob(), held, []);
    expect(full).toMatch(/only in quarantined slot \(c: cleanup uncertain\)/);
    expect(full).toMatch(/fireforge slot restore c, adding --stop-orphans/);
    expect(full).not.toMatch(/Build one first/);
    const packaged = whyNoSlotCanRun(
      { ...record('t', 1, browser, 'queued', null), pin: 'pin', compiledDigest: 'wanted' },
      views(slot('c', { packagedSource: 'a'.repeat(64), quarantined: 'drift' })),
      []
    );
    expect(packaged).toMatch(/package of this source only in quarantined slot \(c: drift\)/);
    expect(packaged).toMatch(/slot restore c/);
  });

  it('names quarantined slots and restore when they are why a job waits', () => {
    const quiet = { ...record('quiet', 1, status, 'queued', null), pin: 'pin' };
    const plan = planAdmission([quiet], {
      config,
      slots: views(
        slot('a', { quarantined: 'Supervisor interruption' }),
        slot('b', { quarantined: 'drift' })
      ),
    });
    expect(plan.blocked.get('quiet')).toMatch(
      /quarantined a: Supervisor interruption; b: drift\. Run: fireforge slot restore a b/
    );
  });
});

describe('the display lease', () => {
  const headed: JobStep = { command: 'test', args: ['browser/a.js'] };

  it('holds a second window back and names the job and step holding the display', () => {
    const holder = record('holder', 1, headed, 'running');
    const waiting = record('waiting', 2, headed, 'queued');
    const plan = planAdmission([holder, waiting], { config });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual([]);
    expect(plan.blocked.get('waiting')).toBe('Waiting for the display, held by job holder step 0');
  });

  it('names the job admitted ahead in the same pass, and lets a headless step by', () => {
    const first = record('first', 1, headed, 'queued');
    const second = record('second', 2, headed, 'queued');
    const plan = planAdmission([first, second], { config });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['first']);
    expect(plan.blocked.get('second')).toBe('Waiting for the display, held by job first step 0');
    const headless = record('headless', 3, browser, 'queued');
    const behind = planAdmission([record('holder', 1, headed, 'running'), headless], {
      config: { capacity: { ...capacity, browser: 2 } },
    });
    expect(behind.admit.map((entry) => entry.job.id)).toContain('headless');
  });
});
