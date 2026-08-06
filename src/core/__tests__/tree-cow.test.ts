// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneEntry, type CloneExecutor, cowCopyArgs, detectCowSupport } from '../tree-cow.js';

describe('detectCowSupport', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ff-cow-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports none on unsupported platforms without probing', async () => {
    const executor = vi.fn<CloneExecutor>();
    await expect(detectCowSupport(dir, 'win32', executor)).resolves.toBe('none');
    expect(executor).not.toHaveBeenCalled();
  });

  it('probes with cp -c on darwin and reports clonefile on success', async () => {
    const executor = vi.fn<CloneExecutor>().mockResolvedValue(undefined);
    await expect(detectCowSupport(dir, 'darwin', executor)).resolves.toBe('clonefile');
    const [command, args] = executor.mock.calls[0] ?? [];
    expect(command).toBe('cp');
    expect(args?.[0]).toBe('-c');
  });

  it('probes with cp --reflink=always on linux and reports reflink on success', async () => {
    const executor = vi.fn<CloneExecutor>().mockResolvedValue(undefined);
    await expect(detectCowSupport(dir, 'linux', executor)).resolves.toBe('reflink');
    expect(executor.mock.calls[0]?.[1]?.[0]).toBe('--reflink=always');
  });

  it('reports none when the probe copy fails (e.g. ext4) and cleans up the probe dir', async () => {
    const executor = vi.fn<CloneExecutor>().mockRejectedValue(new Error('cp: reflink unsupported'));
    await expect(detectCowSupport(dir, 'linux', executor)).resolves.toBe('none');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((e) => e.includes('cow-probe'))).toEqual([]);
  });
});

describe('cloneEntry', () => {
  it('uses clonefile args on darwin CoW', async () => {
    const executor = vi.fn<CloneExecutor>().mockResolvedValue(undefined);
    await cloneEntry('clonefile', '/src/engine', '/dst/engine', 'darwin', executor);
    expect(executor).toHaveBeenCalledWith('cp', ['-c', '-R', '-p', '/src/engine', '/dst/engine']);
  });

  it('uses reflink args on linux CoW', async () => {
    const executor = vi.fn<CloneExecutor>().mockResolvedValue(undefined);
    await cloneEntry('reflink', '/src/patches', '/dst/patches', 'linux', executor);
    expect(executor).toHaveBeenCalledWith('cp', [
      '--reflink=always',
      '-a',
      '/src/patches',
      '/dst/patches',
    ]);
  });

  it('falls back to a plain physical copy under capability none (--force-copy path)', async () => {
    const executor = vi.fn<CloneExecutor>().mockResolvedValue(undefined);
    await cloneEntry('none', '/src/x', '/dst/x', 'darwin', executor);
    expect(executor).toHaveBeenCalledWith('cp', ['-R', '-p', '/src/x', '/dst/x']);
    await cloneEntry('none', '/src/x', '/dst/x', 'linux', executor);
    expect(executor).toHaveBeenLastCalledWith('cp', ['-a', '/src/x', '/dst/x']);
  });

  it('exposes the per-capability argv prefix for callers', () => {
    expect(cowCopyArgs('clonefile')).toEqual(['-c', '-R', '-p']);
    expect(cowCopyArgs('reflink')).toEqual(['--reflink=always', '-a']);
  });
});
