// SPDX-License-Identifier: EUPL-1.2
/**
 * A TRANSIENT `.git/index.lock` contention must not be reported as an
 * unmeasurable engine.
 *
 * The one-sided "could not probe" branch is what turns a perfectly good
 * suite into `FIREFORGE-VERDICT: FAIL reason=inconclusive`, so a probe
 * failure that another writer would clear in milliseconds has to be
 * retried rather than latched. `git-base` is mocked here because the
 * behaviour under test is the RETRY, and a real repository cannot be made
 * to fail exactly once on demand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-base.js', () => ({ git: vi.fn() }));

import { snapshotEngineGeneration } from '../engine-session-lock.js';
import { git } from '../git-base.js';

const mockGit = vi.mocked(git);

/** Queues one full probe (`rev-parse` then `status`) that succeeds. */
function queueSuccessfulProbe(head: string, status: string): void {
  mockGit.mockResolvedValueOnce(`${head}\n`).mockResolvedValueOnce(status);
}

describe('snapshotEngineGeneration probe retry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('retries a transient index.lock failure and returns a real token', async () => {
    mockGit.mockRejectedValueOnce(
      new Error("Unable to create '/x/engine/.git/index.lock': File exists.")
    );
    queueSuccessfulProbe('abc123', ' M browser/a.js\0');

    const token = await snapshotEngineGeneration('/x/engine');

    expect(token).toBe('abc123\0 M browser/a.js\0');
    expect(mockGit).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a durable failure — a non-git engine is a state, not a blip', async () => {
    mockGit.mockRejectedValue(new Error('fatal: not a git repository'));

    const token = await snapshotEngineGeneration('/x/engine');

    expect(token).toMatch(/^unavailable:/);
    expect(mockGit).toHaveBeenCalledTimes(1);
  });

  it('gives up (as unavailable) when index.lock contention never clears', async () => {
    mockGit.mockRejectedValue(new Error("Unable to create '.git/index.lock': File exists."));

    const token = await snapshotEngineGeneration('/x/engine');

    expect(token).toMatch(/^unavailable:/);
    expect(token).toContain('index.lock');
    // Bounded: the guard must not poll forever on a genuinely stuck lock.
    expect(mockGit).toHaveBeenCalledTimes(3);
  });
});
