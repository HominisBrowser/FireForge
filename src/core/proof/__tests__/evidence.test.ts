// SPDX-License-Identifier: EUPL-1.2
/** The refusals a real run does not reach. What passes is proved end to end in the flow test. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { digest } from '../../authored/git.js';
import { executionEnvironmentDigest } from '../../jobs/evidence.js';
import type { JobRecord, JobStep, SealedReceipt, StepEvidence } from '../../jobs/schema.js';
import { evaluateProof, obligationMeaning, type ProofDecision, readEvidence } from '../evidence.js';
import type { CurrentIdentity } from '../identity.js';
import { createProofPlan, stepFingerprint } from '../plan.js';
import type { ProofPlan } from '../types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

const source = 'a'.repeat(64);
const compiled = 'c'.repeat(64);
const build = { compiled, native: 'n', toolchain: 't' };

function testPlan(proof: Parameters<typeof createProofPlan>[0]['proof'] = {}): ProofPlan {
  return createProofPlan({
    tier: 'gate',
    source,
    base: { commit: 'b', tree: 'c', label: 'x', narrowed: false },
    compiled,
    changed: [{ path: 'browser/a.css', tree: 'engine', route: 'source-link', deleted: false }],
    tests: [],
    touched: [],
    named: [],
    proof,
    controlTargets: { 'c.diff': ['browser/a.css'] },
  });
}

function stepEvidence(
  index: number,
  step: JobStep,
  fields: Partial<StepEvidence> = {}
): StepEvidence {
  const runtime = {
    sourceGeneration: 1,
    successfulBuildGeneration: 1,
    materializationDigest: 'm',
    derivedDigest: 'd',
    build,
  };
  return {
    runtimeBefore: runtime,
    runtimeAfter: runtime,
    sourceGeneration: 1,
    successfulBuildGeneration: 1,
    derivedDigest: 'd',
    index,
    command: step.command,
    args: step.args,
    startedAt: `2026-01-01T00:00:0${String(index)}Z`,
    finishedAt: `2026-01-01T00:00:0${String(index)}Z`,
    exitCode: 0,
    selectedFiles: step.expected?.files ?? [],
    completedRuns: [1],
    ...fields,
  };
}

function job(
  steps: JobStep[],
  evidence: StepEvidence[],
  fields: Partial<JobRecord> = {}
): JobRecord {
  const receipt = {
    slotGeneration: 1,
    projectToolsDigest: 'p',
    qualityToolsDigest: 'q',
    environmentDigest: 'e',
    steps: evidence,
  } as SealedReceipt;
  return {
    schemaVersion: 1,
    id: digest(evidence).slice(0, 12),
    owner: 'o',
    state: 'passed',
    epoch: 1,
    submittedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    cancellationRequested: false,
    executorToolsDigest: 'x',
    request: {
      schemaVersion: 1,
      key: 'k',
      sourceId: source,
      steps,
      quiet: false,
    },
    receipt,
    ...fields,
  };
}

/** The store as the journal gives it, so these go through the real reader. */
async function store(jobs: JobRecord[]): Promise<Awaited<ReturnType<typeof readEvidence>>> {
  const namespace = await mkdtemp(join(tmpdir(), 'fireforge-proof-evidence-'));
  directories.push(namespace);
  await mkdir(namespace, { recursive: true });
  await writeFile(
    join(namespace, 'journal.jsonl'),
    jobs.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  );
  return readEvidence(namespace, source);
}

/** The tools these fixtures' receipts were made with, as a slot holding the source answers now. */
const present = (fields: Partial<CurrentIdentity> = {}): CurrentIdentity => ({
  executor: 'x',
  environment: 'e',
  answers: [{ project: 'p', quality: 'q', exact: true }],
  ...fields,
});

const stateOf = (
  plan: ProofPlan,
  evidence: Awaited<ReturnType<typeof readEvidence>>,
  id: string,
  current: CurrentIdentity = present()
): string | undefined =>
  evaluateProof(plan, evidence, new Map(), current).obligations.find((entry) => entry.id === id)
    ?.state;

