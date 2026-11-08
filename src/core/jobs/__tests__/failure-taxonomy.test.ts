// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { jobVerdict } from '../../../commands/job-support.js';
import { writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { cancelJob, clearHost, readJob, readJobLogs, submitJob, waitForJob } from '../client.js';
import { quarantineHostUnknown } from '../host-quarantine.js';
import type { ExecutionReport } from '../schema.js';
import { removeSlot, restoreSlot } from '../slot-lifecycle.js';
import type { StorageReservation } from '../slot-types.js';
import { acquireSlot, auditSlot, readSlot, SlotBusyError } from '../slots.js';
import { readJournal, readJson, slotDirectory, writeDurable } from '../store.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

const fixtures: JobFixture[] = [];
// Every test has its own coordinator, so they run side by side.
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
}, 120_000);
async function open(slots?: readonly string[]): Promise<JobFixture> {
  const fixture = await jobFixture(slots);
  fixtures.push(fixture);
  return fixture;
}

/** An unknown flag to a real command: exit 8, clean process tree, exactly a red lint or test. */
const red = { command: 'status' as const, args: ['--raw', '--fail-on', 'x'] };
const green = { command: 'status' as const, args: [] };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Leaves a process running in a directory with init as its parent, as anything
 * that outlives its launcher ends up: an Apple binary, whose environment macOS
 * hides from any census.
 *
 * @returns Its pid
 */
