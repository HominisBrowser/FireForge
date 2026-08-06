// SPDX-License-Identifier: EUPL-1.2
/**
 * End-to-end coverage for `fireforge tree` (FORGE G15): real tempdir +
 * git, real clone (CoW when the filesystem supports it — the create path
 * probes and uses clonefile/reflink on APFS/btrfs; `--force-copy` keeps
 * the same path green on ext4 CI runners), and the read-only guard
 * enforced through the real commander program.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTreeMarker } from '../../core/tree-store.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { treeCreateCommand, treeListCommand, treeRemoveCommand } from '../tree.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  setVerbose: vi.fn(),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

import { info } from '../../utils/logger.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('fireforge tree end to end (FORGE G15)', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-tree-cmd-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'content\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': '{"version":1,"patches":[]}\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('create → list → remove round-trips with a real clone', async () => {
    await treeCreateCommand(projectRoot, 'shard-a', { forceCopy: true });

    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'shard-a');
    await expect(pathExists(join(treeRoot, 'fireforge.json'))).resolves.toBe(true);
    await expect(readTreeMarker(treeRoot)).resolves.toMatchObject({ name: 'shard-a' });

    await treeListCommand(projectRoot);
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('shard-a'));
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('fresh'));

    // Duplicate names refuse — refresh is remove + create.
    await expect(treeCreateCommand(projectRoot, 'shard-a', { forceCopy: true })).rejects.toThrow(
      /already exists/
    );

    await treeRemoveCommand(projectRoot, 'shard-a');
    await expect(pathExists(treeRoot)).resolves.toBe(false);
  });

  it('tree list --json emits a machine-readable document', async () => {
    await treeCreateCommand(projectRoot, 'shard-json', { forceCopy: true });
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    try {
      await treeListCommand(projectRoot, { json: true });
    } finally {
      stdoutSpy.mockRestore();
    }
    const payload = JSON.parse(writes.join('')) as {
      schemaVersion: number;
      trees: Array<{ name: string; staleness: string }>;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.trees).toMatchObject([{ name: 'shard-json', staleness: 'fresh' }]);
  });

  it('creating a tree from INSIDE a tree is refused (no nesting)', async () => {
    await treeCreateCommand(projectRoot, 'outer', { forceCopy: true });
    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'outer');

    await expect(treeCreateCommand(treeRoot, 'inner', { forceCopy: true })).rejects.toThrow(
      /cannot be nested/
    );
  });

  it('the guard refuses a mutating command run with cwd inside a tree, through the real program', async () => {
    await treeCreateCommand(projectRoot, 'guarded', { forceCopy: true });
    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'guarded');

    const { createProgram } = await import('../../cli.js');
    const previousCwd = process.cwd();
    process.chdir(treeRoot);
    try {
      const program = createProgram();
      program.exitOverride();
      await expect(program.parseAsync(['node', 'fireforge', 're-export'])).rejects.toThrow(
        /verification tree \("guarded"/
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});
