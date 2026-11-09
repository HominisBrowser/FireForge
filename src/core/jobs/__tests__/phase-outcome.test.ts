// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nextRunnableStep } from '../phase-continue.js';
import {
  defaultStepDeadline,
  judgeHostConditionRed,
  judgeLoadedQuietRed,
  judgePhaseEnd,
  stepCause,
} from '../phase-outcome.js';
import type { JobRecord, JobStep, StepVerdict } from '../schema.js';

const job = (cancellationRequested = false): JobRecord =>
  ({ cancellationRequested, state: 'running' }) as JobRecord;

describe('the verdict on a finished phase', () => {
  it('advances only on exit 0 with nothing uncertain and no cancel', () => {
    expect(judgePhaseEnd(job(), { code: 0 })).toEqual({ advance: true, state: 'running' });
  });

  it('a red is an outcome: the slot stays usable', () => {
    expect(judgePhaseEnd(job(), { code: 8 })).toEqual({
      advance: false,
      state: 'failed',
      reason: 'Executor exited 8',
    });
    expect(judgePhaseEnd(job(), { code: null, detail: 'Executor signal SIGKILL' })).toEqual({
      advance: false,
      state: 'failed',
      reason: 'Executor signal SIGKILL',
    });
  });

  it('a cancel is an outcome, whatever the exit code says', () => {
    for (const code of [0, 143, null])
      expect(judgePhaseEnd(job(true), { code })).toEqual({
        advance: false,
        state: 'cancelled',
        reason: 'Cancelled while running',
      });
  });

  it('only uncertainty about what still runs condemns the slot, even on exit 0', () => {
    for (const [cancelled, state] of [
      [false, 'failed'],
      [true, 'cancelled'],
    ] as const) {
      const verdict = judgePhaseEnd(job(cancelled), { code: 0, uncertain: 'a group lives' });
      expect(verdict.advance).toBe(false);
      expect(verdict.state).toBe(state);
      expect(verdict.quarantine).toContain('a group lives');
      expect(verdict.reason).toBe(verdict.quarantine);
    }
  });
});

describe('a step’s default deadline', () => {
  it.each([
    [{ command: 'build', args: [] }, 6 * 3600],
    [{ command: 'build', args: ['--ui'] }, 2 * 3600],
    [{ command: 'test', args: ['a.js'] }, 2 * 3600],
    [{ command: 'test', args: ['--build', 'a.js'] }, 2 * 3600],
    [{ command: 'lint', args: [] }, 3600],
    [{ command: 'check', args: [] }, 3600],
  ] as const)('%j gets %d seconds', (step, seconds) => {
    expect(defaultStepDeadline({ ...step, args: [...step.args] })).toBe(seconds);
  });
});

describe('an executor stopped from outside', () => {
  const running = { cancellationRequested: false, state: 'running' } as JobRecord;

  it('is interrupted, whether it died on the signal or relayed it as an exit code', () => {
    expect(judgePhaseEnd(running, { code: null, signal: 'SIGKILL' })).toMatchObject({
      advance: false,
      state: 'interrupted',
      reason: expect.stringContaining('SIGKILL') as string,
    });
    for (const code of [130, 137, 143])
      expect(judgePhaseEnd(running, { code }).state).toBe('interrupted');
    expect(judgePhaseEnd(running, { code: 1 }).state).toBe('failed');
  });

  it('still condemns the slot when what it left cannot be established', () => {
    const verdict = judgePhaseEnd(running, { code: null, signal: 'SIGKILL', uncertain: 'a group' });
    expect(verdict.state).toBe('interrupted');
    expect(verdict.quarantine).toMatch(/a group/);
  });

  it('a cancel is a cancel, however the executor ended', () => {
    const cancelled = { ...running, cancellationRequested: true };
    expect(judgePhaseEnd(cancelled, { code: 143 }).state).toBe('cancelled');
  });
});