async function orphanIn(directory: string, command = 'exec /bin/sleep 120'): Promise<number> {
  const launcher = spawn('/bin/sh', ['-c', `(${command}) >/dev/null 2>&1 </dev/null & echo $!`], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = once(launcher, 'exit');
  const [pid] = (await once(launcher.stdout, 'data')) as [Buffer];
  await exited;
  return Number(pid.toString().trim());
}

describe.concurrent('failure taxonomy', () => {
  it('a clean red leaves the slot usable: the next job on it passes', async () => {
    const f = await open();
    const failed = await submitJob(f.namespace, f.request([red]), f.snapshot);
    const outcome = await waitForJob(f.namespace, failed.id, 60_000);
    expect(outcome.state, JSON.stringify(outcome)).toBe('failed');
    expect(outcome.reason).toMatch(/Executor exited/);
    // The red step's load peak survives on its evidence and reaches the verdict line.
    const report = await readJson<ExecutionReport>(
      join(f.namespace, 'artifacts', failed.id, 'step-0-execution.json')
    );
    expect(report.steps[0]?.hostLoadPeak).toEqual({
      load: expect.any(Number) as number,
      atSeconds: expect.any(Number) as number,
    });
    expect(outcome.hostLoadPeak).toEqual(report.steps[0]?.hostLoadPeak);
    expect(jobVerdict(outcome)).toMatch(/ host-load-peak=\d+\.\d\d host-load-peak-at=\d+ reason=/);
    const slot = await readSlot(f.namespace, 'a');
    expect(slot.quarantined).toBeNull();
    expect(slot.requiresAudit).toBe(true);
    const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const passed = await waitForJob(f.namespace, next.id, 60_000);
    if (passed.state !== 'passed')
      throw new Error(`${passed.reason}; ${(await readJobLogs(f.namespace, next.id)).text}`);
    expect(passed.receipt).toBeDefined();
    expect((await readSlot(f.namespace, 'a')).requiresAudit).toBeUndefined();
  }, 150_000);

  it('a job that asks to go on past a red runs every step, and seals the ones that passed', async () => {
    const f = await open();
    const job = await submitJob(
      f.namespace,
      { ...f.request([green, red, green, red]), continueOnFailure: true },
      f.snapshot
    );
    const outcome = await waitForJob(f.namespace, job.id, 90_000);
    expect(outcome.state, JSON.stringify(outcome)).toBe('failed');
    expect(outcome.stepVerdicts?.map((verdict) => [verdict.step, verdict.state])).toEqual([
      [1, 'red'],
      [3, 'red'],
    ]);
    expect(outcome.reason).toMatch(/^2 of 4 steps red; step 1 \(status\): Executor exited/);
    // Both passing steps carry audited evidence, the one after the red too.
    expect(outcome.partialReceipt?.steps.map((step) => step.index)).toEqual([0, 2]);
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    // Without the request, the first red still ends the job.
    const stopped = await submitJob(f.namespace, f.request([red, green]), f.snapshot);
    const ended = await waitForJob(f.namespace, stopped.id, 60_000);
    expect(ended.state).toBe('failed');
    expect(ended.stepVerdicts).toBeUndefined();
    expect(ended.phase?.index).toBe(0);
  }, 180_000);

  it('a red that left undeclared drift quarantines at the next admission, and restore clears it', async () => {
    const f = await open();
    const failed = await submitJob(f.namespace, f.request([red]), f.snapshot);
    await waitForJob(f.namespace, failed.id, 60_000);
    const before = await readSlot(f.namespace, 'a');
    // What a red test leaves behind: a changed tracked file, a stray one and a stray root file.
    await writeAt(before.root, 'engine/browser/manifest.txt', 'undeclared change');
    await writeAt(before.root, 'engine/browser/stray.js', 'stray');
    await writeAt(before.root, 'stray-root.txt', 'stray');
    await mkdir(join(before.root, 'engine', 'obj-kept'), { recursive: true });
    await writeFile(join(before.root, 'engine', 'obj-kept', 'libxul'), 'objects');
    const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const blocked = await waitForJob(f.namespace, next.id, 8_000);
    expect(blocked.state).toBe('queued');
    expect(blocked.blockedBy).toMatch(/quarantined.*slot restore a/);
    const slot = await readSlot(f.namespace, 'a');
    expect(slot.quarantined).toMatch(/drift/);

    const restored = await restoreSlot(f.namespace, 'a');
    expect(restored.quarantined).toBeNull();
    expect(restored.requiresBuild).toBe(true);
    expect(restored.requiresFullBuild).toBe(true);
    expect(await readFile(join(before.root, 'engine', 'obj-kept', 'libxul'), 'utf8')).toBe(
      'objects'
    );
    await expect(readFile(join(before.root, 'stray-root.txt'))).rejects.toThrow();
    await auditSlot(f.namespace, restored);
    // The job that was waiting needed only the restore.
    const passed = await waitForJob(f.namespace, next.id, 60_000);
    expect(passed.state, `${passed.reason}`).toBe('passed');
  }, 150_000);

  it('keeps the first quarantine reason instead of nesting', async () => {
    const f = await open();
    const slot = await readSlot(f.namespace, 'a');
    await writeAt(slot.root, 'engine/browser/manifest.txt', 'undeclared change');
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), {
      ...slot,
      requiresAudit: true,
    });
    const first = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const second = await submitJob(f.namespace, f.request([green]), f.snapshot);
    await waitForJob(f.namespace, second.id, 5_000);
    const reason = (await readSlot(f.namespace, 'a')).quarantined;
    expect(reason).toMatch(/Undeclared engine drift/);
    expect(reason).not.toMatch(/quarantined/i);
    await cancelJob(f.namespace, first.id);
    await cancelJob(f.namespace, second.id);
    expect((await readSlot(f.namespace, 'a')).quarantined).toBe(reason);
  }, 60_000);

  it('a refusal before launch fails only the job', async () => {
    const f = await open();
    const job = await submitJob(
      f.namespace,
      { ...f.request([green]), build: { mode: 'dev', brand: 'not-the-captured-brand' } },
      f.snapshot
    );
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toMatch(/Build metadata/);
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
    expect((await waitForJob(f.namespace, next.id, 60_000)).state).toBe('passed');
  }, 120_000);

  it('host quarantine shows on a queued job, and an explicit clear resumes admission', async () => {
    const f = await open();
    await quarantineHostUnknown(f.namespace, 'an executor nobody can identify');
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const queued = await waitForJob(f.namespace, job.id, 2_500);
    expect(queued.state).toBe('queued');
    expect(queued.blockedBy).toMatch(/an executor nobody can identify.*host-clear/);
    expect(await clearHost(f.namespace)).toEqual({ cleared: ['an executor nobody can identify'] });
    expect((await waitForJob(f.namespace, job.id, 60_000)).state).toBe('passed');
  }, 90_000);

  it('a job waits below the disk floor, says so, and starts once there is room', async () => {
    const f = await open();
    const path = join(slotDirectory(f.namespace, 'a'), 'slot.json');
    const slot = await readSlot(f.namespace, 'a');
    const storage = slot.storage as StorageReservation;
    await writeDurable(path, {
      ...slot,
      storage: { ...storage, floorBytes: Number.MAX_SAFE_INTEGER },
    });
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const queued = await waitForJob(f.namespace, job.id, 2_500);
    expect(queued.state).toBe('queued');
    expect(queued.blockedBy).toMatch(/Waiting for disk/);
    await writeDurable(path, { ...slot, storage: { ...storage, floorBytes: 1 } });
    expect((await waitForJob(f.namespace, job.id, 60_000)).state).toBe('passed');
  }, 90_000);

  it('a cancel with a clean census leaves the slot usable', async () => {
    const f = await open();
    const job = await submitJob(f.namespace, f.request([green, green]), f.snapshot);
    await cancelJob(f.namespace, job.id);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('cancelled');
    expect(outcome.receipt).toBeUndefined();
    await expect(readFile(join(f.namespace, 'receipts', `${job.id}.json`))).rejects.toThrow();
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
    expect((await waitForJob(f.namespace, next.id, 60_000)).state).toBe('passed');
  }, 150_000);

  it('a cancel of a running executor leaves the slot usable too', async () => {
    const f = await open();
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    await vi.waitFor(
      async () => {
        expect((await readJournal(f.namespace)).get(job.id)?.process).toBeDefined();
      },
      { timeout: 60_000, interval: 20 }
    );
    await cancelJob(f.namespace, job.id);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('cancelled');
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    await expect(readFile(join(f.namespace, 'host-quarantine.json'))).rejects.toThrow(/ENOENT/);
    const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
    expect((await waitForJob(f.namespace, next.id, 60_000)).state).toBe('passed');
  }, 150_000);

  it('a real survivor quarantines its own slot and holds its resources, and nobody else waits', async () => {
    const f = await open(['a', 'b']);
    const job = await submitJob(f.namespace, f.request([green], 'a'), f.snapshot);
    const running = await vi.waitFor(
      async () => {
        const record = (await readJournal(f.namespace)).get(job.id);
        if (record?.process === undefined) throw new Error('not launched yet');
        return record;
      },
      { timeout: 60_000, interval: 20 }
    );
    // A helper in the phase's own environment that the ledger never saw: true uncertainty.
    const survivor = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FIREFORGE_JOB_PHASE: running.phase?.nonce ?? '' },
    });
    const gone = once(survivor, 'exit');
    try {
      const outcome = await waitForJob(f.namespace, job.id, 60_000);
      expect(outcome.state, JSON.stringify(outcome)).toBe('failed');
      expect(outcome.reason).toMatch(/cleanup uncertain/);
      expect(outcome.receipt).toBeUndefined();
      expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/cleanup uncertain/);
      // The rest of the host carries on.
      const peer = await submitJob(f.namespace, f.request([green], 'b'), f.snapshot);
      expect((await waitForJob(f.namespace, peer.id, 60_000)).state).toBe('passed');
      await expect(restoreSlot(f.namespace, 'a')).rejects.toThrow(/still runs/);
      await expect(clearHost(f.namespace)).rejects.toThrow(/still run/);
    } finally {
      process.kill(-(survivor.pid ?? 0), 'SIGKILL');
    }
    await gone;
    await vi.waitFor(
      async () => {
        await expect(restoreSlot(f.namespace, 'a')).resolves.toMatchObject({ quarantined: null });
      },
      { timeout: 15_000, interval: 300 }
    );
  }, 240_000);

  it('quarantines an interrupted negative control even when the job ended cleanly', async () => {
    const f = await open();
    const slot = await readSlot(f.namespace, 'a');
    await mkdir(join(slot.root, '.fireforge', 'negative-control'), { recursive: true });
    await writeFile(join(slot.root, '.fireforge', 'negative-control', 'stamp.json'), '{}');
    const job = await submitJob(f.namespace, f.request([red]), f.snapshot);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('failed');
    expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/Negative control/);
    await expect(restoreSlot(f.namespace, 'a')).resolves.toMatchObject({ quarantined: null });
    await expect(
      readFile(join(slot.root, '.fireforge', 'negative-control', 'stamp.json'))
    ).rejects.toThrow();
  }, 90_000);
});

