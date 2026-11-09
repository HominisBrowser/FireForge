// SPDX-License-Identifier: EUPL-1.2
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { abandonSessions } from '../phase-settlement.js';
import type { ProcessIdentity } from '../schema.js';

const signals = vi.hoisted(() => [] as Array<[number, string]>);
vi.mock('../process.js', async (original) => ({
  ...(await original<typeof import('../process.js')>()),
  signalOwnedProcess: (identity: ProcessIdentity, signal: string) => {
    signals.push([identity.pid, signal]);
    return Promise.resolve(true);
  },
}));

afterEach(() => {
  signals.length = 0;
  vi.useRealTimers();
});

describe('abandoning sessions whose namespace is gone', () => {
  it('signals each live executor, kills it after the grace, and leaves the rest alone', () => {
    vi.useFakeTimers();
    const child = {} as ChildProcess;
    const live = { pid: 41 } as ProcessIdentity;
    const sessions = new Map<string, { child?: ChildProcess }>([
      ['running', { child }],
      ['between-phases', {}],
      ['unknown', { child }],
    ]);
    abandonSessions(sessions, (id) => (id === 'unknown' ? undefined : live), 1000);
    expect(signals).toEqual([[41, 'SIGTERM']]);
    vi.advanceTimersByTime(1000);
    expect(signals).toEqual([
      [41, 'SIGTERM'],
      [41, 'SIGKILL'],
    ]);
  });
});
