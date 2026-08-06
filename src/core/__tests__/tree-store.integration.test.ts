// SPDX-License-Identifier: EUPL-1.2
/**
 * Tree store integration (FORGE G15): real tempdir + real git, cloning
 * with capability 'none' (plain `cp`) so the suite runs identically on
 * CoW and non-CoW filesystems. The CoW-specific argv layer is covered by
 * `tree-cow.test.ts`; a real clonefile/reflink clone is exercised by the
 * capability-gated case in `tree.integration.test.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import {
  assertValidTreeName,
  cloneTree,
  computePrimaryFingerprint,
  getTreesDir,
  listTrees,
  readTreeMarker,
  removeTree,
} from '../tree-store.js';

describe('tree store (FORGE G15)', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-tree-store-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'content\n',
      'obj-debug-marker/.gitkeep': '',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': '{"version":1,"patches":[]}\n',
      '.fireforge/state.json': '{"brand":"test"}\n',
      '.fireforge-history.jsonl': '{"op":"secret"}\n',
    });
    // Simulate an objdir and a held root lock — neither may be cloned.
    await mkdir(join(projectRoot, 'engine', 'obj-x86_64', 'dist'), { recursive: true });
    await mkdir(join(projectRoot, '.fireforge-build.lock'), { recursive: true });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  async function createTestTree(name: string): Promise<string> {
    const treeRoot = join(getTreesDir(projectRoot), name);
    await mkdir(getTreesDir(projectRoot), { recursive: true });
    await cloneTree({
      primaryRoot: projectRoot,
      treeRoot,
      name,
      capability: 'none',
      createdAt: '2026-08-06T00:00:00.000Z',
    });
    return treeRoot;
  }

  it('clones the project shape, excludes state/locks/history/objdirs, and writes the marker', async () => {
    const treeRoot = await createTestTree('shard-a');

    await expect(pathExists(join(treeRoot, 'fireforge.json'))).resolves.toBe(true);
    await expect(
      pathExists(join(treeRoot, 'engine', 'browser', 'base', 'content', 'app.js'))
    ).resolves.toBe(true);
    await expect(pathExists(join(treeRoot, 'patches', 'patches.json'))).resolves.toBe(true);
    // Exclusions: objdirs, locks, history, primary .fireforge internals.
    await expect(pathExists(join(treeRoot, 'engine', 'obj-x86_64'))).resolves.toBe(false);
    await expect(pathExists(join(treeRoot, '.fireforge-build.lock'))).resolves.toBe(false);
    await expect(pathExists(join(treeRoot, '.fireforge-history.jsonl'))).resolves.toBe(false);
    await expect(pathExists(join(treeRoot, '.fireforge', 'trees'))).resolves.toBe(false);
    // Fresh .fireforge carries state.json + the marker.
    await expect(readFile(join(treeRoot, '.fireforge', 'state.json'), 'utf8')).resolves.toContain(
      '"brand"'
    );
    const marker = await readTreeMarker(treeRoot);
    expect(marker).toMatchObject({ schemaVersion: 1, name: 'shard-a', primaryRoot: projectRoot });
    expect(marker?.engineHead).toMatch(/^[0-9a-f]{40}$/);
    expect(marker?.patchesFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tree independence: mutating a cloned file leaves the primary untouched', async () => {
    const treeRoot = await createTestTree('shard-b');
    await writeFile(
      join(treeRoot, 'engine', 'browser', 'base', 'content', 'app.js'),
      'tree-side edit\n'
    );
    await expect(
      readFile(join(projectRoot, 'engine', 'browser', 'base', 'content', 'app.js'), 'utf8')
    ).resolves.toBe('content\n');
  });

  it('lists trees with staleness verdicts against the current primary state', async () => {
    await createTestTree('shard-a');
    await expect(listTrees(projectRoot)).resolves.toMatchObject([
      { name: 'shard-a', staleness: 'fresh' },
    ]);

    // Patches change → stale (patches changed).
    await writeFiles(projectRoot, {
      'patches/patches.json': '{"version":1,"patches":[{"x":1}]}\n',
    });
    await expect(listTrees(projectRoot)).resolves.toMatchObject([
      { name: 'shard-a', staleness: 'stale (patches changed)' },
    ]);

    // Engine advances → stale (engine advanced) takes precedence.
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'changed\n',
    });
    const { runGit } = await import('../../test-utils/index.js');
    await runGit(join(projectRoot, 'engine'), ['add', '-A']);
    await runGit(join(projectRoot, 'engine'), ['commit', '-m', 'advance']);
    await expect(listTrees(projectRoot)).resolves.toMatchObject([
      { name: 'shard-a', staleness: 'stale (engine advanced)' },
    ]);
  });

  it('removeTree deletes a tree but refuses while a live process holds a tree lock', async () => {
    const treeRoot = await createTestTree('shard-a');

    // Synthetic live holder: this test process's own pid in the tree's build lock.
    const lockDir = join(treeRoot, '.fireforge-build.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'pid'), `${String(process.pid)}\ntoken\n`);

    await expect(removeTree(projectRoot, 'shard-a')).rejects.toThrow(
      /a live process \(pid \d+\) holds/
    );
    await expect(pathExists(treeRoot)).resolves.toBe(true);

    // Dead holder → removal proceeds.
    await writeFile(join(lockDir, 'pid'), '999999999\ntoken\n');
    await removeTree(projectRoot, 'shard-a');
    await expect(pathExists(treeRoot)).resolves.toBe(false);
  });

  it('refuses traversal-shaped names and paths escaping the trees directory', async () => {
    expect(() => {
      assertValidTreeName('../evil');
    }).toThrow(/Invalid tree name/);
    expect(() => {
      assertValidTreeName('a/b');
    }).toThrow(/Invalid tree name/);
    expect(() => {
      assertValidTreeName('.hidden');
    }).toThrow(/Invalid tree name/);
    await expect(removeTree(projectRoot, 'missing')).rejects.toThrow(/No verification tree named/);
  });

  it('computePrimaryFingerprint degrades to nulls without engine or patches', async () => {
    const bareRoot = await createTempProject('ff-tree-bare-');
    try {
      await expect(computePrimaryFingerprint(bareRoot)).resolves.toEqual({
        engineHead: null,
        patchesFingerprint: null,
      });
    } finally {
      await removeTempProject(bareRoot);
    }
  });
});
