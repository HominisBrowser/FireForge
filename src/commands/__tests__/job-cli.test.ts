// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelJob,
  readJob,
  readJobLogs,
  resolveJobId,
  submitJob,
  waitForJob,
} from '../../core/jobs/client.js';
import { readJson } from '../../core/jobs/store.js';
import { CommandError, InvalidArgumentError } from '../../errors/base.js';
import { ExitCode } from '../../errors/codes.js';
import { InvalidLogRangeError } from '../../errors/job.js';
import { registerJob } from '../job.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('../../core/jobs/guard.js', () => ({ coordinatorNamespace: () => '/private/default' }));
vi.mock('../../core/jobs/client.js', () => ({
  cancelJob: vi.fn(),
  clearHost: vi.fn(),
  listJobs: vi.fn(),
  readJob: vi.fn(),
  readJobLogs: vi.fn(),
  resolveJobId: vi.fn(),
  submitJob: vi.fn(),
  waitForJob: vi.fn(),
}));
vi.mock('../../core/jobs/store.js', () => ({ readJson: vi.fn() }));

const snapshot = { id: 'a'.repeat(64) };
const view = (state: string): never =>
  ({
    id: 'job-1',
    state,
    owner: 'me',
    request: { steps: [{ command: 'status', args: [] }] },
  }) as never;
let writes: string[];

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerJob(program, {
    getProjectRoot: () => '/editor',
    withErrorHandling: (handler) => handler,
  });
  await program.parseAsync(['node', 'fireforge', 'job', ...args]);
}

beforeEach(() => {
  vi.resetAllMocks();
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.mocked(readJson).mockResolvedValue(snapshot);
  vi.mocked(resolveJobId).mockImplementation((_namespace, id) => Promise.resolve(id));
});
afterEach(() => vi.restoreAllMocks());

