// SPDX-License-Identifier: EUPL-1.2
/**
 * Orphaned-harness-worker doctor check tests. The parser runs against
 * planted fixture `ps` lines — never a real spun orphan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
}));

import type { DoctorCheck } from '../../types/commands/index.js';
import { exec } from '../../utils/process.js';
import {
  findOrphanedHarnessWorkers,
  ORPHANED_HARNESS_DOCTOR_CHECK,
} from '../doctor-orphaned-harness.js';

// The field-incident shape: reparented to launchd (PPID 1), ~26 days of
// CPU time, a multiprocessing spawn worker bootstrap command line.
const INCIDENT_LINE =
  ' 4242     1 26-03:14:12 /usr/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=6, pipe_handle=12)';
const TRACKER_LINE_DARWIN =
  ' 4243     1 38412:07.55 /usr/bin/python3 -c from multiprocessing.resource_tracker import main;main(5)';

const FIXTURE_PS_OUTPUT = [
  '    1     0 45:12.33 /sbin/launchd',
  INCIDENT_LINE,
  TRACKER_LINE_DARWIN,
  // Live parent — same command shape but NOT orphaned.
  ' 5100   812 55:00.00 /usr/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=6, pipe_handle=9)',
  // Orphaned multiprocessing worker with trivial CPU time — freshly forked,
  // not the busy-spin shape.
  ' 5200     1 0:03.11 /usr/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=4, pipe_handle=7)',
  // Orphaned, huge time, but not a multiprocessing worker.
  ' 5300     1 26-00:00:01 /usr/local/bin/node /opt/thing/server.js',
  'garbage line that does not parse',
  '',
].join('\n');

describe('findOrphanedHarnessWorkers', () => {
  it('flags the planted incident shape and the darwin-dialect tracker, nothing else', () => {
    const workers = findOrphanedHarnessWorkers(FIXTURE_PS_OUTPUT);
    expect(workers.map((w) => w.pid)).toEqual([4242, 4243]);
    expect(workers[0]?.command).toContain('multiprocessing.spawn');
    expect(workers[0]?.cpuTime).toBe('26-03:14:12');
    expect(workers[1]?.command).toContain('resource_tracker');
  });

  it('does not flag live-parent, low-CPU, or non-matching-command processes', () => {
    const workers = findOrphanedHarnessWorkers(FIXTURE_PS_OUTPUT);
    const pids = workers.map((w) => w.pid);
    expect(pids).not.toContain(5100); // ppid 812 — live parent
    expect(pids).not.toContain(5200); // 3 seconds of CPU — not the busy-spin shape
    expect(pids).not.toContain(5300); // long-running node, not a harness worker
  });

  it('honours a custom CPU threshold', () => {
    const workers = findOrphanedHarnessWorkers(FIXTURE_PS_OUTPUT, 1);
    expect(workers.map((w) => w.pid)).toContain(5200);
  });
});

describe('ORPHANED_HARNESS_DOCTOR_CHECK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runCheck(): Promise<DoctorCheck> {
    const result = await ORPHANED_HARNESS_DOCTOR_CHECK.run({} as never);
    return Array.isArray(result) ? (result[0] as DoctorCheck) : result;
  }

  it('is skipped on win32 (no ps)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(ORPHANED_HARNESS_DOCTOR_CHECK.skipIf?.({} as never)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('reports a warning naming the planted orphan with a kill suggestion, never auto-killing', async () => {
    vi.mocked(exec).mockResolvedValue({
      stdout: FIXTURE_PS_OUTPUT,
      stderr: '',
      exitCode: 0,
    });

    const check = await runCheck();

    expect(exec).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,ppid=,time=,command='],
      expect.anything()
    );
    // 'warning' IS the report-only assertion now: it is the single field that
    // decides the outcome, so a separate `passed` check would restate it.
    expect(check.severity).toBe('warning');
    expect(check.message).toContain('PID 4242');
    expect(check.message).toContain('26-03:14:12');
    expect(check.fix).toContain('kill 4242 4243');
    expect(check.fix).toContain('never kills pre-existing processes automatically');
  });

  it('returns ok when no orphan-shaped process exists', async () => {
    vi.mocked(exec).mockResolvedValue({
      stdout: '    1     0 45:12.33 /sbin/launchd\n',
      stderr: '',
      exitCode: 0,
    });

    const check = await runCheck();
    expect(check.severity).toBe('ok');
  });

  it('degrades a failed process scan to a warning instead of failing doctor', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('ps not available'));

    const check = await runCheck();
    expect(check.severity).toBe('warning');
    expect(check.message).toContain('Could not scan system processes');
  });
});