describe('what evidence cannot do', () => {
  const lane = { id: 'l', files: ['browser/t/browser_a.js'] };
  const plan = testPlan({ gate: { lanes: [lane] } });
  const laneStep = plan.obligations.find((entry) => entry.id === 'lane:l')?.step as JobStep;

  it('does not count a job that never reached its seal', async () => {
    for (const state of ['running', 'cancelled', 'interrupted'] as const) {
      const evidence = await store([job([laneStep], [stepEvidence(0, laneStep)], { state })]);
      expect(stateOf(plan, evidence, 'lane:l')).toBe(
        state === 'running' ? 'running' : 'outstanding'
      );
    }
    // A passed journal row is what makes a receipt count: a failed job's receipt field does not.
    const failed = job([laneStep], [stepEvidence(0, laneStep)], { state: 'failed' });
    expect(stateOf(plan, await store([failed]), 'lane:l')).toBe('red');
  });

  it('takes nothing from a job a person drove: an interactive run, kept profile or not', async () => {
    const runPlan = testPlan({ gate: { lanes: [lane], runs: [{ id: 'smoke', args: [] }] } });
    const declared = runPlan.obligations.find((entry) => entry.id === 'run:smoke')?.step as JobStep;
    const lanePlanStep = runPlan.obligations.find((entry) => entry.id === 'lane:l')
      ?.step as JobStep;
    // The same step a person drives: same command and arguments, so the same fingerprint.
    const driven = (fields: Partial<JobStep>): JobStep => ({ ...declared, ...fields });
    const sessions = [
      driven({ interactive: true }),
      driven({ interactive: true, profile: '/home/a/profiles/dev' }),
    ];
    for (const [index, session] of sessions.entries()) {
      const passed = job(
        [lanePlanStep, session],
        [stepEvidence(0, lanePlanStep), stepEvidence(1, session)],
        { id: `driven-${String(index)}` }
      );
      const evidence = await store([passed]);
      expect(evidence.rows).toEqual([]);
      expect(stateOf(runPlan, evidence, 'run:smoke')).toBe('outstanding');
      // Nothing else it ran counts either.
      expect(stateOf(runPlan, evidence, 'lane:l')).toBe('outstanding');
      const red = job([session], [], {
        id: `red-${String(index)}`,
        state: 'failed',
        phase: { index: 0, active: false, ticket: 1 },
      });
      delete red.receipt;
      expect(stateOf(runPlan, await store([red]), 'run:smoke')).toBe('outstanding');
      // A live session holds no obligation's place.
      const live = await store([
        job([session], [], { id: `live-${String(index)}`, state: 'running' }),
      ]);
      expect(live.live.size).toBe(0);
    }
    // The same job with no person at the window is evidence.
    const control = job(
      [lanePlanStep, declared],
      [stepEvidence(0, lanePlanStep), stepEvidence(1, declared)]
    );
    expect(stateOf(runPlan, await store([control]), 'run:smoke')).toBe('passed');
  });

  it('keeps a red red until a newer pass, and a red after a pass reads red', async () => {
    const pass = job([laneStep], [stepEvidence(0, laneStep)]);
    const red = job([laneStep], [], {
      id: 'red',
      state: 'failed',
      phase: { index: 0, active: false, ticket: 1 },
      updatedAt: '2026-01-01T00:02:00Z',
    });
    delete red.receipt;
    const report = evaluateProof(plan, await store([pass, red]), new Map(), present());
    const entry = report.obligations.find((row) => row.id === 'lane:l');
    expect(entry?.state).toBe('red');
    expect(entry?.reds).toBe(1);
    expect(report.complete).toBe(false);
  });

  it('writes no red for a job refused before its step started', async () => {
    const refused = job([laneStep], [], {
      id: 'refused',
      state: 'failed',
      refused: true,
      reason: 'The package moved since its build',
      phase: { index: 0, active: false, ticket: 1 },
      updatedAt: '2026-01-01T00:02:00Z',
    });
    delete refused.receipt;
    const report = evaluateProof(plan, await store([refused]), new Map(), present());
    const entry = report.obligations.find((row) => row.id === 'lane:l');
    expect(entry?.state).toBe('outstanding');
    expect(entry?.reds).toBe(0);
  });

  it('keeps a pass standing when a later job is refused', async () => {
    const pass = job([laneStep], [stepEvidence(0, laneStep)]);
    const refused = job([laneStep], [], {
      id: 'refused',
      state: 'failed',
      refused: true,
      phase: { index: 0, active: false, ticket: 1 },
      updatedAt: '2026-01-01T00:02:00Z',
    });
    delete refused.receipt;
    const report = evaluateProof(plan, await store([pass, refused]), new Map(), present());
    expect(report.obligations.find((row) => row.id === 'lane:l')?.state).toBe('passed');
  });

  it('counts only the steps before the red from a partial seal', async () => {
    const check = plan.obligations.find((entry) => entry.kind === 'check')?.step as JobStep;
    const partial = job([laneStep, check], [], {
      state: 'failed',
      phase: { index: 1, active: false, ticket: 1 },
      partialReceipt: job([laneStep], [stepEvidence(0, laneStep)]).receipt as SealedReceipt,
    });
    delete partial.receipt;
    const evidence = await store([partial]);
    expect(stateOf(plan, evidence, 'lane:l')).toBe('passed');
    expect(stateOf(plan, evidence, 'check')).toBe('red');
  });

  it('reads every verdict of a job that went on past its reds, and a blocked step as blocked', async () => {
    const gate = testPlan({
      gate: { lanes: [lane, { id: 'm', files: ['browser/t/browser_m.js'] }] },
    });
    const step = (id: string): JobStep =>
      gate.obligations.find((entry) => entry.id === id)?.step as JobStep;
    const steps = ['check', 'build', 'lane:l', 'lane:m'].map(step);
    // The check and lane l went red, lane m passed: one job, every verdict.
    const went = job(steps, [], {
      id: 'went-on',
      state: 'failed',
      reason: '2 of 4 steps red',
      phase: { index: 4, active: false, ticket: 1 },
      stepVerdicts: [
        { step: 0, state: 'red', reason: 'audit failed' },
        { step: 2, state: 'red', reason: 'browser_a.js failed' },
      ],
      partialReceipt: job(steps, [
        stepEvidence(1, steps[1] as JobStep),
        stepEvidence(3, steps[3] as JobStep),
      ]).receipt as SealedReceipt,
      request: {
        schemaVersion: 1,
        key: 'k',
        sourceId: source,
        steps,
        quiet: false,
        finalGate: true,
      },
    });
    delete went.receipt;
    const evidence = await store([went]);
    // Its reds are verdicts, not a seal that failed after every step passed.
    expect(evidence.failures).toEqual([]);
    const report = evaluateProof(gate, evidence, new Map(), present());
    const read = Object.fromEntries(report.obligations.map((entry) => [entry.id, entry]));
    expect(read['check']).toMatchObject({ state: 'red', detail: 'audit failed' });
    expect(read['lane:l']).toMatchObject({ state: 'red', detail: 'browser_a.js failed' });
    expect(read['build']?.state).toBe('passed');
    expect(read['lane:m']?.state).toBe('passed');
    expect(report.complete).toBe(false);

    // A red build blocks the lanes: no verdict on them, and nothing a pass can be read from.
    const blocked = job(steps, [], {
      id: 'blocked',
      state: 'failed',
      updatedAt: '2026-01-01T00:03:00Z',
      phase: { index: 4, active: false, ticket: 1 },
      stepVerdicts: [
        { step: 1, state: 'red', reason: 'build failed' },
        { step: 2, state: 'blocked', reason: 'Blocked by step 1 (build), which went red' },
        { step: 3, state: 'blocked', reason: 'Blocked by step 1 (build), which went red' },
      ],
      partialReceipt: job(steps, [stepEvidence(0, steps[0] as JobStep)]).receipt as SealedReceipt,
      request: {
        schemaVersion: 1,
        key: 'k',
        sourceId: source,
        steps,
        quiet: false,
        finalGate: true,
      },
    });
    delete blocked.receipt;
    const after = evaluateProof(gate, await store([blocked]), new Map(), present());
    const states = Object.fromEntries(after.obligations.map((entry) => [entry.id, entry]));
    expect(states['build']?.state).toBe('red');
    expect(states['lane:l']).toMatchObject({
      state: 'blocked',
      reds: 0,
      job: 'blocked',
      detail: 'Blocked by step 1 (build), which went red',
    });
    expect(states['lane:m']?.state).toBe('blocked');
    expect(after.complete).toBe(false);
    // A pass after the block decides; a block after a red leaves the red.
    const later = job([steps[2] as JobStep], [stepEvidence(0, steps[2] as JobStep)], {
      id: 'later',
      updatedAt: '2026-01-01T00:05:00Z',
    });
    expect(stateOf(gate, await store([blocked, later]), 'lane:l')).toBe('passed');
    expect(stateOf(gate, await store([went, blocked]), 'lane:l')).toBe('red');
  });

  it('refuses rows with another binary, toolchain, tool set or roster', async () => {
    const other = (fields: Partial<StepEvidence>): ReturnType<typeof store> =>
      store([job([laneStep], [stepEvidence(0, laneStep, fields)])]);
    const runtime = stepEvidence(0, laneStep).runtimeBefore;
    expect(
      stateOf(
        plan,
        await other({ runtimeAfter: { ...runtime, build: { ...build, compiled: 'z' } } }),
        'lane:l'
      )
    ).toBe('stale');
    expect(
      stateOf(plan, await other({}), 'lane:l', present({ toolchain: 'another-toolchain' }))
    ).toBe('stale');
    expect(stateOf(plan, await other({}), 'lane:l', present({ toolchain: 't' }))).toBe('passed');
    const unbuilt = { ...runtime };
    delete unbuilt.build;
    expect(stateOf(plan, await other({ runtimeAfter: unbuilt }), 'lane:l')).toBe('stale');
    expect(stateOf(plan, await other({ selectedFiles: [] }), 'lane:l')).toBe('stale');
    // Two identities never add up to one gate, even when each is one a slot still answers with.
    const check = plan.obligations.find((entry) => entry.kind === 'check')?.step as JobStep;
    const later = job([check], [stepEvidence(5, check)], { id: 'later' });
    later.receipt = {
      ...(later.receipt as SealedReceipt),
      qualityToolsDigest: 'q2',
      steps: [{ ...stepEvidence(0, check), finishedAt: '2026-01-02T00:00:00Z' }],
    };
    expect(
      stateOf(
        plan,
        await store([job([laneStep], [stepEvidence(0, laneStep)]), later]),
        'lane:l',
        present({
          answers: [
            { project: 'p', quality: 'q', exact: true },
            { project: 'p', quality: 'q2', exact: true },
          ],
        })
      )
    ).toBe('stale');
  });

  it('never lets an expected red prove a positive, or a control prove an unrelated path', async () => {
    const controlled = testPlan({
      gate: {
        controls: [{ id: 'g', diff: 'c.diff', test: 'browser/t/browser_a.js', assertions: ['x'] }],
      },
    });
    const control = controlled.obligations.find((entry) => entry.kind === 'control')
      ?.step as JobStep;
    const proof = (path: string): NonNullable<StepEvidence['controlProof']> => ({
      expectedAssertions: ['x'],
      actualAssertions: ['x'],
      mutations: [
        {
          run: 1,
          dispatch: 1,
          diffDigest: 'd',
          mutationVerified: true,
          restored: true,
          compiled: false,
          targets: [
            {
              path,
              originalSha256: 'a',
              mutatedSha256: 'b',
              mode: 0,
              restoredSha256: 'a',
              restoredMode: 0,
            },
          ],
        },
      ],
    });
    const run = (fields: Partial<StepEvidence>): ReturnType<typeof store> =>
      store([job([control], [stepEvidence(0, control, { control: 'caught', ...fields })])]);
    expect(
      stateOf(controlled, await run({ controlProof: proof('browser/a.css') }), 'control:g')
    ).toBe('passed');
    expect(
      stateOf(controlled, await run({ controlProof: proof('browser/test/x.js') }), 'control:g')
    ).toBe('stale');
    // A project that requires it on every gate asks that it catches, not what it mutates.
    const always = testPlan({
      gate: {
        controls: [
          {
            id: 'g',
            diff: 'c.diff',
            test: 'browser/t/browser_a.js',
            assertions: ['x'],
            always: true,
          },
        ],
      },
    });
    expect(
      stateOf(always, await run({ controlProof: proof('browser/test/x.js') }), 'control:g')
    ).toBe('passed');
    expect(
      stateOf(always, await store([job([control], [stepEvidence(0, control)])]), 'control:g')
    ).toBe('stale');
    expect(
      stateOf(always, await run({ controlProof: { ...proof('x'), mutations: [] } }), 'control:g')
    ).toBe('stale');
    // A receipt whose environment is not the request's proves nothing about the request.
    const declared = { ...control, env: { PROJECT_CAPTURE: '1' } };
    expect(
      stateOf(
        controlled,
        await store([job([declared], [stepEvidence(0, declared, { control: 'caught' })])]),
        'control:g'
      )
    ).toBe('outstanding');
    const positive = store([
      job(
        [laneStep],
        [stepEvidence(0, laneStep, { control: 'caught', controlProof: proof('browser/a.css') })]
      ),
    ]);
    expect(stateOf(plan, await positive, 'lane:l')).toBe('stale');
  });

  it('needs every repeat of a stress, in order', async () => {
    const stressed = testPlan({
      gate: { stress: [{ id: 's', files: ['browser/t/browser_a.js'], repeat: 3 }] },
    });
    const step = stressed.obligations.find((entry) => entry.kind === 'stress')?.step as JobStep;
    const runs = async (completedRuns: number[]): Promise<string | undefined> =>
      stateOf(
        stressed,
        await store([job([step], [stepEvidence(0, step, { completedRuns })])]),
        'stress:s'
      );
    expect(await runs([1, 2, 3])).toBe('passed');
    expect(await runs([1, 2])).toBe('stale');
    expect(await runs([1, 1, 3])).toBe('stale');
  });

  it('requires the check from a final gate job, with its contract', async () => {
    const check = plan.obligations.find((entry) => entry.kind === 'check')?.step as JobStep;
    const evidence = await store([job([check], [stepEvidence(0, check)])]);
    const entry = evaluateProof(plan, evidence, new Map(), present()).obligations.find(
      (row) => row.id === 'check'
    );
    expect(entry?.state).toBe('stale');
    expect(entry?.detail).toContain('final gate');
    const build = { command: 'build' as const, args: [] };
    const planned = testPlan({ gate: { build: 'full' } });
    const built = await store([job([build], [stepEvidence(0, build)])]);
    expect(stateOf(planned, built, 'build')).toBe('stale');
    const gated = job([build], [stepEvidence(0, build)]);
    gated.request.finalGate = true;
    expect(stateOf(planned, await store([gated]), 'build')).toBe('passed');
  });

  it('keys on what a step did: a different argument is not the same evidence', async () => {
    const other = { ...laneStep, args: [...laneStep.args, '--harness-retries', '1'] };
    expect(stepFingerprint(other)).not.toBe(stepFingerprint(laneStep));
    expect(stateOf(plan, await store([job([other], [stepEvidence(0, other)])]), 'lane:l')).toBe(
      'outstanding'
    );
  });
});