describe.concurrent('slot restore after a crash in preparation', () => {
  it('takes the snapshot as the truth when a crash left the slot’s record behind it', async () => {
    const f = await open();
    await f.supervisor.close();
    await writeFile(join(f.root, 'src/browser/new.js'), 'export const value = 2;\n');
    const next = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    expect(next.id).not.toBe(f.snapshot.id);
    // The two adjacent writes of a preparation, with a crash between them, then what recovery marks.
    const directory = slotDirectory(f.namespace, 'a');
    await writeDurable(join(directory, 'snapshot.json'), next);
    const slot = await readSlot(f.namespace, 'a');
    await writeDurable(join(directory, 'slot.json'), {
      ...slot,
      quarantined: 'Supervisor interruption requires explicit restore and boundary audit',
    });

    const restored = await restoreSlot(f.namespace, 'a');
    expect(restored.quarantined).toBeNull();
    expect(restored.sourceId).toBe(next.id);
    expect(restored.generation).toBe(slot.generation + 1);
    expect(restored.requiresFullBuild).toBe(true);
    expect(await readFile(join(slot.root, 'engine/browser/new.js'), 'utf8')).toBe(
      'export const value = 2;\n'
    );
    await auditSlot(f.namespace, restored);
  }, 90_000);

  it('recovers a materialization a crash left half done, journal and all', async () => {
    const f = await open();
    await f.supervisor.close();
    const directory = slotDirectory(f.namespace, 'a');
    const slot = await readSlot(f.namespace, 'a');
    const owned = join(slot.root, 'engine/browser/new.js');
    const bytes = await readFile(owned, 'utf8');
    // A torn write and the rollback journal that names bytes neither side of it holds.
    await writeFile(owned, 'half a write');
    await writeFile(
      join(directory, 'materialization.json.journal'),
      JSON.stringify({ schemaVersion: 1, previousLedger: null, changes: [], ledger: {} })
    );
    await writeDurable(join(directory, 'slot.json'), { ...slot, quarantined: 'interrupted' });
    const restored = await restoreSlot(f.namespace, 'a');
    expect(restored.quarantined).toBeNull();
    expect(await readFile(owned, 'utf8')).toBe(bytes);
  }, 90_000);
});

