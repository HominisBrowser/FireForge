// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
const executableExistsMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));

vi.mock('../../utils/process.js', () => ({
  exec: execMock,
  executableExists: executableExistsMock,
}));

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

import { applyPatchWithFuzz } from '../patch-apply-fuzz.js';

function okResult(): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function failResult(stderr = 'patch does not apply'): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: 1, stdout: '', stderr };
}

describe('applyPatchWithFuzz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executableExistsMock.mockResolvedValue(true);
  });

  it('applies cleanly at fuzz=0', async () => {
    execMock
      .mockResolvedValueOnce(okResult()) // git apply --check (fuzz 0)
      .mockResolvedValueOnce(okResult()); // git apply (fuzz 0)

    const result = await applyPatchWithFuzz('/patch.patch', '/engine', 3);
    expect(result.success).toBe(true);
    expect(result.fuzzFactor).toBe(0);
  });

  it('escalates to fuzz=1 when fuzz=0 fails --check', async () => {
    execMock
      .mockResolvedValueOnce(failResult()) // git apply --check (fuzz 0) fails
      .mockResolvedValueOnce(okResult()) // git apply --check --fuzz=1 passes
      .mockResolvedValueOnce(okResult()); // git apply --fuzz=1

    const result = await applyPatchWithFuzz('/patch.patch', '/engine', 3);
    expect(result.success).toBe(true);
    expect(result.fuzzFactor).toBe(1);
  });

  it('escalates to fuzz=2', async () => {
    execMock
      .mockResolvedValueOnce(failResult()) // fuzz 0 fails
      .mockResolvedValueOnce(failResult()) // fuzz 1 fails
      .mockResolvedValueOnce(okResult()) // fuzz 2 passes --check
      .mockResolvedValueOnce(okResult()); // fuzz 2 apply

    const result = await applyPatchWithFuzz('/patch.patch', '/engine', 3);
    expect(result.success).toBe(true);
    expect(result.fuzzFactor).toBe(2);
  });

  it('falls through to --reject when all fuzz levels fail', async () => {
    // maxFuzz=1: fuzz 0 and fuzz 1 both fail, then --reject
    execMock
      .mockResolvedValueOnce(failResult()) // fuzz 0 --check fails
      .mockResolvedValueOnce(failResult()) // fuzz 1 --check fails
      .mockResolvedValueOnce(failResult('Applying patch with 1 reject')); // --reject

    const result = await applyPatchWithFuzz('/patch.patch', '/engine', 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Applying patch');
  });

  it('respects maxFuzz boundary', async () => {
    // maxFuzz=0: only try fuzz 0, then --reject
    execMock
      .mockResolvedValueOnce(failResult()) // fuzz 0 --check fails
      .mockResolvedValueOnce(failResult('all failed')); // --reject

    const result = await applyPatchWithFuzz('/patch.patch', '/engine', 0);
    expect(result.success).toBe(false);
    // Only 2 calls: 1 check + 1 reject
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
