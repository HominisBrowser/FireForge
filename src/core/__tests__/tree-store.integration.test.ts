// SPDX-License-Identifier: EUPL-1.2
/**
 * Tree store integration: real tempdir + real git, cloning
 * with capability 'none' (plain `cp`) so the suite runs identically on
 * CoW and non-CoW filesystems. The CoW-specific argv layer is covered by
 * `tree-cow.test.ts`. A real clonefile/reflink clone is exercised by the
 * capability-gated case in `tree.integration.test.ts`.
 */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Passthrough wrapper around the real cloneEntry with a per-test hook, so
// the defense-in-depth case can simulate a copy strategy that
// carries a symlink into the tree without touching any other behavior.
const cloneEntryHook: { after?: ((destinationPath: string) => Promise<void>) | undefined } = {};
vi.mock('../tree-cow.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../tree-cow.js')>();
  return {
    ...original,
    cloneEntry: async (...args: Parameters<typeof original.cloneEntry>): Promise<void> => {
      await original.cloneEntry(...args);
      await cloneEntryHook.after?.(args[2]);
    },
  };
});

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
  writeSyntheticObjdir,
} from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import {
  assertObjdirMatchesTreeMarker,
  assertValidTreeName,
  cloneTree,
  computePrimaryFingerprint,
  getTreesDir,
  listTrees,
  readTreeMarker,
  removeTree,
  tryReadTreeMarker,
} from '../tree-store.js';