describe('the cause a red gives', () => {
  it('is the last complaint in the step’s log, not the executor’s number', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fireforge-phase-outcome-'));
    const log = join(directory, 'job.log');
    await writeFile(
      log,
      [
        'FIREFORGE-JOB-STEP: {"command":"build","args":["--error"]}',
        '\u001b[31m■\u001b[39m  no moz.build exists under engine/browser/branding/fixture/',
        'Build log: /tmp/somewhere',
        '',
      ].join('\n')
    );
    await expect(stepCause(log)).resolves.toBe(
      'no moz.build exists under engine/browser/branding/fixture/'
    );
    expect(
      judgePhaseEnd({ cancellationRequested: false } as JobRecord, { code: 6, cause: 'boom' })
    ).toMatchObject({
      state: 'failed',
      reason: 'Executor exited 6: boom',
    });
    // A test step's verdict says where the run stopped; the error rendered after it does not.
    await writeFile(
      log,
      [
        'FIREFORGE-VERDICT: FAIL reason=test-failures unexpected=1 started=210/485 first-unstarted=browser/a/browser_x.js started-source=raw host-load=38.20 log=/tmp/run.log',
        '\u001b[31m■\u001b[39m  Test Failure: FireForge did NOT treat this incomplete harness run as passed:',
        '  1. Find the TEST-UNEXPECTED-FAIL lines in the output above',
        '',
      ].join('\n')
    );
    await expect(stepCause(log)).resolves.toBe(
      '1. Find the TEST-UNEXPECTED-FAIL lines in the output above (started=210/485 first-unstarted=browser/a/browser_x.js)'
    );
    await writeFile(log, 'nothing of note\nthe last line\n');
    await expect(stepCause(log)).resolves.toBe('the last line');
    await rm(directory, { recursive: true, force: true });
    await expect(stepCause(log)).resolves.toBeUndefined();
  });
});

describe('a quiet red read against the load it ran under', () => {
  const red = { advance: false, state: 'failed' as const, reason: 'Executor exited 8: timeout' };
  const peak = (load: number): { load: number; atSeconds: number } => ({ load, atSeconds: 42 });

  it('a red whose load less the step’s own CPU reached the limit ends interrupted, saying so', () => {
    expect(judgeLoadedQuietRed(red, { peak: peak(37.5), limit: 14, cpu: 2 })).toEqual({
      advance: false,
      state: 'interrupted',
      reason:
        "Host load peaked at 37.50 42s in, at or above the quiet limit 14 plus the step's own 2 CPU, so this red says nothing about the step: Executor exited 8: timeout",
    });
  });

  it('a red the step’s own CPU explains stands, and so does one with no load reading', () => {
    expect(judgeLoadedQuietRed(red, { peak: peak(15.5), limit: 14, cpu: 2 })).toBe(red);
    expect(judgeLoadedQuietRed(red, { peak: undefined, limit: 14, cpu: 2 })).toBe(red);
  });

  it('a pass under load stays a pass, and uncertainty keeps its quarantine', () => {
    const pass = { advance: true, state: 'running' as const };
    expect(judgeLoadedQuietRed(pass, { peak: peak(80), limit: 14, cpu: 2 })).toBe(pass);
    const uncertain = { ...red, quarantine: 'Executor group cleanup uncertain: x' };
    expect(judgeLoadedQuietRed(uncertain, { peak: peak(80), limit: 14, cpu: 2 })).toBe(uncertain);
  });
});

