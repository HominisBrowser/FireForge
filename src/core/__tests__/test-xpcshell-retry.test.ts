// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../mach.js', () => ({ runMachTestSuite: vi.fn() }));
vi.mock('../test-stale-symlink.js', () => ({ tryRepairStaleXpcshellTestSymlink: vi.fn() }));

import { runMachTestSuite } from '../mach.js';
import { tryRepairStaleXpcshellTestSymlink } from '../test-stale-symlink.js';
import { retryAfterXpcshellSymlinkRepair } from '../test-xpcshell-retry.js';

const FAILED = { exitCode: 1, stdout: 'stale symlink', stderr: '' };
const BASE = {
  engineDir: '/engine',
  objDir: 'obj',
  result: FAILED,
  classification: { xpcshell: ['a/test_a.js'], nonXpcshell: [] },
  normalizedPaths: ['a/test_a.js'],
  extraArgs: ['--log-raw=/tmp/x.jsonl'],
  kind: 'xpcshell-test' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retryAfterXpcshellSymlinkRepair', () => {
  it('re-dispatches after a repair, feeding the retried output to the chunk hook', async () => {
    vi.mocked(tryRepairStaleXpcshellTestSymlink).mockResolvedValueOnce(true);
    const retried = { exitCode: 0, stdout: 'ok', stderr: '' };
    vi.mocked(runMachTestSuite).mockResolvedValueOnce(retried);
    const onOutputChunk = vi.fn();
    await expect(retryAfterXpcshellSymlinkRepair({ ...BASE, onOutputChunk })).resolves.toBe(
      retried
    );
    expect(runMachTestSuite).toHaveBeenCalledWith('xpcshell-test', {
      engineDir: '/engine',
      testPaths: ['a/test_a.js'],
      args: ['--log-raw=/tmp/x.jsonl'],
      env: undefined,
      fullOutput: undefined,
      teardown: { onOutputChunk },
    });
  });

  it('keeps the result when nothing was repaired, or the run was not a failing xpcshell run', async () => {
    vi.mocked(tryRepairStaleXpcshellTestSymlink).mockResolvedValueOnce(false);
    await expect(retryAfterXpcshellSymlinkRepair(BASE)).resolves.toBe(FAILED);
    const green = { exitCode: 0, stdout: '', stderr: '' };
    await expect(retryAfterXpcshellSymlinkRepair({ ...BASE, result: green })).resolves.toBe(green);
    expect(runMachTestSuite).not.toHaveBeenCalled();
  });
});
