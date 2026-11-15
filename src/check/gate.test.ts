// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { gateFailure, type GateReport, renderGate } from './gate.js';
import type { GateEntry } from './record.js';

const entry = (id: string, extra: Partial<GateEntry> = {}): GateEntry => ({
  id,
  status: 'pass',
  detail: 'ok',
  durationMs: 1,
  ...extra,
});

const report = (...entries: GateEntry[]): GateReport => ({
  outcome: 'failed',
  basis: 'run',
  pass: entries.every((each) => each.status === 'pass'),
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  entries,
  pending: [],
  owed: [],
});

describe('gateFailure', () => {
  it('keeps the exit codes of a product red', () => {
    expect(gateFailure(report(entry('check'), entry('build')))).toBeUndefined();
    expect(gateFailure(report(entry('check', { status: 'fail' })))).toMatchObject({
      code: 'gate-check-failed',
      exitCode: ExitCode.GENERAL_ERROR,
    });
    expect(gateFailure(report(entry('check'), entry('lane:a', { status: 'fail' })))).toMatchObject({
      code: 'gate-failed',
      exitCode: ExitCode.BUILD_ERROR,
    });
  });

  it('ends with the code of the failure when every red entry could not run', () => {
    const lock = entry('lane:a', {
      status: 'fail',
      detail: 'The display is held',
      blocked: 'lock-timeout',
      hint: 'Wait longer.',
    });
    expect(gateFailure(report(entry('check'), lock))).toMatchObject({
      code: 'lock-timeout',
      exitCode: ExitCode.LOCK_TIMEOUT,
      hint: 'Wait longer.',
    });
    const moved = entry('control:x', {
      status: 'fail',
      detail: 'inconclusive: the engine changed while the tests ran',
      blocked: 'inconclusive',
    });
    expect(gateFailure(report(moved))).toMatchObject({
      code: 'gate-inconclusive',
      exitCode: ExitCode.INCONCLUSIVE,
    });
  });

  it('reads a product red beside a blocked entry as red', () => {
    const blocked = entry('lane:a', { status: 'fail', blocked: 'inconclusive' });
    const red = entry('lane:b', { status: 'fail' });
    expect(gateFailure(report(blocked, red))).toMatchObject({
      code: 'gate-failed',
      exitCode: ExitCode.BUILD_ERROR,
      message: 'The gate did not pass: lane:b.',
    });
  });
});

describe('renderGate', () => {
  it('shows a blocked entry as blocked, with its hint, and the controls owed', () => {
    const lines = renderGate({
      ...report(
        entry('lane:a', {
          status: 'fail',
          detail: 'busy',
          blocked: 'lock-timeout',
          hint: 'Wait longer.',
        })
      ),
      owed: [{ id: 'guard', reason: 'missed', detail: 'the last run stayed green' }],
    });
    expect(lines.join('\n')).toMatch(/^lane:a +blocked +\S+ +busy$/m);
    expect(lines).toContain('lane:a: Wait longer.');
    expect(lines.some((line) => line.startsWith('Gate could not judge '))).toBe(true);
    expect(lines).toContain('  control:guard  missed: the last run stayed green');
  });
});

describe('renderGate with reuse and load', () => {
  it('marks a reused entry with when it ran, and says the rest ran', () => {
    const lines = renderGate({
      ...report(
        entry('check'),
        entry('lane:a', { reused: true, ranAt: '2026-01-02T03:04:05.000Z' }),
        entry('lane:b')
      ),
      outcome: 'verified',
    });
    expect(lines.join('\n')).toMatch(
      /^lane:a +pass +\S+ +ok \[reused: it ran 2026-01-02T03:04:05\.000Z\]$/m
    );
    expect(lines.join('\n')).toMatch(/^lane:b +pass +\S+ +ok$/m);
    expect(lines).toContain(
      '1 entry reused from an earlier run of this commit, not run again: lane:a.'
    );
  });

  it('says why a resume ran everything', () => {
    const lines = renderGate({
      ...report(entry('check')),
      outcome: 'verified',
      resume: { reused: [], why: 'the gate declaration changed since the recorded run' },
    });
    expect(lines).toContain(
      'Not resumed: the gate declaration changed since the recorded run; every entry ran.'
    );
  });

  it('shows the host load on the line of a red entry', () => {
    const lines = renderGate(
      report(
        entry('lane:a', {
          status: 'fail',
          detail: 'reason=crash',
          load: { cpus: 10, start: 45, end: 40, busiest: { pid: 4242, name: 'clang', cpu: 310 } },
        })
      )
    );
    expect(lines.join('\n')).toMatch(
      /^lane:a +fail +\S+ +reason=crash \[host load 45 at the start, 40 at the end, on 10 CPUs \(above the CPU count\); busiest process outside this command: clang \(PID 4242, 310% CPU\)\]$/m
    );
  });
});