describe('tree store', () => {
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
    // Simulate an objdir and a held root lock. Neither may be cloned.
    await mkdir(join(projectRoot, 'engine', 'obj-x86_64', 'dist'), { recursive: true });
    await mkdir(join(projectRoot, '.fireforge-build.lock'), { recursive: true });
  });

  afterEach(async () => {
    cloneEntryHook.after = undefined;
    await removeTempProject(projectRoot);
  });

  async function createTestTree(
    name: string,
    options: {
      withObjdir?: { objDir: string; reconfigure?: (treeEngineDir: string) => Promise<void> };
    } = {}
  ): Promise<string> {
    const treeRoot = join(getTreesDir(projectRoot), name);
    await mkdir(getTreesDir(projectRoot), { recursive: true });
    await cloneTree({
      primaryRoot: projectRoot,
      treeRoot,
      name,
      capability: 'none',
      createdAt: '2026-08-06T00:00:00.000Z',
      ...(options.withObjdir === undefined
        ? {}
        : {
            withObjdir: {
              objDir: options.withObjdir.objDir,
              reconfigure: options.withObjdir.reconfigure ?? (() => Promise.resolve()),
            },
          }),
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
    const marker = await tryReadTreeMarker(treeRoot);
    expect(marker).toMatchObject({ schemaVersion: 1, name: 'shard-a', primaryRoot: projectRoot });
    expect(marker?.engineHead).toMatch(/^[0-9a-f]{40}$/);
    expect(marker?.patchesFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('withObjdir keeps exactly the named objdir, rewrites its mozinfo, scrubs venvs, and copies the baseline', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-x86_64');
    await writeFiles(projectRoot, {
      '.fireforge/last-build.json': '{"schemaVersion":1,"binaryName":"mybrowser"}\n',
    });

    const treeRoot = await createTestTree('shard-obj', { withObjdir: { objDir: 'obj-x86_64' } });

    // The named objdir survives. Every other obj-* is still pruned.
    await expect(pathExists(join(treeRoot, 'engine', 'obj-x86_64', 'dist'))).resolves.toBe(true);
    await expect(pathExists(join(treeRoot, 'engine', 'obj-debug-marker'))).resolves.toBe(false);
    // mozinfo now names the tree, not the primary.
    const mozinfo = JSON.parse(
      await readFile(join(treeRoot, 'engine', 'obj-x86_64', 'mozinfo.json'), 'utf8')
    ) as Record<string, string>;
    expect(mozinfo['topsrcdir']).toBe(join(treeRoot, 'engine'));
    expect(mozinfo['topobjdir']).toBe(join(treeRoot, 'engine', 'obj-x86_64'));
    expect(mozinfo['mozconfig']).toBe(join(treeRoot, 'engine', 'mozconfig'));
    // Cloned venvs carry primary shebangs, so they must be gone.
    await expect(pathExists(join(treeRoot, 'engine', 'obj-x86_64', '_virtualenvs'))).resolves.toBe(
      false
    );
    // The stale-build anchor travels with the build it describes.
    await expect(
      readFile(join(treeRoot, '.fireforge', 'last-build.json'), 'utf8')
    ).resolves.toContain('"mybrowser"');
    await expect(tryReadTreeMarker(treeRoot)).resolves.toMatchObject({
      schemaVersion: 1,
      clonedObjdir: 'obj-x86_64',
    });
    // The primary objdir's mozinfo is untouched.
    const primaryMozinfo = JSON.parse(
      await readFile(join(engineDir, 'obj-x86_64', 'mozinfo.json'), 'utf8')
    ) as Record<string, string>;
    expect(primaryMozinfo['topsrcdir']).toBe(engineDir);
  });

  it('withObjdir refuses fail-closed when the mozinfo rewrite cannot prove safety', async () => {
    // A topobjdir outside topsrcdir means the workspace was configured
    // differently. The rewriter refuses, and the clone must too, because
    // keeping the objdir would leave it operating against the primary.
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-x86_64', { topobjdir: '/somewhere/else/obj' });

    await expect(
      createTestTree('shard-bad', { withObjdir: { objDir: 'obj-x86_64' } })
    ).rejects.toThrow(/Cannot keep the cloned build.*not inside topsrcdir/s);
    // No marker claiming a usable objdir was written.
    const treeRoot = join(getTreesDir(projectRoot), 'shard-bad');
    await expect(pathExists(join(treeRoot, '.fireforge', 'tree.json'))).resolves.toBe(false);
  });

  it('withObjdir runs the reconfigure hook after the mozinfo rewrite and before the marker exists', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-x86_64');

    const observed: {
      engineDir?: string;
      mozinfoTopsrcdir?: string | undefined;
      markerExists?: boolean;
    } = {};
    const treeRoot = join(getTreesDir(projectRoot), 'shard-cfg');
    const reconfigure = async (treeEngineDir: string): Promise<void> => {
      observed.engineDir = treeEngineDir;
      const mozinfo = JSON.parse(
        await readFile(join(treeEngineDir, 'obj-x86_64', 'mozinfo.json'), 'utf8')
      ) as Record<string, string>;
      observed.mozinfoTopsrcdir = mozinfo['topsrcdir'];
      observed.markerExists = await pathExists(join(treeRoot, '.fireforge', 'tree.json'));
    };

    await createTestTree('shard-cfg', { withObjdir: { objDir: 'obj-x86_64', reconfigure } });

    // The hook saw the tree engine, an already-rewritten mozinfo, and no
    // marker yet: configure output is regenerated before anything vouches
    // for the objdir as usable.
    expect(observed.engineDir).toBe(join(treeRoot, 'engine'));
    expect(observed.mozinfoTopsrcdir).toBe(join(treeRoot, 'engine'));
    expect(observed.markerExists).toBe(false);
    await expect(tryReadTreeMarker(treeRoot)).resolves.toMatchObject({
      clonedObjdir: 'obj-x86_64',
    });
  });

  it('withObjdir stays fail-closed when the reconfigure hook throws: no marker is written', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-x86_64');

    await expect(
      createTestTree('shard-cfg-fail', {
        withObjdir: {
          objDir: 'obj-x86_64',
          reconfigure: () => Promise.reject(new Error('configure exploded')),
        },
      })
    ).rejects.toThrow(/configure exploded/);
    const treeRoot = join(getTreesDir(projectRoot), 'shard-cfg-fail');
    await expect(pathExists(join(treeRoot, '.fireforge', 'tree.json'))).resolves.toBe(false);
  });

  it('withObjdir refuses a symlinked primary objdir BEFORE any copying and mutates nothing', async () => {
    // An external build linked into engine/: every cp mode preserves the
    // link, so a clone would rewrite the original build through it.
    const externalBuild = join(projectRoot, 'external-build', 'obj-linked');
    await writeSyntheticObjdir(join(projectRoot, 'external-build'), 'obj-linked');
    const externalMozinfoBefore = await readFile(join(externalBuild, 'mozinfo.json'), 'utf8');
    await symlink(externalBuild, join(projectRoot, 'engine', 'obj-linked'));

    await expect(
      createTestTree('shard-symlink', { withObjdir: { objDir: 'obj-linked' } })
    ).rejects.toThrow(/refuses engine\/obj-linked: it is a symlink/);

    // Refusal happened before copying: no tree root was materialised.
    await expect(pathExists(join(getTreesDir(projectRoot), 'shard-symlink'))).resolves.toBe(false);
    // The external build is byte-identical and its venvs survived.
    await expect(readFile(join(externalBuild, 'mozinfo.json'), 'utf8')).resolves.toBe(
      externalMozinfoBefore
    );
    await expect(pathExists(join(externalBuild, '_virtualenvs'))).resolves.toBe(true);
  });

  it('withObjdir refuses objdir names that are not a single obj-* path segment', async () => {
    for (const objDir of ['../evil', 'obj-x/sub', 'dist', 'obj-..x']) {
      await expect(createTestTree('shard-badname', { withObjdir: { objDir } })).rejects.toThrow(
        /Invalid objdir name/
      );
    }
    await expect(pathExists(join(getTreesDir(projectRoot), 'shard-badname'))).resolves.toBe(false);
  });

  it('defense in depth: a symlink that materialises inside the tree after cloning is refused before any write', async () => {
    // The primary objdir is a legitimate real directory, but the (hooked)
    // copy carries a symlink into the tree, so the cloned-role re-check must
    // refuse before the mozinfo rewrite or the _virtualenvs removal runs.
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-x86_64');
    const externalBuild = join(projectRoot, 'external-build', 'obj-x86_64');
    await writeSyntheticObjdir(join(projectRoot, 'external-build'), 'obj-x86_64');
    const externalMozinfoBefore = await readFile(join(externalBuild, 'mozinfo.json'), 'utf8');
    cloneEntryHook.after = async (destinationPath: string): Promise<void> => {
      if (!destinationPath.endsWith(`${sep}engine${sep}obj-x86_64`)) return;
      await rm(destinationPath, { recursive: true, force: true });
      await symlink(externalBuild, destinationPath);
    };

    await expect(
      createTestTree('shard-deep', { withObjdir: { objDir: 'obj-x86_64' } })
    ).rejects.toThrow(/refuses the tree's engine\/obj-x86_64: it is a symlink/);

    await expect(readFile(join(externalBuild, 'mozinfo.json'), 'utf8')).resolves.toBe(
      externalMozinfoBefore
    );
    await expect(pathExists(join(externalBuild, '_virtualenvs'))).resolves.toBe(true);
  });

  it('default clone stays objdir-free: no baseline copy, no clonedObjdir marker field', async () => {
    await writeFiles(projectRoot, {
      '.fireforge/last-build.json': '{"schemaVersion":1}\n',
    });
    const treeRoot = await createTestTree('shard-plain');
    await expect(pathExists(join(treeRoot, '.fireforge', 'last-build.json'))).resolves.toBe(false);
    const marker = await tryReadTreeMarker(treeRoot);
    expect(marker).toBeDefined();
    expect(marker?.clonedObjdir).toBeUndefined();
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

  it('marks a tree stale when uncommitted engine content changes without advancing HEAD', async () => {
    await createTestTree('shard-a');
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'dirty iterative edit\n',
    });

    await expect(listTrees(projectRoot)).resolves.toMatchObject([
      { name: 'shard-a', staleness: 'stale (engine worktree changed)' },
    ]);
  });

  it('marks a tree stale when a patch body changes without changing patches.json', async () => {
    await writeFiles(projectRoot, {
      'patches/001-ui-example.patch': 'diff --git a/a b/a\n+first\n',
    });
    await createTestTree('shard-a');
    await writeFiles(projectRoot, {
      'patches/001-ui-example.patch': 'diff --git a/a b/a\n+second\n',
    });

    await expect(listTrees(projectRoot)).resolves.toMatchObject([
      { name: 'shard-a', staleness: 'stale (patches changed)' },
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

  it('removeTree treats an EPERM liveness probe as a live holder and refuses', async () => {
    // A build lock held by a process running under a different uid
    // (root-owned build, sudo, shared CI runner, container UID mismatch)
    // answers `kill(pid, 0)` with EPERM, not ESRCH. Reading that as "dead"
    // `rm -rf`s the whole tree clone out from under the running build.
    const treeRoot = await createTestTree('shard-a');
    const lockDir = join(treeRoot, '.fireforge-build.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'pid'), '12345\ntoken\n');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    try {
      await expect(removeTree(projectRoot, 'shard-a')).rejects.toThrow(
        /a live process \(pid 12345\) holds/
      );
      await expect(pathExists(treeRoot)).resolves.toBe(true);
    } finally {
      killSpy.mockRestore();
    }

    // ESRCH is the only errno that means dead, so removal then proceeds.
    const esrchSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    try {
      await removeTree(projectRoot, 'shard-a');
    } finally {
      esrchSpy.mockRestore();
    }
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
        engineFingerprint: null,
        patchesFingerprint: null,
      });
    } finally {
      await removeTempProject(bareRoot);
    }
  });

  it('rejects a malformed tree marker field by field', async () => {
    // Checking only `schemaVersion` and `name` and asserting the rest is not
    // enough: `primaryRoot` reaches a user-facing refusal message, and
    // `engineHead`/`patchesFingerprint` feed the staleness compare, where an
    // `undefined` reports every tree as stale.
    const treeRoot = await createTestTree('shard-a');
    const markerPath = join(treeRoot, '.fireforge', 'tree.json');
    const valid = await tryReadTreeMarker(treeRoot);
    expect(valid).toBeDefined();

    const { writeFile } = await import('node:fs/promises');
    const mutations: Array<[string, unknown]> = [
      ['missing name', { ...valid, name: undefined }],
      ['missing primaryRoot', { ...valid, primaryRoot: undefined }],
      ['non-string createdAt', { ...valid, createdAt: 12345 }],
      ['non-string, non-null engineHead', { ...valid, engineHead: 7 }],
      ['non-string, non-null engineFingerprint', { ...valid, engineFingerprint: {} }],
      ['non-string, non-null patchesFingerprint', { ...valid, patchesFingerprint: {} }],
      ['non-string clonedObjdir', { ...valid, clonedObjdir: 7 }],
      ['not an object', []],
      // A version below 1 or a non-integer is malformed, not "newer".
      ['zero schemaVersion', { ...valid, schemaVersion: 0 }],
      ['non-integer schemaVersion', { ...valid, schemaVersion: 1.5 }],
    ];

    for (const [label, body] of mutations) {
      await writeFile(markerPath, JSON.stringify(body), 'utf-8');
      await expect(tryReadTreeMarker(treeRoot), label).resolves.toBeUndefined();
      // A rejected marker must report as CORRUPT, not absent: the guard grants
      // the full mutating command set on 'absent'.
      await expect(readTreeMarker(treeRoot), label).resolves.toMatchObject({
        kind: 'corrupt',
      });
    }

    // A marker from a NEWER FireForge is reported as `unsupported`, not
    // `corrupt`. The distinction is load-bearing: tree-guard is default-deny
    // on corrupt and offers "recreate the tree / delete the stray marker",
    // which is destructive advice for a file that is merely newer and would
    // have locked the operator out of their own tree.
    await writeFile(markerPath, JSON.stringify({ ...valid, schemaVersion: 2 }), 'utf-8');
    const newer = await readTreeMarker(treeRoot);
    expect(newer.kind).toBe('unsupported');
    expect(newer.kind === 'unsupported' ? newer.reason : '').toContain('newer FireForge');
    expect(newer.kind === 'unsupported' ? newer.reason : '').toContain('do not delete');

    // Explicit nulls remain legal for the two nullable fields.
    await writeFile(
      markerPath,
      JSON.stringify({ ...valid, engineHead: null, patchesFingerprint: null }),
      'utf-8'
    );
    await expect(tryReadTreeMarker(treeRoot)).resolves.toMatchObject({ engineHead: null });

    // A string clonedObjdir is the legal shape of the optional field.
    await writeFile(markerPath, JSON.stringify({ ...valid, clonedObjdir: 'obj-x86_64' }), 'utf-8');
    await expect(tryReadTreeMarker(treeRoot)).resolves.toMatchObject({
      clonedObjdir: 'obj-x86_64',
    });
  });

  it('returns undefined for an unreadable marker rather than throwing', async () => {
    const treeRoot = await createTestTree('shard-a');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(treeRoot, '.fireforge', 'tree.json'), '{ not json', 'utf-8');
    await expect(tryReadTreeMarker(treeRoot)).resolves.toBeUndefined();
    await expect(readTreeMarker(treeRoot)).resolves.toMatchObject({ kind: 'corrupt' });
  });

  // POSIX mode bits are the refusal mechanism here. NTFS ignores
  // `chmod`, so this cannot be ported to Windows, only skipped honestly.
  it.skipIf(process.platform === 'win32')(
    'distinguishes an absent marker from an unreadable one',
    async () => {
      const bareRoot = await createTempProject('ff-tree-nomarker-');
      try {
        await expect(readTreeMarker(bareRoot)).resolves.toEqual({ kind: 'absent' });
      } finally {
        await removeTempProject(bareRoot);
      }
    }
  );

  // chmod 0o000 bars neither root (some CI containers) nor Windows, which
  // ignores POSIX mode bits outright. The directory stays readable and the
  // marker parses, so there is no EACCES to assert on.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an inaccessible .fireforge directory as corrupt, not absent',
    async () => {
      // An EACCES probing the marker is not evidence that there is no marker:
      // reporting `absent` here handed a real tree the full mutating command
      // set whenever its .fireforge directory lost read permission.
      const treeRoot = await createTestTree('shard-a');
      const stateDir = join(treeRoot, '.fireforge');
      const { chmod } = await import('node:fs/promises');
      await chmod(stateDir, 0o000);
      try {
        await expect(readTreeMarker(treeRoot)).resolves.toMatchObject({ kind: 'corrupt' });
      } finally {
        await chmod(stateDir, 0o755);
      }
    }
  );

  it('reports a root whose .fireforge is a regular file as absent', async () => {
    const bareRoot = await createTempProject('ff-tree-notdir-');
    try {
      await writeFile(join(bareRoot, '.fireforge'), 'not a directory\n');
      await expect(readTreeMarker(bareRoot)).resolves.toEqual({ kind: 'absent' });
    } finally {
      await removeTempProject(bareRoot);
    }
  });

  it('removeTree refuses a lock directory whose owner cannot be identified', async () => {
    // `withFileLock` takes the lock by creating the directory and only then
    // writes the owner record, treating a write failure as non-fatal, so a
    // lock dir with no readable pid is a state a live holder produces. Reading
    // it as "not held" recursively deleted the tree out from under a build.
    const treeRoot = await createTestTree('shard-a');
    const lockDir = join(treeRoot, '.fireforge-build.lock');
    await mkdir(lockDir, { recursive: true });

    await expect(removeTree(projectRoot, 'shard-a')).rejects.toThrow(
      /owner record is missing or unreadable/
    );
    await expect(pathExists(treeRoot)).resolves.toBe(true);

    // A pid file that exists but names no process is equally unknown.
    await writeFile(join(lockDir, 'pid'), 'not-a-pid\ntoken\n');
    await expect(removeTree(projectRoot, 'shard-a')).rejects.toThrow(/does not name a process id/);
    await expect(pathExists(treeRoot)).resolves.toBe(true);

    // --force is the documented escape once the user has confirmed no build is running.
    await removeTree(projectRoot, 'shard-a', { force: true });
    await expect(pathExists(treeRoot)).resolves.toBe(false);
  });

  it('assertObjdirMatchesTreeMarker refuses an objdir the marker never vouched for', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-x86_64');
    const treeRoot = await createTestTree('shard-check', {
      withObjdir: { objDir: 'obj-x86_64' },
    });

    // The vouched-for objdir passes. A foreign one and "none found" refuse.
    await expect(assertObjdirMatchesTreeMarker(treeRoot, 'obj-x86_64')).resolves.toBeUndefined();
    await expect(assertObjdirMatchesTreeMarker(treeRoot, 'obj-other')).rejects.toThrow(
      /records "obj-x86_64".*"obj-other"/s
    );
    await expect(assertObjdirMatchesTreeMarker(treeRoot, undefined)).rejects.toThrow(
      /records "obj-x86_64".*no objdir/s
    );
  });

  it('assertObjdirMatchesTreeMarker is a no-op outside trees and in objdir-less trees', async () => {
    // Primary root: no marker at all.
    await expect(assertObjdirMatchesTreeMarker(projectRoot, 'obj-x86_64')).resolves.toBeUndefined();
    // A tree without --with-objdir records no clonedObjdir to cross-check
    // (the guard already refuses build-less test there).
    const treeRoot = await createTestTree('shard-plain-check');
    await expect(assertObjdirMatchesTreeMarker(treeRoot, 'obj-x86_64')).resolves.toBeUndefined();
  });
});