describe.concurrent('why a job ended', () => {
  it('a red names the step’s own last complaint, not only the executor’s exit', async () => {
    const f = await open();
    const job = await submitJob(f.namespace, f.request([red]), f.snapshot);
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toMatch(/^Executor exited \d+: .*(option|unknown|error)/i);
  }, 90_000);

  it('an executor killed from outside is interrupted, with no verdict on the step', async () => {
    const f = await open();
    const job = await submitJob(f.namespace, f.request([green, green]), f.snapshot);
    const running = await vi.waitFor(
      async () => {
        const record = (await readJournal(f.namespace)).get(job.id);
        if (record?.process === undefined) throw new Error('not launched yet');
        return record;
      },
      { timeout: 60_000, interval: 20 }
    );
    process.kill(-(running.process?.pid ?? 0), 'SIGKILL');
    const outcome = await waitForJob(f.namespace, job.id, 60_000);
    expect(outcome.state).toBe('interrupted');
    expect(outcome.reason).toMatch(/stopped from outside/);
    expect(outcome.partialReceipt).toBeUndefined();
    expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
    const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
    expect((await waitForJob(f.namespace, next.id, 60_000)).state).toBe('passed');
  }, 180_000);

  it('a process left with a working directory in the slot is found at seal, even with no marker', async () => {
    const f = await open();
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    await vi.waitFor(
      async () => {
        expect((await readJournal(f.namespace)).get(job.id)?.process).toBeDefined();
      },
      { timeout: 60_000, interval: 20 }
    );
    const { root } = await readSlot(f.namespace, 'a');
    // An Apple binary, whose environment macOS hides from any census, orphaned and sitting in the engine.
    const daemon = await orphanIn(join(root, 'engine'));
    try {
      const outcome = await waitForJob(f.namespace, job.id, 60_000);
      expect(outcome.state, JSON.stringify(outcome)).toBe('failed');
      expect(outcome.reason).toMatch(/still in use by process/);
      expect(outcome.receipt).toBeUndefined();
      expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/still in use/);
    } finally {
      process.kill(daemon, 'SIGKILL');
    }
  }, 120_000);

  describe('a bystander in the slot', () => {
    it('one older than the job costs neither the job nor the slot', async () => {
      const f = await open();
      const { root } = await readSlot(f.namespace, 'a');
      const bystander = await orphanIn(join(root, 'engine'));
      try {
        // Process births are whole seconds, so this one is older than the job on any clock.
        await delay(1_100);
        const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
        const outcome = await waitForJob(f.namespace, job.id, 60_000);
        expect(outcome.state, JSON.stringify(outcome)).toBe('passed');
        expect((await readSlot(f.namespace, 'a')).quarantined).toBeNull();
      } finally {
        process.kill(bystander, 'SIGKILL');
      }
    }, 120_000);

    it('one older than the last job does not stop the audit after a red', async () => {
      const f = await open();
      const { root } = await readSlot(f.namespace, 'a');
      const bystander = await orphanIn(join(root, 'engine'));
      try {
        await delay(1_100);
        const failed = await submitJob(f.namespace, f.request([red]), f.snapshot);
        expect((await waitForJob(f.namespace, failed.id, 60_000)).state).toBe('failed');
        expect((await readSlot(f.namespace, 'a')).requiresAudit).toBe(true);
        const next = await submitJob(f.namespace, f.request([green]), f.snapshot);
        const outcome = await waitForJob(f.namespace, next.id, 60_000);
        expect(outcome.state, JSON.stringify(outcome)).toBe('passed');
      } finally {
        process.kill(bystander, 'SIGKILL');
      }
    }, 120_000);

    it('one holding a slot file open for writing counts however old it is', async () => {
      const f = await open();
      const { root } = await readSlot(f.namespace, 'a');
      const writer = await orphanIn(
        root,
        'exec 3<>engine/browser/manifest.txt; exec /bin/sleep 120'
      );
      try {
        await delay(1_100);
        const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
        const outcome = await waitForJob(f.namespace, job.id, 60_000);
        expect(outcome.state, JSON.stringify(outcome)).toBe('failed');
        expect(outcome.reason).toMatch(/still in use by process/);
        expect((await readSlot(f.namespace, 'a')).quarantined).toMatch(/still in use/);
      } finally {
        process.kill(writer, 'SIGKILL');
      }
    }, 120_000);

    it('destroying a slot still refuses with any holder in it', async () => {
      const f = await open();
      const { root } = await readSlot(f.namespace, 'a');
      const bystander = await orphanIn(join(root, 'engine'));
      try {
        await expect(removeSlot(f.namespace, 'a')).rejects.toThrow(/still in use by process/);
      } finally {
        process.kill(bystander, 'SIGKILL');
      }
    }, 60_000);
  });
});

