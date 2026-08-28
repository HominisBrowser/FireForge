// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));

import { exec } from '../../utils/process.js';
import { readProcessCpuSeconds } from '../process-cpu-time.js';

// `readProcessCpuSeconds` branches on `process.platform` directly, so the
// `ps`-shaped expectations below only hold when the branch is forced.
const originalPlatform = process.platform;

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

beforeEach(() => {
  vi.mocked(exec).mockReset();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

describe('readProcessCpuSeconds', () => {
  it('reads the ps TIME column', async () => {
    vi.mocked(exec).mockResolvedValue({ exitCode: 0, stdout: '  12:30\n', stderr: '' });
    await expect(readProcessCpuSeconds(42)).resolves.toBe(750);
  });

  it('is undefined — never zero — when ps is unavailable', async () => {
    // Reporting a live build as having used no CPU would invert the exact
    // diagnosis this probe exists for.
    vi.mocked(exec).mockRejectedValue(new Error('ENOENT'));
    await expect(readProcessCpuSeconds(42)).resolves.toBeUndefined();
  });

  it('is undefined when the process has exited and ps prints nothing', async () => {
    vi.mocked(exec).mockResolvedValue({ exitCode: 1, stdout: '\n', stderr: '' });
    await expect(readProcessCpuSeconds(42)).resolves.toBeUndefined();
  });

  it('is undefined for an unparseable field', async () => {
    vi.mocked(exec).mockResolvedValue({ exitCode: 0, stdout: 'garbage\n', stderr: '' });
    await expect(readProcessCpuSeconds(42)).resolves.toBeUndefined();
  });

  it('refuses a nonsensical pid without spawning anything', async () => {
    await expect(readProcessCpuSeconds(0)).resolves.toBeUndefined();
    await expect(readProcessCpuSeconds(-1)).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});