describe('evidence against the present tools', () => {
  const css = { path: 'browser/a.css', tree: 'engine', route: 'source-link', deleted: false };
  const named = 'browser/t/browser_a.js';
  const taskPlan = createProofPlan({
    tier: 'task',
    source,
    base: { commit: 'b', tree: 'c', label: 'x', narrowed: false },
    compiled,
    changed: [css as ProofPlan['changed'][number]],
    tests: [],
    touched: [],
    named: [named],
    controlTargets: {},
  });
  const steps = taskPlan.obligations.flatMap((entry) => (entry.step ? [entry.step] : []));
  const evidence = (): ReturnType<typeof store> =>
    store([
      job(
        steps,
        steps.map((step, index) => stepEvidence(index, step))
      ),
    ]);
  const states = async (current: CurrentIdentity): Promise<Record<string, string>> =>
    Object.fromEntries(
      evaluateProof(taskPlan, await evidence(), new Map(), current).obligations.map((entry) => [
        entry.id,
        entry.state,
      ])
    );
  const test = `test:${named}`;

  it('a task re-runs only what a changed tool can reach', async () => {
    expect(await states(present())).toEqual({
      static: 'passed',
      build: 'passed',
      [test]: 'passed',
    });
    // An ESLint upgrade reaches lint, never a browser test or a build.
    expect(
      await states(present({ answers: [{ project: 'p', quality: 'new', exact: true }] }))
    ).toEqual({ static: 'stale', build: 'passed', [test]: 'passed' });
    // FireForge decides what a test's log counts as. A build is not its output.
    expect(await states(present({ executor: 'new' }))).toEqual({
      static: 'passed',
      build: 'passed',
      [test]: 'stale',
    });
    // A locale or kernel change reaches a browser, and not lint.
    expect(await states(present({ environment: 'new' }))).toEqual({
      static: 'passed',
      build: 'passed',
      [test]: 'stale',
    });
    // Changed tool bytes reach whatever runs on the build.
    expect(await states(present({ toolchainProblem: 'bytes changed' }))).toEqual({
      static: 'passed',
      build: 'stale',
      [test]: 'stale',
    });
  });

  it('a gate binds every result to the whole identity, whichever tool moved', async () => {
    const lane = { id: 'l', files: [named] };
    const gatePlan = testPlan({ gate: { lanes: [lane] } });
    const laneStep = gatePlan.obligations.find((entry) => entry.id === 'lane:l')?.step as JobStep;
    const rows = await store([job([laneStep], [stepEvidence(0, laneStep)])]);
    for (const moved of [
      { answers: [{ project: 'p', quality: 'new', exact: true }] },
      { answers: [{ project: 'new', quality: 'q', exact: true }] },
      { executor: 'new' },
      { environment: 'new' },
      { toolchainProblem: 'bytes changed' },
    ]) {
      expect(stateOf(gatePlan, rows, 'lane:l', present())).toBe('passed');
      expect(stateOf(gatePlan, rows, 'lane:l', present(moved))).toBe('stale');
    }
  });

  it('only a slot on this source can call quality tools changed; any slot can say they match', async () => {
    const elsewhere = { project: 'p', quality: 'other', exact: false };
    const report = evaluateProof(
      taskPlan,
      await evidence(),
      new Map(),
      present({ answers: [elsewhere] })
    );
    const lint = report.obligations.find((entry) => entry.id === 'static');
    expect(lint?.state).toBe('stale');
    expect(lint?.needsSlot).toBe(true);
    expect(lint?.detail).toContain('No slot holds this source');
    const same = { project: 'p', quality: 'q', exact: false };
    expect((await states(present({ answers: [elsewhere, same] })))['static']).toBe('passed');
    // No slot at all is no answer, and no answer is never a pass.
    expect((await states(present({ answers: [] })))['static']).toBe('stale');
    const blind = present({ unmeasured: 'runtime gone' });
    delete blind.executor;
    expect((await states(blind))[test]).toBe('stale');
  });
});

