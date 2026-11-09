// SPDX-License-Identifier: EUPL-1.2
/**
 * A transient `.git/index.lock` contention must not be reported as an
 * unmeasurable engine.
 *
 * The one-sided "could not probe" branch is what turns a perfectly good
 * suite into `FIREFORGE-VERDICT: FAIL reason=inconclusive`, so a probe
 * failure that another writer would clear in milliseconds has to be
 * retried rather than latched. `git-base` is mocked here because the
 * behaviour under test is the retry, and a real repository cannot be made
 * to fail exactly once on demand.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '../../utils/hash.js';

vi.mock('../git-base.js', () => ({ git: vi.fn() }));

import { captureEngineGeneration } from '../engine-state.js';
import { git } from '../git-base.js';

const mockGit = vi.mocked(git);

/** Queues a coherent capture: HEAD, one status walk, HEAD again after the dirty bytes are hashed. */
function queueSuccessfulProbe(head: string, status: string): void {
  mockGit
    .mockResolvedValueOnce(`${head}\n`)
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce(`${head}\n`);
}

describe('captureEngineGeneration probe retry', () => {
  let engineDir: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(async () => {
    if (engineDir) await rm(engineDir, { recursive: true, force: true });
    engineDir = undefined;
  });

  it('retries a transient index.lock failure and returns a real token', async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'fireforge-generation-retry-'));
    await mkdir(join(engineDir, 'browser'));
    await writeFile(join(engineDir, 'browser/a.js'), 'dirty bytes\n', { mode: 0o644 });
    mockGit.mockRejectedValueOnce(
      new Error("Unable to create '/x/engine/.git/index.lock': File exists.")
    );
    queueSuccessfulProbe('abc123', ' M browser/a.js\0');

    const token = await captureEngineGeneration(engineDir);

    expect(token).toMatch(/^abc123\0 M browser\/a\.js\0/);
    expect(token).toContain(sha256Hex(Buffer.from('dirty bytes\n')));
    expect(token).not.toMatch(/^unavailable:/);
    expect(mockGit).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a durable failure — a non-git engine is a state, not a blip', async () => {
    mockGit.mockRejectedValue(new Error('fatal: not a git repository'));

    const token = await captureEngineGeneration('/x/engine');

    expect(token).toMatch(/^unavailable:/);
    expect(mockGit).toHaveBeenCalledTimes(1);
  });

  it('gives up (as unavailable) when index.lock contention never clears', async () => {
    mockGit.mockRejectedValue(new Error("Unable to create '.git/index.lock': File exists."));

    const token = await captureEngineGeneration('/x/engine');

    expect(token).toMatch(/^unavailable:/);
    expect(token).toContain('index.lock');
    // Bounded: the guard must not poll forever on a genuinely stuck lock.
    expect(mockGit).toHaveBeenCalledTimes(3);
  });
});