describe('a red read against what changed on the host', () => {
  const red = { advance: false, state: 'failed' as const, reason: 'Executor exited 8: timeout' };
  const plain = { quiet: false, headed: false };

  it('a red after the network went away ends interrupted, quiet or not', () => {
    expect(judgeHostConditionRed(red, { state: { networkLost: 300 }, ...plain })).toEqual({
      advance: false,
      state: 'interrupted',
      reason:
        'The network went away 300s in, so this red says nothing about the step: Executor exited 8: timeout',
    });
  });

  it('a quiet red after the lid closed or the display slept ends interrupted; a busy one stands', () => {
    const lid = { lidClosed: 40, displaySlept: 41 };
    const closed = judgeHostConditionRed(red, { state: lid, quiet: true, headed: false });
    expect(closed.state).toBe('interrupted');
    expect(closed.reason).toMatch(/^The lid closed 40s in and the display slept 41s in, so/);
    expect(judgeHostConditionRed(red, { state: lid, ...plain })).toBe(red);
  });

  it('a red after input reached a step with a window ends interrupted; a headless one stands', () => {
    const touched = judgeHostConditionRed(red, {
      state: { input: 12 },
      quiet: false,
      headed: true,
    });
    expect(touched.state).toBe('interrupted');
    expect(touched.reason).toMatch(/^Keyboard or pointer input reached the host 12s in, so/);
    expect(judgeHostConditionRed(red, { state: { input: 12 }, quiet: true, headed: false })).toBe(
      red
    );
  });

  it('a pass stays a pass, uncertainty keeps its quarantine, and nothing changed keeps the red', () => {
    const state = { networkLost: 1, lidClosed: 1, input: 1 };
    const pass = { advance: true, state: 'running' as const };
    expect(judgeHostConditionRed(pass, { state, quiet: true, headed: true })).toBe(pass);
    const uncertain = { ...red, quarantine: 'Executor group cleanup uncertain: x' };
    expect(judgeHostConditionRed(uncertain, { state, quiet: true, headed: true })).toBe(uncertain);
    expect(judgeHostConditionRed(red, { state: undefined, quiet: true, headed: true })).toBe(red);
    const bare = { advance: false, state: 'failed' as const };
    expect(judgeHostConditionRed(bare, { state, ...plain }).reason).toMatch(/: red$/);
  });
});

describe('a job that goes on past a red step', () => {
  const check: JobStep = { command: 'check', args: [] };
  const build: JobStep = { command: 'build', args: [] };
  const lane = (file: string): JobStep => ({ command: 'test', args: ['--headless', file] });
  const red = (step: number): StepVerdict => ({ step, state: 'red', reason: 'red' });
  const steps = [check, build, lane('a.js'), lane('b.js'), { command: 'run', args: [] } as JobStep];

  it('goes on to the next step after a red check or a red lane', () => {
    expect(nextRunnableStep(steps, [red(0)], 1)).toEqual({ index: 1, blocked: [] });
    expect(nextRunnableStep(steps, [red(2)], 3)).toEqual({ index: 3, blocked: [] });
  });

  it('blocks everything that reads the package after a red build, and runs a static step', () => {
    const after = nextRunnableStep(steps, [red(1)], 2);
    expect(after.index).toBe(steps.length);
    expect(after.blocked.map((verdict) => [verdict.step, verdict.state])).toEqual([
      [2, 'blocked'],
      [3, 'blocked'],
      [4, 'blocked'],
    ]);
    expect(after.blocked[0]?.reason).toBe('Blocked by step 1 (build), which went red');
    const withStatic = [build, lane('a.js'), check, lane('b.js')];
    const first = nextRunnableStep(withStatic, [red(0)], 1);
    expect(first).toMatchObject({ index: 2, blocked: [{ step: 1 }] });
    expect(nextRunnableStep(withStatic, [red(0), ...first.blocked], 3)).toMatchObject({
      index: 4,
      blocked: [{ step: 3 }],
    });
  });

  it('blocks the readers after one whose package could not be vouched for, until a build passes', () => {
    const vouched: StepVerdict = { step: 2, state: 'blocked', reason: 'Package changed' };
    const rebuilt = [check, build, lane('a.js'), lane('b.js'), build, lane('c.js')];
    expect(nextRunnableStep(rebuilt, [red(0), vouched], 3)).toMatchObject({
      index: 4,
      blocked: [{ step: 3, reason: 'Blocked by step 2 (test), which could not run' }],
    });
    expect(nextRunnableStep(rebuilt, [red(0), vouched, { ...vouched, step: 3 }], 5)).toEqual({
      index: 5,
      blocked: [],
    });
  });
});
