// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { authorizeRequest, currentResources, planAdmission } from '../admission.js';
import { recordSuccessfulBuild } from '../build-identity.js';
import { authenticateAdapterInputs } from '../captured-inputs.js';
import { cancelJob, initializeCoordinator, readJobLogs, submitJob, waitForJob } from '../client.js';
import { electSupervisor } from '../election.js';
import { testStepEvidence } from '../evidence.js';
import { authorizeExecution } from '../phase-capability.js';
import { stampPhaseReport } from '../phase-report.js';
import { isSameProcess, processIdentityAsync } from '../process.js';
import {
  type CoordinatorConfig,
  type JobRecord,
  type JobRequest,
  type JobStep,
  quietLoadLimit,
  validateRequest,
} from '../schema.js';
import { createSlot, removeSlot } from '../slot-lifecycle.js';
import { auditSlot, prepareSlot, readSlot } from '../slots.js';
import {
  appendTransition,
  readJournal,
  readJournalContents,
  readJson,
  slotDirectory,
  writeDurable,
} from '../store.js';
import { LocalSupervisor } from '../supervisor.js';

// Real processes and real clones, beside whatever else the suite is running.
vi.setConfig({ testTimeout: 180_000 });

const temporary: string[] = [];
const servers: LocalSupervisor[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* A server may already have idled out. */
    }
  }
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const config: CoordinatorConfig = {
  schemaVersion: 1,
  capacity: { cpu: 14, memory: 28, build: 1, browser: 1, display: 1 },
  maxSlots: 3,
  idleMs: 60_000,
  legacyExcluded: true,
  projects: [],
  runtime: { node: process.execPath, environment: {} },
};
const select = (jobs: readonly JobRecord[], context: typeof config): JobRecord[] =>
  planAdmission(jobs, { config: context }).admit.map((entry) => entry.job);
function request(slot = 'a'): JobRequest {
  return {
    schemaVersion: 1,
    key: randomUUID(),
    slot,
    sourceId: 'a'.repeat(64),
    steps: [{ command: 'status', args: [] }],
    quiet: false,
  };
}
function record(slot: string, index: number, state: JobRecord['state'] = 'queued'): JobRecord {
  return {
    schemaVersion: 1,
    id: `${slot}-${index}`,
    owner: 'owner',
    request: request(slot),
    state,
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    phase: { index: 0, active: state === 'running', ticket: index },
  };
}
async function fixture(): Promise<
  Awaited<ReturnType<typeof sourceFixture>> & {
    namespace: string;
    snapshot: Awaited<ReturnType<typeof captureAuthoredSnapshot>>;
  }
> {
  const value = await sourceFixture();
  temporary.push(dirname(value.root));
  const namespace = join(dirname(value.root), 'coordinator');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src'],
    pristineRepository: value.pristine,
  });
  return { ...value, namespace, snapshot };
}

describe('atomic admission and capabilities', () => {
  it('overlaps one build with a build-less browser on another slot', () => {
    const build = record('a', 1);
    build.request.steps = [{ command: 'build', args: [] }];
    const browser = record('b', 2);
    browser.request.steps = [{ command: 'test', args: ['--headless'] }];
    expect(select([build, browser], config).map((job) => job.id)).toEqual([build.id, browser.id]);
    expect(currentResources(browser).build).toBe(0);
    const control = record('c', 3);
    control.request.steps = [
      { command: 'test', args: ['--headless', '--negative-control', 'control.diff'] },
    ];
    expect(currentResources(control).build).toBe(1);
    control.request.steps = [
      { command: 'test', args: ['--headless', '--negative-control=control.diff'] },
    ];
    expect(currentResources(control).build).toBe(1);
  });
  it('drains for a quiet waiter without letting later static work starve it', () => {
    const active = record('a', 1, 'running');
    const quiet = record('b', 2);
    quiet.request.quiet = true;
    const later = record('c', 3);
    expect(select([active, quiet, later], config)).toEqual([]);
    active.state = 'passed';
    expect(select([active, quiet, later], config).map((job) => job.id)).toEqual([quiet.id]);
    quiet.state = 'running';
    if (quiet.phase) quiet.phase.active = true;
    expect(select([active, quiet, later], config)).toEqual([]);
  });
  it('grants no resources to a waiting phase and prevents two owners of one slot', () => {
    const first = record('a', 3, 'running');
    if (first.phase) first.phase.active = false;
    const same = record('a', 1);
    const other = record('b', 2);
    expect(select([first, same, other], config).map((job) => job.id)).toEqual([other.id, first.id]);
  });
  it('rejects resource understatement and quiet without a legacy exclusion window', () => {
    const candidate = request();
    candidate.steps = [
      {
        command: 'build',
        args: [],
        resources: { cpu: 2, memory: 2, build: 0, browser: 0, display: 0 },
      },
    ];
    expect(() => {
      authorizeRequest(candidate, config);
    }).toThrow(/understates/);
    candidate.steps = [{ command: 'status', args: [] }];
    candidate.quiet = true;
    expect(() => {
      authorizeRequest(candidate, { ...config, legacyExcluded: false });
    }).toThrow(/host init/);
  });
});