describe('human decisions', () => {
  const gatePlan = testPlan({
    gate: {
      lanes: [{ id: 'captures', files: ['browser/t/browser_a.js'] }],
      acceptance: [{ id: 'scene', reason: 'A person looks.', evidence: ['lane:captures'] }],
    },
  });
  const obligation = (id: string): ProofPlan['obligations'][number] => {
    const found = gatePlan.obligations.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(id);
    return found;
  };
  const decide = (id: string, fields: Partial<ProofDecision> = {}): ProofDecision => ({
    kind: id.startsWith('accept:') ? 'accepted' : 'waived',
    source,
    obligation: id,
    tier: 'gate',
    meaning: obligationMeaning('gate', obligation(id)),
    note: 'n',
    by: 'b',
    at: '2026-01-01T00:00:00Z',
    ...fields,
  });
  const none = {
    rows: [],
    blocked: new Map(),
    live: new Map<string, string>(),
    failures: [],
    finished: 0,
  };
  const state = (
    plan: ProofPlan,
    decision: ProofDecision,
    rows: Awaited<ReturnType<typeof readEvidence>> = none
  ): string | undefined =>
    evaluateProof(
      plan,
      rows,
      new Map([[decision.obligation, decision]]),
      present()
    ).obligations.find((entry) => entry.id === decision.obligation)?.state;

  it('binds a decision to the tier and to what the obligation means', () => {
    expect(state(gatePlan, decide('build'))).toBe('waived');
    const atTask = obligationMeaning('task', obligation('build'));
    expect(state(gatePlan, decide('build', { meaning: atTask }))).toBe('outstanding');
    expect(state(gatePlan, decide('build', { meaning: 'something else' }))).toBe('outstanding');
    const full = testPlan({
      gate: {
        build: 'full',
        lanes: [{ id: 'captures', files: ['browser/t/browser_a.js'] }],
        acceptance: [{ id: 'scene', reason: 'A person looks.', evidence: ['lane:captures'] }],
      },
    });
    expect(state(full, decide('build'))).toBe('outstanding');
  });

  it('reports what was waived, and never takes a waiver for an acceptance', () => {
    const report = evaluateProof(gatePlan, none, new Map([['build', decide('build')]]), present());
    expect(report.waived).toEqual(['build']);
    expect(state(gatePlan, decide('accept:scene', { kind: 'waived' }))).toBe('outstanding');
    expect(state(gatePlan, decide('build', { kind: 'accepted' }))).toBe('outstanding');
  });

  it('holds an acceptance to the run it was made on', async () => {
    const lane = obligation('lane:captures').step as JobStep;
    const first = job([lane], [stepEvidence(0, lane)], { id: 'first' });
    const accepted = decide('accept:scene', {
      evidence: [{ obligation: 'lane:captures', job: 'first' }],
    });
    expect(state(gatePlan, accepted, await store([first]))).toBe('accepted');
    // Nothing looked at what a later run wrote.
    const later = job([lane], [stepEvidence(0, lane, { finishedAt: '2026-01-02T00:00:00Z' })], {
      id: 'later',
    });
    const report = evaluateProof(
      gatePlan,
      await store([first, later]),
      new Map([['accept:scene', accepted]]),
      present()
    );
    const entry = report.obligations.find((row) => row.id === 'accept:scene');
    expect(entry?.state).toBe('outstanding');
    expect(entry?.detail).toContain('Look again');
  });
});

