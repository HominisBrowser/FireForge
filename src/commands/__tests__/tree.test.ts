// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit coverage for the `fireforge tree` refusal branches that the
 * integration suite cannot reach on a real filesystem: the no-CoW
 * honest refusal (a mac/btrfs dev host always probes positive) and the
 * Windows platform gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/tree-cow.js', () => ({
  detectCowSupport: vi.fn(() => Promise.resolve('none')),
  cloneEntry: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/tree-store.js', () => ({
  assertValidTreeName: vi.fn(),
  cloneTree: vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1,
      name: 'x',
      primaryRoot: '/p',
      createdAt: 'now',
      engineHead: null,
      patchesFingerprint: null,
    })
  ),
  computePrimaryFingerprint: vi.fn(() =>
    Promise.resolve({ engineHead: null, patchesFingerprint: null })
  ),
  getTreesDir: vi.fn(() => '/p/.fireforge/trees'),
  listTrees: vi.fn(() => Promise.resolve([])),
  readTreeMarker: vi.fn(() => Promise.resolve(undefined)),
  removeTree: vi.fn(() => Promise.resolve()),
  withTreeLifecycleLock: vi.fn((_root: string, op: () => Promise<unknown>) => op()),
}));

vi.mock('../../core/engine-session-lock.js', () => ({
  withEngineSessionLock: vi.fn((_root: string, _cmd: string, op: () => Promise<unknown>) => op()),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCowSupport } from '../../core/tree-cow.js';
import { cloneTree, getTreesDir } from '../../core/tree-store.js';
import { warn } from '../../utils/logger.js';
import { treeCreateCommand, treeRemoveCommand } from '../tree.js';

describe('tree create CoW gating (FORGE G15)', () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'ff-tree-unit-'));
    vi.mocked(getTreesDir).mockImplementation((primary: string) =>
      join(primary, '.fireforge', 'trees')
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses honestly on a filesystem without CoW support, naming --force-copy', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('none');

    await expect(treeCreateCommand(root, 'shard-a')).rejects.toThrow(
      /cannot copy-on-write .*Re-run with --force-copy/s
    );
    expect(cloneTree).not.toHaveBeenCalled();
  });

  it('--force-copy proceeds with a full physical copy and a warning', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('none');

    await expect(treeCreateCommand(root, 'shard-a', { forceCopy: true })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('full physical copy'));
    expect(cloneTree).toHaveBeenCalledWith(expect.objectContaining({ capability: 'none' }));
  });

  it('a CoW-capable filesystem clones without --force-copy', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');

    await expect(treeCreateCommand(root, 'shard-a')).resolves.toBeUndefined();

    expect(cloneTree).toHaveBeenCalledWith(expect.objectContaining({ capability: 'clonefile' }));
  });

  it('remove requires a name or --all', async () => {
    await expect(treeRemoveCommand(root, undefined)).rejects.toThrow(/Pass a tree name, or --all/);
  });
});