describe('durable source and execution boundaries', () => {
  it('creates clean stable slots from captured inputs, never donor secrets/profiles, and audits stray writes', async () => {
    const f = await fixture();
    await writeAt(f.root, 'secrets/signing-key', 'secret');
    await writeAt(f.pristine, 'obj-old/tmp/profile-default/cookies.sqlite', 'cookies');
    const slot = await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    expect(await readFile(join(slot.root, 'src/browser/new.js'), 'utf8')).toContain('value = 1');
    expect(await readFile(join(slot.root, 'engine/browser/new.js'), 'utf8')).toContain('value = 1');
    await expect(readFile(join(slot.root, 'secrets/signing-key'))).rejects.toThrow();
    await expect(
      readFile(join(slot.root, 'engine/obj-old/tmp/profile-default/cookies.sqlite'))
    ).rejects.toThrow();
    expect((await auditSlot(f.namespace, slot)).runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
    await writeAt(slot.root, 'engine/browser/manifest.txt', 'undeclared change');
    await expect(auditSlot(f.namespace, slot)).rejects.toThrow(/Undeclared engine drift/);
  });
  it('replays durable transitions and truncates an unacknowledged partial tail before another append', async () => {
    const f = await fixture();
    await mkdir(f.namespace, { recursive: true });
    const job = record('a', 1);
    await appendTransition(f.namespace, job);
    await appendFile(join(f.namespace, 'journal.jsonl'), '{"truncated":');
    const repaired = await readJournalContents(f.namespace, { repairTail: true });
    expect(repaired.jobs.get(job.id)?.state).toBe('queued');
    job.state = 'cancelled';
    await appendTransition(f.namespace, job);
    expect((await readJournal(f.namespace)).get(job.id)?.state).toBe('cancelled');
  });
  it('elects only one supervisor while its owner lives', async () => {
    const f = await fixture();
    await mkdir(f.namespace, { recursive: true });
    const election = await electSupervisor(f.namespace);
    await expect(electSupervisor(f.namespace)).rejects.toThrow(/running/);
    expect(await isSameProcess({ ...election.owner, start: 'reused-pid' })).toBe(false);
    expect((await processIdentityAsync(process.pid))?.pid).toBe(process.pid);
    await election.release();
    const next = await electSupervisor(f.namespace);
    expect(next.epoch).toBe(election.epoch + 1);
    await next.release();
  });
  it('keeps durable submit idempotent and records cancellation without a passing receipt', async () => {
    const f = await fixture();
    await initializeCoordinator(f.namespace, { idleMs: 60_000 });
    await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    const server = await LocalSupervisor.start(f.namespace);
    servers.push(server);
    const input = request();
    input.sourceId = f.snapshot.id;
    const submitted = await submitJob(f.namespace, input, f.snapshot);
    const duplicate = await submitJob(f.namespace, input, f.snapshot);
    expect(duplicate.id).toBe(submitted.id);
    await cancelJob(f.namespace, submitted.id);
    const outcome = await waitForJob(f.namespace, submitted.id, 10_000);
    expect(outcome.state).toBe('cancelled');
    expect(outcome.receipt).toBeUndefined();
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
  }, 20_000);
  it('lets a repeated init change what it states and nothing else', async () => {
    const f = await fixture();
    const first = await initializeCoordinator(f.namespace, { cpu: 8, maxSlots: 2 });
    expect(first.capacity.cpu).toBe(8);
    expect(first.legacyExcluded).toBe(false);
    const second = await initializeCoordinator(f.namespace, { legacyExcluded: true });
    expect(second).toMatchObject({ maxSlots: 2, legacyExcluded: true });
    expect(second.capacity.cpu).toBe(8);
    // The quiet limit follows the CPU budget until a limit is stated, which then stays.
    expect(quietLoadLimit(second)).toBe(8);
    await initializeCoordinator(f.namespace, { quietLoad: 5 });
    const third = await initializeCoordinator(f.namespace, { cpu: 12 });
    expect(quietLoadLimit(third)).toBe(5);
  });
  it('seals an exact two-phase source-native job and makes its receipt independent of slot reuse', async () => {
    const f = await fixture();
    await initializeCoordinator(f.namespace);
    await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    servers.push(await LocalSupervisor.start(f.namespace));
    const input = request();
    input.sourceId = f.snapshot.id;
    input.steps = [
      { command: 'status', args: [] },
      { command: 'status', args: [] },
    ];
    const job = await submitJob(f.namespace, input, f.snapshot);
    await rm(f.root, { recursive: true });
    await rm(f.pristine, { recursive: true });
    const outcome = await waitForJob(f.namespace, job.id, 40_000);
    if (outcome.state !== 'passed')
      throw new Error(
        `${outcome.reason}; logs=${JSON.stringify(await readJobLogs(f.namespace, job.id))}`
      );
    expect(outcome.receipt?.steps).toHaveLength(2);
    expect(outcome.receipt?.steps[0]?.runtimeBefore.sourceGeneration).toBe(
      outcome.receipt?.runtimeIdentity.sourceGeneration
    );
    expect(outcome.receipt?.steps[1]?.runtimeAfter?.successfulBuildGeneration).toBe(
      outcome.receipt?.runtimeIdentity.successfulBuildGeneration
    );
    expect(outcome.receipt?.toolsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.receipt?.runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
    const journaled = (await readJournal(f.namespace)).get(job.id);
    expect(journaled?.receipt?.jobId).toBe(job.id);
    // Admission stamps when the job and its current phase started, which progress reads.
    expect(Date.parse(journaled?.startedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(journaled?.submittedAt ?? '')
    );
    expect(Date.parse(journaled?.phase?.startedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(journaled?.startedAt ?? '')
    );
  }, 60_000);
  it('keeps an acknowledged job alive after the submitting process exits', async () => {
    const f = await fixture();
    await initializeCoordinator(f.namespace, { idleMs: 200 });
    await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    const input = request();
    input.sourceId = f.snapshot.id;
    const submission = join(dirname(f.root), 'submission.json');
    await writeDurable(submission, {
      namespace: f.namespace,
      request: input,
      snapshot: f.snapshot,
    });
    const script = `import {readFile} from 'node:fs/promises'; import {submitJob} from ${JSON.stringify(new URL('../client.ts', import.meta.url).href)}; const x=JSON.parse(await readFile(process.argv[1],'utf8')); const job=await submitJob(x.namespace,x.request,x.snapshot); process.stdout.write(JSON.stringify({id:job.id,pid:process.pid}));`;
    const caller = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx/esm'),
          '--input-type=module',
          '-e',
          script,
          submission,
        ],
        { encoding: 'utf8', timeout: 60_000 }
      )
    ) as { id: string; pid: number };
    expect(await processIdentityAsync(caller.pid)).toBeUndefined();
    const outcome = await waitForJob(f.namespace, caller.id, 60_000);
    expect(outcome.state).toBe('passed');
    expect((await readJournal(f.namespace)).get(caller.id)?.state).toBe(outcome.state);
    // The detached supervisor retires before the fixture directory is removed.
    for (let i = 0; i < 100; i += 1) {
      try {
        await readFile(join(f.namespace, 'endpoint.json'));
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 150_000);
  it('recovers an interrupted owned job as interrupted and quarantines its slot before admission', async () => {
    const f = await fixture();
    await initializeCoordinator(f.namespace);
    await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    const job = record('a', 1, 'running');
    job.process = { pid: 999_999_999, start: 'not-live' };
    await appendTransition(f.namespace, job);
    const server = await LocalSupervisor.start(f.namespace);
    servers.push(server);
    expect((await readJournal(f.namespace)).get(job.id)?.state).toBe('interrupted');
    expect(
      (await readJson<{ quarantined: string }>(join(slotDirectory(f.namespace, 'a'), 'slot.json')))
        .quarantined
    ).toMatch(/interruption/);
  });
});

describe('exact dispatch evidence', () => {
  it('accepts only the expected control assertion with verified mutation and byte/mode restoration', async () => {
    const f = await fixture();
    const path = join(dirname(f.root), 'control-results.json');
    const diff = join(f.root, 'control.diff');
    await writeFile(diff, 'a captured mutation');
    f.snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src', 'control.diff'],
      pristineRepository: f.pristine,
    });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update('a captured mutation').digest('hex');
    const step = {
      command: 'test' as const,
      args: ['--headless', '--negative-control', 'control.diff'],
      controlAssertions: ['guard refuses private write'],
      expected: {
        files: ['browser/a.js'],
      },
    };
    const results = {
      schemaVersion: 1,
      unfinished: [],
      files: [
        {
          test: 'browser/a.js',
          run: 1,
          status: 'OK',
          expected: 'OK',
          unexpectedSubtests: 1,
          unexpected: true,
          unexpectedAssertions: ['guard refuses private write'],
          unexpectedAssertionResults: [
            { assertion: 'guard refuses private write', status: 'FAIL', expected: 'PASS' },
          ],
        },
      ],
      dispatches: [
        {
          run: 1,
          shard: 'a',
          requested: ['browser/a.js'],
          started: ['browser/a.js'],
          completed: ['browser/a.js'],
          skipped: [],
          unfinished: [],
          attempts: 1,
        },
      ],
      controls: [
        {
          run: 1,
          diffDigest: hash,
          mutationVerified: true,
          restored: true,
          compiled: true,
          compiledRestoreBuild: 'done',
          targets: [
            {
              path: 'browser/source.js',
              originalSha256: 'a'.repeat(64),
              mutatedSha256: 'b'.repeat(64),
              mode: 0o644,
              restoredSha256: 'a'.repeat(64),
              restoredMode: 0o644,
            },
          ],
        },
      ],
    };
    await writeFile(path, JSON.stringify(results));
    expect((await testStepEvidence(step, path, f.snapshot)).control).toBe('caught');
    await expect(testStepEvidence(step, path)).rejects.toThrow(/captured input/);
    await expect(
      authenticateAdapterInputs(f.snapshot, {
        ...step,
        args: ['--negative-control', '.fireforge/controls/old.diff'],
      })
    ).rejects.toThrow(/ordinary captured/);
    await expect(
      authenticateAdapterInputs(f.snapshot, {
        ...step,
        args: ['--profile-file', 'missing.js=user.js'],
      })
    ).rejects.toThrow(/not captured/);
    await expect(
      authenticateAdapterInputs(f.snapshot, {
        command: 'run',
        args: ['--console-allow-file', '.fireforge/allow.txt'],
      })
    ).rejects.toThrow(/ordinary captured/);
    await authenticateAdapterInputs(f.snapshot, {
      ...step,
      args: ['--profile-file', 'control.diff=user.js'],
    });
    const control = results.controls[0];
    const file = results.files[0];
    if (!control || !file) throw new Error('Missing fixture evidence');
    file.status = 'TIMEOUT';
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/unrelated unexpected/);
    file.status = 'OK';
    file.unexpectedAssertionResults.push({
      assertion: 'unexpected pass',
      status: 'PASS',
      expected: 'FAIL',
    });
    file.unexpectedSubtests = 2;
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/unrelated unexpected/);
    file.unexpectedAssertionResults.pop();
    file.unexpectedSubtests = 1;
    file.unexpectedAssertionResults = [
      { assertion: 'guard refuses private write', status: 'PASS', expected: 'FAIL' },
    ];
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/unexpected assertion/);
    file.unexpectedAssertionResults = [
      { assertion: 'guard refuses private write', status: 'FAIL', expected: 'PASS' },
    ];
    control.restored = false;
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/restore/);
    control.restored = true;
    control.compiledRestoreBuild = 'failed';
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/restore/);
    control.compiledRestoreBuild = 'done';
    file.unexpectedAssertions = ['unrelated failure'];
    file.unexpectedAssertionResults = [
      { assertion: 'unrelated failure', status: 'FAIL', expected: 'PASS' },
    ];
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/unexpected assertion/);
  });
  it('accepts an xpcshell red by its assertion text or its task, and names both when neither matches', async () => {
    const f = await fixture();
    const path = join(dirname(f.root), 'xpcshell-control-results.json');
    await writeFile(join(f.root, 'control.diff'), 'a captured mutation');
    f.snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src', 'control.diff'],
      pristineRepository: f.pristine,
    });
    const { createHash } = await import('node:crypto');
    const step = (assertions: string[]): JobStep => ({
      command: 'test',
      args: ['--headless', '--negative-control', 'control.diff'],
      controlAssertions: assertions,
      expected: { files: ['browser/unit/test_wire.js'] },
    });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        unfinished: [],
        files: [
          {
            test: 'browser/unit/test_wire.js',
            run: 1,
            status: 'FAIL',
            expected: 'PASS',
            unexpectedSubtests: 1,
            unexpected: true,
            unexpectedAssertions: ['test_wire_three_streams'],
            unexpectedAssertionResults: [
              {
                assertion: 'test_wire_three_streams',
                status: 'FAIL',
                expected: 'PASS',
                message: 'the stream settled - false == true',
              },
            ],
          },
        ],
        dispatches: [
          {
            run: 1,
            shard: 'a',
            requested: ['browser/unit/test_wire.js'],
            started: ['browser/unit/test_wire.js'],
            completed: ['browser/unit/test_wire.js'],
            skipped: [],
            unfinished: [],
            attempts: 1,
          },
        ],
        controls: [
          {
            run: 1,
            diffDigest: createHash('sha256').update('a captured mutation').digest('hex'),
            mutationVerified: true,
            restored: true,
            compiled: false,
            targets: [
              {
                path: 'browser/source.js',
                originalSha256: 'a'.repeat(64),
                mutatedSha256: 'b'.repeat(64),
                mode: 0o644,
                restoredSha256: 'a'.repeat(64),
                restoredMode: 0o644,
              },
            ],
          },
        ],
      })
    );
    const caught = await testStepEvidence(step(['the stream settled']), path, f.snapshot);
    expect(caught.control).toBe('caught');
    expect(caught.controlProof).toMatchObject({
      expectedAssertions: ['the stream settled'],
      actualAssertions: ['test_wire_three_streams'],
      actualMessages: ['the stream settled - false == true'],
    });
    expect(
      (await testStepEvidence(step(['test_wire_three_streams']), path, f.snapshot)).control
    ).toBe('caught');
    await expect(testStepEvidence(step(['the stream closed']), path, f.snapshot)).rejects.toThrow(
      'Negative control failed at an unexpected assertion: expected "the stream closed"; the reds were labelled "test_wire_three_streams" (assertion "the stream settled - false == true")'
    );
  });

  it('rejects green exit evidence with a missing selected file or unrelated grouped red', async () => {
    const f = await fixture();
    const path = join(dirname(f.root), 'results.json');
    const step = {
      command: 'test' as const,
      args: ['--headless'],
      expected: {
        files: ['browser/a.js', 'browser/b.js'],
      },
    };
    const results = {
      schemaVersion: 1,
      unfinished: [],
      files: [{ test: 'browser/a.js', unexpected: false }],
      dispatches: [
        {
          run: 1,
          shard: 'a',
          requested: ['browser/a.js'],
          started: ['browser/a.js'],
          completed: ['browser/a.js'],
          skipped: [] as string[],
          unfinished: [],
          attempts: 1,
        },
      ],
    };
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/roster/);
    step.expected.files = ['browser/a.js'];
    expect((await testStepEvidence(step, path, f.snapshot)).selectedFiles).toEqual([
      'browser/a.js',
    ]);
    const collision = {
      ...step,
      expected: {
        ...step.expected,
        files: ['foo/a.js', 'bar/foo/a.js'],
      },
    };
    const collisionResults = {
      ...results,
      dispatches: results.dispatches.map((dispatch) => ({
        ...dispatch,
        requested: ['bar/foo/a.js', 'other/b.js'],
        started: ['bar/foo/a.js', 'other/b.js'],
        completed: ['bar/foo/a.js', 'other/b.js'],
      })),
    };
    await writeFile(path, JSON.stringify(collisionResults));
    await expect(testStepEvidence(collision, path)).rejects.toThrow(/roster/);
    await writeFile(path, JSON.stringify(results));
    const prefixed = {
      ...results,
      dispatches: results.dispatches.map((dispatch) => ({
        ...dispatch,
        started: ['prefix/browser/a.js'],
        completed: ['prefix/browser/a.js'],
      })),
    };
    await writeFile(path, JSON.stringify(prefixed));
    expect((await testStepEvidence(step, path)).selectedFiles).toEqual(['browser/a.js']);
    await writeFile(path, JSON.stringify(results));
    step.args.push('--repeat', '2');
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/repeat/);
    step.args.splice(-2);
    const dispatch = results.dispatches[0];
    if (!dispatch) throw new Error('Missing dispatch fixture');
    dispatch.skipped.push('browser/a.js');
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/roster/);
    dispatch.skipped.splice(0);
    const file = results.files[0];
    if (file) file.unexpected = true;
    await writeFile(path, JSON.stringify(results));
    await expect(testStepEvidence(step, path, f.snapshot)).rejects.toThrow(/red/);
  });
});