describe('job CLI', () => {
  it('fills what a short request leaves out, deriving the source from the snapshot', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ steps: [{ command: 'status', args: [] }] })
    );
    vi.mocked(submitJob).mockResolvedValue(view('queued'));
    await run('submit', 'request.json', '--snapshot', 'snapshot.json', '--owner', 'agent-a');
    expect(readFile).toHaveBeenCalledWith(resolve('request.json'), 'utf8');
    expect(submitJob).toHaveBeenCalledWith(
      '/private/default',
      expect.objectContaining({
        schemaVersion: 1,
        sourceId: snapshot.id,
        quiet: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
        key: expect.stringMatching(/^auto-[a-f0-9]{40}$/),
      }),
      snapshot,
      'agent-a'
    );
    expect(writes.join('')).toMatch(/^job-1 queued /);
  });

  it('does not submit malformed request JSON, or one naming a different source', async () => {
    vi.mocked(readFile).mockResolvedValue('{');
    await expect(run('submit', 'request.json', '--snapshot', 'snapshot.json')).rejects.toThrow();
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ sourceId: 'b'.repeat(64), steps: [] }));
    await expect(run('submit', 'request.json', '--snapshot', 'snapshot.json')).rejects.toThrow(
      /names source/
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it.each([
    ['passed', ExitCode.SUCCESS],
    ['failed', ExitCode.JOB_FAILED],
    ['cancelled', ExitCode.JOB_STOPPED],
    ['interrupted', ExitCode.JOB_STOPPED],
  ])('job wait and job status report %s as exit %i', async (state, code) => {
    for (const operation of ['wait', 'status']) {
      vi.mocked(waitForJob).mockResolvedValue(view(state));
      vi.mocked(readJob).mockResolvedValue(view(state));
      const outcome = await run(operation, 'job-1').then(
        () => ExitCode.SUCCESS,
        (error: unknown) => (error as CommandError).exitCode
      );
      expect(outcome).toBe(code);
    }
    expect(writes.join('')).toContain(`job-1 ${state}`);
  });

  it('names what changed on the host under a red or interrupted step, earliest first', async () => {
    const withState = (state: string): never =>
      ({
        ...(view(state) as object),
        hostLoadPeak: { load: 3.5, atSeconds: 20 },
        hostState: { networkLost: 40, input: 12 },
        reason: 'Executor exited 1',
      }) as never;
    vi.mocked(readJob).mockResolvedValue(withState('failed'));
    await run('status', 'job-1').catch(() => undefined);
    expect(writes.join('')).toContain(
      'host-load-peak=3.50 host-load-peak-at=20 host-state=input@12,networkLost@40 reason=Executor exited 1'
    );
    writes = [];
    vi.mocked(readJob).mockResolvedValue(withState('interrupted'));
    await run('status', 'job-1').catch(() => undefined);
    expect(writes.join('')).toContain(' host-state=input@12,networkLost@40 ');
    writes = [];
    vi.mocked(readJob).mockResolvedValue(withState('passed'));
    await run('status', 'job-1');
    expect(writes.join('')).not.toContain('host-state=');
  });

  it('names a lost foreground and low disk on the verdict line', async () => {
    vi.mocked(readJob).mockResolvedValue({
      ...(view('failed') as object),
      hostState: { foregroundLost: 6, input: 2 },
      hostDisk: { freeBytes: 5.5 * 1024 ** 3, atSeconds: 31, volume: 'namespace' },
      reason: 'Executor exited 1',
    } as never);
    await run('status', 'job-1').catch(() => undefined);
    expect(writes.join('')).toContain(
      ' host-state=input@2,foreground-lost@6 host-disk-low=5.5@31 reason=Executor exited 1'
    );
    writes = [];
    vi.mocked(readJob).mockResolvedValue({
      ...(view('passed') as object),
      hostDisk: { freeBytes: 1, atSeconds: 1, volume: 'namespace' },
    } as never);
    await run('status', 'job-1');
    expect(writes.join('')).not.toContain('host-disk-low');
  });

  it('gives a wait timeout its own exit, and a running job status exit 0', async () => {
    vi.mocked(waitForJob).mockResolvedValue(view('running'));
    const timedOut = await run('wait', 'job-1', '--timeout', '2').catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(CommandError);
    expect((timedOut as CommandError).exitCode).toBe(ExitCode.JOB_WAIT_TIMEOUT);
    expect(waitForJob).toHaveBeenCalledWith(
      '/private/default',
      'job-1',
      2000,
      undefined,
      expect.any(Function)
    );
    vi.mocked(readJob).mockResolvedValue(view('running'));
    await expect(run('status', 'job-1')).resolves.toBeUndefined();
  });

  it('reports no wait progress under --json', async () => {
    const saved = process.argv;
    process.argv = ['node', 'fireforge', 'job', 'wait', 'job-1', '--json'];
    vi.mocked(waitForJob).mockResolvedValue(view('passed'));
    try {
      await run('wait', 'job-1', '--json');
    } finally {
      process.argv = saved;
    }
    expect(vi.mocked(waitForJob).mock.calls.at(-1)?.[4]).toBeUndefined();
  });

  it('routes cancel by ID alone', async () => {
    vi.mocked(cancelJob).mockResolvedValue(view('cancelled'));
    await run('cancel', 'job-1', '--namespace', '/private/explicit');
    expect(cancelJob).toHaveBeenCalledWith('/private/explicit', 'job-1', { force: false });
  });

  it('cancels another owner’s job only with --force', async () => {
    vi.mocked(cancelJob).mockResolvedValue(view('cancelled'));
    await run('cancel', 'job-1', '--force');
    expect(cancelJob).toHaveBeenCalledWith('/private/default', 'job-1', { force: true });
  });

  it('prints log text by default', async () => {
    vi.mocked(readJob).mockResolvedValue(view('running'));
    vi.mocked(readJobLogs).mockResolvedValue({ text: 'chunk', nextOffset: 17, totalBytes: 100 });
    await run('logs', 'job-1', '--offset', '12', '--limit', '24');
    expect(readJobLogs).toHaveBeenCalledWith('/private/default', 'job-1', 12, 24);
    expect(writes).toEqual(['chunk']);
  });

  it.each([
    ['wait', 'job-1', '--timeout', 'x'],
    ['wait', 'job-1', '--timeout', '-1'],
    ['wait', 'job-1', '--timeout', '1.5'],
    ['host-clear', '--forget-group', 'x'],
  ])('reads a bad number in %j as a usage error', async (...args) => {
    const outcome = await run(...args).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(InvalidArgumentError);
    expect((outcome as InvalidArgumentError).code).toBe(ExitCode.INVALID_ARGUMENT);
    expect(waitForJob).not.toHaveBeenCalled();
  });

  it('names a job by a prefix of its ID in status, wait, cancel and logs', async () => {
    const whole = '7d41b2c0-3333-4aaa-8bbb-000000000003';
    vi.mocked(resolveJobId).mockResolvedValue(whole);
    vi.mocked(readJob).mockResolvedValue(view('passed'));
    vi.mocked(waitForJob).mockResolvedValue(view('passed'));
    vi.mocked(cancelJob).mockResolvedValue(view('cancelled'));
    vi.mocked(readJobLogs).mockResolvedValue({ text: '', nextOffset: 0, totalBytes: 0 });
    for (const operation of ['status', 'wait', 'cancel', 'logs']) await run(operation, '7d41b2c0');
    expect(resolveJobId).toHaveBeenCalledTimes(4);
    expect(resolveJobId).toHaveBeenCalledWith('/private/default', '7d41b2c0');
    expect(readJob).toHaveBeenCalledWith('/private/default', whole);
    expect(waitForJob).toHaveBeenCalledWith(
      '/private/default',
      whole,
      60_000,
      undefined,
      expect.any(Function)
    );
    expect(cancelJob).toHaveBeenCalledWith('/private/default', whole, { force: false });
    expect(readJobLogs).toHaveBeenCalledWith('/private/default', whole, 0, 262_144);
  });

  const steps = [
    { command: 'check', args: [] },
    { command: 'build', args: ['--ui'] },
    { command: 'test', args: ['a.js'] },
  ];
  const failed = (extra: Record<string, unknown> = {}): never =>
    ({
      id: 'job-1',
      state: 'failed',
      owner: 'me',
      phase: { index: 2, active: false, ticket: 1 },
      request: { steps },
      ...extra,
    }) as never;
  let errors: string[];
  const watchStderr = (): void => {
    errors = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
  };

  it('shows a failed job’s red step, its tail, and says how to see the others', async () => {
    watchStderr();
    vi.mocked(readJob).mockResolvedValue(failed());
    vi.mocked(readJobLogs).mockResolvedValue({
      text: 'TEST-UNEXPECTED-FAIL a.js\n',
      offset: 4_000,
      nextOffset: 4_026,
      totalBytes: 4_026,
      step: 2,
      steps: [0, 1, 2],
    });
    await run('logs', 'job-1');
    expect(readJobLogs).toHaveBeenCalledExactlyOnceWith('/private/default', 'job-1', 0, 262_144, {
      step: 2,
      tail: true,
      steps,
    });
    expect(writes).toEqual(['TEST-UNEXPECTED-FAIL a.js\n']);
    expect(errors.join('')).toBe(
      'job logs: step 2 (test), the red step: its last 26 of 4026 bytes. Another step: fireforge job logs job-1 --step <n> (steps with output: 0, 1, 2); the whole log: --offset 0\n'
    );
  });

  it('picks the last red step of a job that went on past reds, and carries the note under --json', async () => {
    vi.mocked(readJob).mockResolvedValue(
      failed({
        phase: { index: 2, active: false, ticket: 1 },
        stepVerdicts: [
          { step: 0, state: 'red', reason: 'lint' },
          { step: 1, state: 'red', reason: 'build' },
          { step: 2, state: 'blocked', reason: 'no package' },
        ],
      })
    );
    vi.mocked(readJobLogs).mockResolvedValue({
      text: 'build failed\n',
      offset: 0,
      nextOffset: 13,
      totalBytes: 13,
      step: 1,
      steps: [0, 1],
    });
    const argv = process.argv;
    process.argv = ['node', 'fireforge', 'job', '--json', 'logs', 'job-1'];
    try {
      await run('--json', 'logs', 'job-1');
    } finally {
      process.argv = argv;
    }
    expect(readJobLogs).toHaveBeenCalledWith('/private/default', 'job-1', 0, 262_144, {
      step: 1,
      tail: true,
      steps,
    });
    const document = JSON.parse(writes.join('')) as Record<string, unknown>;
    expect(document).toMatchObject({ step: 1, nextOffset: 13, steps: [0, 1] });
    expect(document['note']).toContain(
      'step 1 (build), the red step (also red: step 0): all 13 bytes'
    );
  });

  it('reads one step by --step, and the old range when one is named', async () => {
    vi.mocked(readJob).mockResolvedValue(failed());
    vi.mocked(readJobLogs).mockResolvedValue({ text: 'x', nextOffset: 1, totalBytes: 1 });
    await run('logs', 'job-1', '--step', '0', '--offset', '5');
    expect(readJobLogs).toHaveBeenLastCalledWith('/private/default', 'job-1', 5, 262_144, {
      step: 0,
      steps,
    });
    await run('logs', 'job-1', '--limit', '10');
    expect(readJobLogs).toHaveBeenLastCalledWith('/private/default', 'job-1', 0, 10);
    const bad = await run('logs', 'job-1', '--step', 'x').catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(InvalidArgumentError);
  });

  it('falls back to the whole log when the red step wrote nothing, and leaves a passed job’s log whole', async () => {
    watchStderr();
    vi.mocked(readJob).mockResolvedValue(failed({ refused: true }));
    vi.mocked(readJobLogs)
      .mockRejectedValueOnce(new InvalidLogRangeError('Step 2 has no output'))
      .mockResolvedValue({ text: 'whole', nextOffset: 5, totalBytes: 5 });
    await run('logs', 'job-1');
    expect(readJobLogs).toHaveBeenLastCalledWith('/private/default', 'job-1', 0, 262_144);
    expect(writes).toEqual(['whole']);
    expect(errors.join('')).toContain('step 2 (test), the red step, wrote nothing to the log');
    vi.mocked(readJob).mockResolvedValue(view('passed'));
    await run('logs', 'job-1');
    expect(readJobLogs).toHaveBeenLastCalledWith('/private/default', 'job-1', 0, 262_144);
  });
});
