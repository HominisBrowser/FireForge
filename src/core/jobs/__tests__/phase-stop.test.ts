// SPDX-License-Identifier: EUPL-1.2
/** A stop that keeps going until the process is gone. Real signals, against a real process. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { withinDeadline } from '../phase-outcome.js';
import { type PhaseHost, PhaseRunner } from '../phase-runner.js';
import { processIdentityAsync, signalOwnedProcess } from '../process.js';

vi.mock('../process.js', async (original) => {
  const actual = await original<typeof import('../process.js')>();
  return { ...actual, signalOwnedProcess: vi.fn(actual.signalOwnedProcess) };
});

interface InternalSession {
  release: () => Promise<void>;
  prepared: boolean;
  child?: unknown;
  stop?: { since: number; sent?: NodeJS.Signals };
}

describe.skipIf(process.platform === 'win32')('stopping a phase', () => {
  it('retries a signal a failed probe swallowed, and escalates past the grace', async () => {
    const child = spawn('sh', ['-c', "trap '' TERM; exec sleep 600"], {
      detached: true,
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const identity = await processIdentityAsync(child.pid ?? 0);
    if (identity === undefined) throw new Error('No identity');
    const exited = once(child, 'exit');
    const runner = new PhaseRunner({
      namespace: '/nonexistent',
      liveProcess: () => identity,
      logFault: () => undefined,
    } as unknown as PhaseHost);
    const session: InternalSession = {
      release: () => Promise.resolve(),
      prepared: true,
      child,
      stop: { since: Date.now() },
    };
    (runner as unknown as { sessions: Map<string, InternalSession> }).sessions.set('job', session);

    // The probe reads false: nothing was sent and nothing says so.
    vi.mocked(signalOwnedProcess).mockResolvedValueOnce(false);
    await runner.retryStops();
    expect(session.stop?.sent).toBeUndefined();
    await runner.retryStops();
    expect(session.stop?.sent).toBe('SIGTERM');
    // Delivered once is enough, until the grace is over.
    vi.mocked(signalOwnedProcess).mockClear();
    await runner.retryStops();
    expect(signalOwnedProcess).not.toHaveBeenCalled();
    if (session.stop !== undefined) session.stop.since = Date.now() - 60_000;
    vi.mocked(signalOwnedProcess).mockResolvedValueOnce(false);
    await runner.retryStops();
    expect(session.stop?.sent).toBe('SIGTERM');
    await runner.retryStops();
    expect(session.stop?.sent).toBe('SIGKILL');
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGKILL');
  }, 30_000);
});

describe('work with no process to signal', () => {
  it('gives up on it at its deadline, whatever it is doing', async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withinDeadline(never, 20, () => new Error('did not finish'))).rejects.toThrow(
      'did not finish'
    );
    await expect(withinDeadline(Promise.resolve(1), 1_000, () => new Error('x'))).resolves.toBe(1);
  });
});