describe('bounded runtime lifecycle', () => {
  it('retires a diagnosed failed provision and permits clean recreation', async () => {
    const f = await fixture();
    const cache = join(dirname(f.root), 'bad-cache');
    await mkdir(cache);
    await writeFile(join(cache, 'cookies.sqlite'), 'private fixture');
    await expect(
      createSlot({
        namespace: f.namespace,
        id: 'a',
        snapshot: f.snapshot,
        pristineRepository: f.pristine,
        caches: [{ source: cache, target: 'node_modules' }],
      })
    ).rejects.toThrow(/Private/);
    await removeSlot(f.namespace, 'a');
    expect(await readdir(join(f.namespace, 'slots'))).toEqual([]);
    const slot = await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    expect(slot.sourceId).toBe(f.snapshot.id);
  });
  it('refuses running a source-B slot with the completed source-A package', async () => {
    const f = await fixture();
    await initializeCoordinator(f.namespace);
    const slot = await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    await writeDurable(join(slot.root, '.fireforge', 'last-build.json'), {
      engineHeadSha: f.commit,
      builtAt: new Date().toISOString(),
      binaryName: f.config.binaryName,
      buildKind: 'full',
    });
    await recordSuccessfulBuild(f.namespace, 'a', { command: 'build', args: [] });
    expect((await readSlot(f.namespace, 'a')).trustedBuild?.sourceId).toBe(f.snapshot.id);
    await writeFile(join(f.root, 'src/browser/new.js'), 'export const value = 2;\n');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    const next = await prepareSlot(f.namespace, await readSlot(f.namespace, 'a'), snapshot);
    expect(next.sourceId).not.toBe(f.snapshot.id);
    expect(next.requiresBuild).toBe(true);
    expect(next.trustedBuild).toBeUndefined();
    await initializeCoordinator(f.namespace);
    servers.push(await LocalSupervisor.start(f.namespace));
    const input = request();
    input.sourceId = snapshot.id;
    input.steps = [{ command: 'run', args: ['--headless'] }];
    // Without a toolchain contract it never gets as far as the slot.
    await expect(submitJob(f.namespace, input, snapshot)).rejects.toThrow(/fireforge host init/);
    expect((await readJournal(f.namespace)).size).toBe(0);
    const live = await readSlot(f.namespace, 'a');
    expect(live.requiresBuild).toBe(true);
    const running = record('a', 1, 'running');
    running.request.steps = input.steps;
    running.executionToken = 'token';
    running.process = { pid: process.pid, start: 'fixture' };
    if (running.phase) running.phase.nonce = 'phase';
    await expect(
      authorizeExecution(f.namespace, running, {
        operation: 'authorize',
        jobId: running.id,
        token: 'token',
        phase: 'phase',
        command: 'run',
      })
    ).rejects.toThrow(/fresh admitted build/);
  }, 25_000);
  it('retains a full compiled anchor through a UI change but refuses a faster build after C++ changes', async () => {
    const f = await fixture();
    const slot = await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    const baselinePath = join(slot.root, '.fireforge', 'last-build.json');
    const full = {
      engineHeadSha: f.commit,
      builtAt: new Date().toISOString(),
      binaryName: f.config.binaryName,
      buildKind: 'full',
    };
    await writeDurable(baselinePath, full);
    await recordSuccessfulBuild(f.namespace, 'a', { command: 'build', args: [] });
    const anchor = (await readSlot(f.namespace, 'a')).fullBuildAnchor;
    await writeFile(join(f.root, 'src/browser/new.js'), 'export const value = 2;\n');
    const ui = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    const uiSlot = await prepareSlot(f.namespace, await readSlot(f.namespace, 'a'), ui);
    expect(uiSlot.requiresFullBuild).toBe(false);
    await writeDurable(baselinePath, {
      ...full,
      builtAt: new Date().toISOString(),
      buildKind: 'faster',
    });
    await recordSuccessfulBuild(f.namespace, 'a', { command: 'build', args: ['--ui'] });
    expect((await readSlot(f.namespace, 'a')).fullBuildAnchor).toEqual(anchor);
    expect((await readSlot(f.namespace, 'a')).trustedBuild?.sourceId).toBe(ui.id);
    await writeFile(join(f.root, 'src/browser/new.cpp'), 'int value = 3;\n');
    const cpp = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    const cppSlot = await prepareSlot(f.namespace, await readSlot(f.namespace, 'a'), cpp);
    expect(cppSlot.requiresFullBuild).toBe(true);
    await writeDurable(baselinePath, {
      ...full,
      builtAt: new Date().toISOString(),
      buildKind: 'faster',
    });
    await expect(
      recordSuccessfulBuild(f.namespace, 'a', { command: 'build', args: ['--ui'] })
    ).rejects.toThrow(/full build/);
    expect((await readSlot(f.namespace, 'a')).successfulBuildGeneration).toBe(2);
    expect((await readSlot(f.namespace, 'a')).trustedBuild).toBeUndefined();
  });
  it('advances package generation for an observed completed compiled restore without a --build flag', async () => {
    const f = await fixture();
    const slot = await createSlot({
      namespace: f.namespace,
      id: 'a',
      snapshot: f.snapshot,
      pristineRepository: f.pristine,
    });
    await writeDurable(join(slot.root, '.fireforge', 'last-build.json'), {
      engineHeadSha: f.commit,
      builtAt: new Date().toISOString(),
      binaryName: f.config.binaryName,
      buildKind: 'full',
    });
    const job = record('a', 1, 'running');
    const step = { command: 'test' as const, args: ['--negative-control', 'control.diff'] };
    job.request.steps = [step];
    const reportPath = join(f.namespace, 'artifacts', job.id, 'step-0-execution.json');
    await writeDurable(reportPath, {
      steps: [{ controlProof: { mutations: [{ compiled: true, compiledRestoreBuild: 'done' }] } }],
    });
    await stampPhaseReport(f.namespace, job, step);
    expect((await readSlot(f.namespace, 'a')).successfulBuildGeneration).toBe(1);
    expect(
      (
        await readJson<{ steps: Array<{ runtimeAfter: { successfulBuildGeneration: number } }> }>(
          reportPath
        )
      ).steps[0]?.runtimeAfter.successfulBuildGeneration
    ).toBe(1);
  });
  it('guards run profiles, package resources and relative path escapes', () => {
    for (const args of [
      ['--allow-stale-build'],
      ['--mach-arg=--log-raw=.fireforge/old.json'],
      ['--unknown-input', 'mutable.txt'],
    ]) {
      const invalid = request();
      invalid.steps = [{ command: 'test', args }];
      expect(() => {
        validateRequest(invalid);
      }).toThrow(/Unsupported immutable-job option/);
    }
    const parallel = request();
    parallel.steps = [{ command: 'test', args: ['--headless', '--jobs=2'] }];
    expect(() => {
      authorizeRequest(parallel, config);
    }).toThrow(/single-harness/);
    const overloaded = request();
    overloaded.steps = [{ command: 'build', args: ['--jobs', '1', '-j64'] }];
    expect(() => {
      authorizeRequest(overloaded, config);
    }).toThrow(/concurrency/);
    const run = record('a', 1);
    run.request.steps = [{ command: 'run', args: ['--headless'] }];
    expect(currentResources(run).browser).toBe(1);
    expect(currentResources(run).display).toBe(0);
    run.request.steps[0] = { command: 'run', args: [] };
    expect(currentResources(run).display).toBe(1);
    run.request.steps[0] = { command: 'run', args: ['-Pdefault'] };
    expect(() => {
      validateRequest(run.request);
    }).toThrow(/profile/);
    run.request.steps[0] = { command: 'lint', args: ['--report=../../elsewhere'] };
    expect(() => {
      validateRequest(run.request);
    }).toThrow(/relative/);
    run.request.steps[0] = { command: 'package', args: [] };
    expect(currentResources(run).build).toBe(1);
  });
  it('executes actual check child CLI and retains removal artifacts', async () => {
    const f = await fixture();
    f.config.check = {
      skip: ['verify', 'lint', 'typecheck', 'furnace-validate', 'token-coverage'],
    };
    await writeFile(join(f.root, 'fireforge.json'), JSON.stringify(f.config));
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    await initializeCoordinator(f.namespace);
    await createSlot({ namespace: f.namespace, id: 'a', snapshot, pristineRepository: f.pristine });
    const server = await LocalSupervisor.start(f.namespace);
    servers.push(server);
    const input = request();
    input.sourceId = snapshot.id;
    input.steps = [{ command: 'check', args: [] }];
    const job = await submitJob(f.namespace, input, snapshot);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    if (outcome.state !== 'passed')
      throw new Error(
        `${outcome.reason}; ${JSON.stringify(await readJobLogs(f.namespace, job.id))}`
      );
    const observed = outcome.receipt?.steps[0]?.check;
    expect(observed?.steps.map((step) => step.name)).toEqual([
      'status',
      'verify',
      'lint',
      'typecheck',
      'furnace-validate',
      'token-coverage',
    ]);
    expect(
      observed?.steps.filter((step) => step.status === 'pass').map((step) => step.name)
    ).toEqual(['status']);
    const statusArtifact = observed?.steps[0]?.artifact;
    if (!statusArtifact) throw new Error('Missing actual check child output artifact');
    expect(
      await readFile(join(f.namespace, 'artifacts', job.id, statusArtifact), 'utf8')
    ).toContain('"event":"end"');
    await server.close();
    await expect(removeSlot(f.namespace, 'a')).resolves.toEqual({ removed: 'a' });
    expect((await readJournal(f.namespace)).get(job.id)?.receipt?.jobId).toBe(job.id);
  }, 60_000);
});