describe.concurrent('the slot lock', () => {
  it('reclaims a claim whose holder exited, whoever held it', async () => {
    const f = await open();
    const directory = slotDirectory(f.namespace, 'a');
    const dead = (await readdir(directory))
      .filter((name) => /^exclusive\.\d+$/.test(name))
      .map((name) => Number(name.slice('exclusive.'.length)));
    const generation = Math.max(0, ...dead) + 1;
    await writeDurable(join(directory, `exclusive.${String(generation)}`), {
      owner: { pid: 2 ** 22 + 7, start: 'gone' },
      nonce: 'dead-cli',
    });
    const release = await acquireSlot(f.namespace, 'a');
    const next = join(directory, `exclusive.${String(generation + 1)}`);
    expect((await readJson<{ nonce: string }>(next)).nonce).not.toBe('dead-cli');
    await release();
  }, 30_000);

  it('tells a live holder apart, and a waiting job starts once it lets go', async () => {
    const f = await open();
    const release = await acquireSlot(f.namespace, 'a');
    await expect(acquireSlot(f.namespace, 'a')).rejects.toBeInstanceOf(SlotBusyError);
    const job = await submitJob(f.namespace, f.request([green]), f.snapshot);
    const waiting = await vi.waitFor(
      async () => {
        const view = await readJob(f.namespace, job.id);
        expect(view.blockedBy).toMatch(/in use by process/);
        return view;
      },
      { timeout: 60_000, interval: 100 }
    );
    expect(waiting.state).toBe('queued');
    await release();
    expect((await waitForJob(f.namespace, job.id, 60_000)).state).toBe('passed');
  }, 150_000);

  it('does not create a directory for a mistyped slot, and remove says it does not exist', async () => {
    const f = await open();
    await expect(acquireSlot(f.namespace, 'typo')).rejects.toThrow(/does not exist/);
    await expect(readFile(join(f.namespace, 'slots', 'typo', 'slot.json'))).rejects.toThrow(
      /ENOENT/
    );
    await f.supervisor.close();
    await expect(removeSlot(f.namespace, 'typo')).rejects.toThrow(/does not exist/);
  }, 30_000);

  it('retires an interrupted provision whose owner has exited', async () => {
    const f = await open();
    await f.supervisor.close();
    const directory = slotDirectory(f.namespace, 'partial');
    await mkdir(directory, { recursive: true });
    await writeDurable(join(directory, 'provisioning.json'), {
      owner: { pid: 2 ** 22 + 9, start: 'gone' },
    });
    await removeSlot(f.namespace, 'partial');
    await expect(readFile(join(directory, 'provisioning.json'))).rejects.toThrow(/ENOENT/);
  }, 30_000);
});