describe('carried evidence', () => {
  const commit = 'v'.repeat(40);
  const proof = {
    gate: {
      lanes: [{ id: 'captures', files: ['browser/t/browser_a.js'] }],
      acceptance: [{ id: 'scene', reason: 'A person looks.', evidence: ['lane:captures'] }],
    },
  };
  const docsPlan = (carry: boolean): ProofPlan =>
    createProofPlan({
      tier: 'gate',
      source,
      base: { commit, tree: 't', label: 'x', narrowed: false },
      compiled,
      changed: [{ path: 'docs/a.md', tree: 'root', route: 'none', deleted: false }],
      tests: [],
      touched: [],
      named: [],
      proof,
      controlTargets: {},
      ...(carry ? { carry: { commit, tree: 't', source: 's'.repeat(64) } } : {}),
    });
  const plan = docsPlan(true);
  const stepOf = (id: string): JobStep =>
    plan.obligations.find((entry) => entry.id === id)?.step as JobStep;
  const none = {
    rows: [],
    blocked: new Map(),
    live: new Map<string, string>(),
    failures: [],
    finished: 0,
  };
  const decision = (id: string, kind: ProofDecision['kind']): ProofDecision => ({
    kind,
    source: 's'.repeat(64),
    obligation: id,
    tier: 'gate',
    meaning: obligationMeaning(
      'gate',
      plan.obligations.find((entry) => entry.id === id) as ProofPlan['obligations'][number]
    ),
    evidence: id === 'accept:scene' ? [{ obligation: 'lane:captures', job: 'lane' }] : [],
    note: 'n',
    by: 'b',
    at: '2026-01-01T00:00:00Z',
  });

  it('carries everything but check, and says from where', async () => {
    expect(
      plan.obligations.filter((entry) => entry.carried !== true).map((entry) => entry.id)
    ).toEqual(['check']);
    expect(docsPlan(false).obligations.some((entry) => entry.carried === true)).toBe(false);
    const lane = stepOf('lane:captures');
    const check = stepOf('check');
    const verified = await store([
      job([lane], [stepEvidence(0, lane)], { id: 'lane' }),
      job([check], [stepEvidence(0, check)], { id: 'check' }),
    ]);
    const carried = {
      store: verified,
      decisions: new Map([['accept:scene', decision('accept:scene', 'accepted')]]),
    };
    const report = evaluateProof(plan, none, new Map(), present(), carried);
    const entry = (id: string): (typeof report.obligations)[number] | undefined =>
      report.obligations.find((row) => row.id === id);
    expect(entry('lane:captures')).toMatchObject({ state: 'passed', job: 'lane', carried: commit });
    expect(entry('accept:scene')).toMatchObject({ state: 'accepted', carried: commit });
    // The verified source's check is not this tree's check: it reads as though it never ran.
    expect(entry('check')?.state).toBe('outstanding');
    expect(entry('check')?.carried).toBeUndefined();
    // A plan that carries nothing takes nothing from a carried store.
    const plain = evaluateProof(docsPlan(false), none, new Map(), present(), carried);
    expect(plain.obligations.find((row) => row.id === 'lane:captures')?.state).toBe('outstanding');
  });

  it('never carries a waiver, and a red here outranks a carried pass', async () => {
    const lane = stepOf('lane:captures');
    const carried = {
      store: none,
      decisions: new Map([['lane:captures', decision('lane:captures', 'waived')]]),
    };
    const waived = evaluateProof(plan, none, new Map(), present(), carried);
    expect(waived.obligations.find((row) => row.id === 'lane:captures')?.state).toBe('outstanding');
    expect(waived.waived).toEqual([]);
    const red = job([lane], [], {
      id: 'red',
      state: 'failed',
      phase: { index: 0, active: false, ticket: 1 },
      updatedAt: '2026-01-02T00:00:00Z',
    });
    delete red.receipt;
    const report = evaluateProof(plan, await store([red]), new Map(), present(), {
      store: await store([job([lane], [stepEvidence(0, lane)], { id: 'lane' })]),
      decisions: new Map(),
    });
    expect(report.obligations.find((row) => row.id === 'lane:captures')?.state).toBe('red');
  });
});

describe('the environment digest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores whatever names a job, a slot or a host path, and sees what can change a result', () => {
    const before = executionEnvironmentDigest();
    vi.stubEnv('FIREFORGE_JOB_ID', 'another-job');
    vi.stubEnv('FIREFORGE_JOB_PHASE', 'another-phase');
    vi.stubEnv('FIREFORGE_EXECUTION_ROOT', '/another/slot/root');
    vi.stubEnv('MOZBUILD_STATE_PATH', '/another/slot/root/.fireforge/native-state');
    vi.stubEnv('PATH', '/another/toolchain/bin');
    vi.stubEnv('CC', '/another/toolchain/bin/clang');
    expect(executionEnvironmentDigest()).toBe(before);
    vi.stubEnv('LANG', 'another-locale');
    expect(executionEnvironmentDigest()).not.toBe(before);
  });
});
