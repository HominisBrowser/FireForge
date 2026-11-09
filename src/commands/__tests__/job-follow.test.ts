// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelJob, readJobLogs, waitForJob } from '../../core/jobs/client.js';
import { stepMarker } from '../../core/jobs/job-view.js';
import type { JobView } from '../../core/jobs/schema.js';
import { followJob } from '../job-follow.js';

vi.mock('../../core/jobs/client.js', () => ({
  cancelJob: vi.fn(),
  readJobLogs: vi.fn(),
  waitForJob: vi.fn(),
}));

const view = (state: JobView['state']): JobView =>
  ({ id: 'job-1', state, owner: 'me', request: { steps: [] } }) as unknown as JobView;

/** A log that grows by one piece per read of the job's state. */
function growingLog(pieces: string[]): void {
  let log = '';
  vi.mocked(waitForJob).mockImplementation(() => {
    const next = pieces.shift();
    if (next !== undefined) log += next;
    return Promise.resolve(view(pieces.length === 0 ? 'passed' : 'running'));
  });
  vi.mocked(readJobLogs).mockImplementation((_namespace, _id, offset = 0, limit = 262_144) => {
    const bytes = Buffer.from(log);
    const end = Math.min(bytes.length, offset + limit);
    return Promise.resolve({
      text: bytes.subarray(offset, end).toString(),
      nextOffset: end,
      totalBytes: bytes.length,
    });
  });
}

const sink = (): { out: string[]; notes: string[]; output: Parameters<typeof followJob>[2] } => {
  const out: string[] = [];
  const notes: string[] = [];
  return {
    out,
    notes,
    output: {
      out: (text) => out.push(text),
      note: (line) => notes.push(line),
    },
  };
};

let listeners: Map<string, readonly unknown[]>;
beforeEach(() => {
  vi.resetAllMocks();
  listeners = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal): [string, readonly unknown[]] => [
      signal,
      process.listeners(signal),
    ])
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('following a job', () => {
  it('streams whole lines as they come, heads each step, and ends on the terminal state', async () => {
    growingLog([
      stepMarker(0, { command: 'build', args: ['--ui'] }),
      'building',
      ' done\n',
      stepMarker(1, { command: 'run', args: ['--', 'about:blank'] }),
      'ran the browser\nno newline at the end',
    ]);
    const { out, output } = sink();
    const job = await followJob('/ns', 'job-1', output);
    expect(job.state).toBe('passed');
    expect(out.join('')).toBe(
      '--- step 0: build --ui\nbuilding done\n--- step 1: run -- about:blank\nran the browser\nno newline at the end'
    );
    // What the process had for its signals, it has again.
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      expect(process.listeners(signal)).toEqual(listeners.get(signal));
  });

  it('reads a log longer than one chunk to its end, and passes a malformed marker through', async () => {
    const long = `${'x'.repeat(300_000)}\nFIREFORGE-JOB-STEP: {broken\n`;
    growingLog([long]);
    const { out, output } = sink();
    await followJob('/ns', 'job-1', output);
    expect(out.join('')).toBe(long);
    expect(vi.mocked(readJobLogs).mock.calls.length).toBeGreaterThan(1);
  });

  it('says once why a job waits', async () => {
    let calls = 0;
    vi.mocked(waitForJob).mockImplementation((_namespace, _id, _timeout, onBlocked) => {
      calls += 1;
      if (calls < 4) onBlocked?.('slot a is busy');
      if (calls === 3) onBlocked?.('host-load: busy');
      return Promise.resolve(view(calls >= 4 ? 'passed' : 'queued'));
    });
    vi.mocked(readJobLogs).mockResolvedValue({ text: '', nextOffset: 0, totalBytes: 0 });
    const { notes, output } = sink();
    await followJob('/ns', 'job-1', output);
    expect(notes).toEqual([
      'Job job-1 waiting: slot a is busy',
      'Job job-1 waiting: host-load: busy',
    ]);
  });

  it('cancels on the first signal and hands a second one back to the process', async () => {
    let reads = 0;
    vi.mocked(waitForJob).mockImplementation(() => {
      reads += 1;
      if (reads === 2) process.emit('SIGINT', 'SIGINT');
      if (reads === 3) process.emit('SIGINT', 'SIGINT');
      // The cancel settles the slot first, and only then ends the job.
      return Promise.resolve(view(reads >= 4 ? 'cancelled' : 'running'));
    });
    vi.mocked(readJobLogs).mockResolvedValue({ text: '', nextOffset: 0, totalBytes: 0 });
    vi.mocked(cancelJob).mockResolvedValue(view('running'));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { notes, output } = sink();
    const job = await followJob('/ns', 'job-1', output);
    expect(job.state).toBe('cancelled');
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith('/ns', 'job-1', { force: true });
    expect(notes[0]).toMatch(/^Job job-1: SIGINT, cancelling\. .*Ctrl-C again stops waiting/);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      expect(process.listeners(signal)).toEqual(listeners.get(signal));
  });

  it('says so when the cancel is refused, and keeps following', async () => {
    let reads = 0;
    vi.mocked(waitForJob).mockImplementation(async () => {
      reads += 1;
      if (reads === 1) process.emit('SIGTERM', 'SIGTERM');
      // Lets the refused cancel settle before the job ends by itself.
      await new Promise((settle) => setTimeout(settle, 5));
      return view(reads >= 3 ? 'passed' : 'running');
    });
    vi.mocked(readJobLogs).mockResolvedValue({ text: '', nextOffset: 0, totalBytes: 0 });
    vi.mocked(cancelJob).mockRejectedValue(new Error('no supervisor'));
    const { notes, output } = sink();
    expect((await followJob('/ns', 'job-1', output)).state).toBe('passed');
    expect(notes[0]).toMatch(/SIGTERM, cancelling\. .*SIGTERM again stops waiting/);
    expect(notes[1]).toBe('Job job-1: the cancel was refused: no supervisor');
  });

  it('writes to the terminal by default', async () => {
    growingLog(['hello\n']);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await followJob('/ns', 'job-1');
    expect(stdout).toHaveBeenCalledWith('hello\n');
  });
});
