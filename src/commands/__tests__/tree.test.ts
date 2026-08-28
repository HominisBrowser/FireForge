// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit coverage for the `fireforge tree` refusal branches that the
 * integration suite cannot reach on a real filesystem: the no-CoW
 * honest refusal (a mac/btrfs dev host always probes positive) and the
 * Windows platform gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

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
  getTreeMarkerPath: vi.fn((root: string) => `${root}/.fireforge/tree.json`),
  tryReadTreeMarker: vi.fn(() => Promise.resolve(undefined)),
  readTreeMarker: vi.fn(() => Promise.resolve({ kind: 'absent' as const })),
  removeTree: vi.fn(() => Promise.resolve()),
  withTreeLifecycleLock: vi.fn((_root: string, op: () => Promise<unknown>) => op()),
}));

vi.mock('../../core/engine-session-lock.js', () => ({
  // vi.fn records all call args (including the options object the waitLock
  // cases assert on) regardless of this implementation's arity.
  withEngineSessionLock: vi.fn((_root: string, _cmd: string, op: () => Promise<unknown>) => op()),
}));

// `--with-objdir` probes the primary build and holds the build lock; the
// probe result is driven per test, the lock is pass-through so its
// acquisition (or absence) is observable. `runMach` backs the in-tree
// reconfigure closure threaded into cloneTree.
vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-x86_64' })),
  runMach: vi.fn(() => Promise.resolve(0)),
  withBuildLock: vi.fn((_root: string, op: () => Promise<unknown>) => op()),
}));

// The post-configure relocation check reads real objdir metadata; these
// unit tests drive the reconfigure closure against fake paths, so it is
// stubbed clean by default and per-test for the violation case. The real
// checker is covered by mach-objdir-relocation.test.ts and the
// tree.integration.test.ts failure cases.
vi.mock('../../core/mach-build-artifacts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/mach-build-artifacts.js')>()),
  findObjdirRelocationViolation: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
}));

// `tree exec` spawns a real child with `stdio: 'inherit'`; a fake emitter lets
// the tests drive its exit/error paths.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import { hasBuildArtifacts, runMach, withBuildLock } from '../../core/mach.js';
import { findObjdirRelocationViolation } from '../../core/mach-build-artifacts.js';
import { detectCowSupport } from '../../core/tree-cow.js';
import {
  cloneTree,
  computePrimaryFingerprint,
  getTreesDir,
  listTrees,
  readTreeMarker,
  removeTree,
} from '../../core/tree-store.js';
import { info, setStdoutSealed, success, warn } from '../../utils/logger.js';
import { registerTree, treeCreateCommand, treeListCommand, treeRemoveCommand } from '../tree.js';

// `tree create`, `tree remove` and `tree exec` refuse outright on Windows
// (`assertPosix` in ../tree.ts) because copy-on-write cloning needs
// clonefile/reflink. Their suites cannot run there; the refusal itself is
// pinned by the platform-stubbed suite at the end of this file, so skipping
// costs no coverage. `treeListCommand` carries no such guard and still runs.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('tree create CoW gating', () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'ff-tree-unit-'));
    vi.mocked(getTreesDir).mockImplementation((primary: string) =>
      join(primary, '.fireforge', 'trees')
    );
    // mockResolvedValue overrides outlive clearAllMocks — pin the defaults.
    vi.mocked(readTreeMarker).mockResolvedValue({ kind: 'absent' });
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-x86_64' });
    vi.mocked(cloneTree).mockResolvedValue({
      schemaVersion: 1,
      name: 'x',
      primaryRoot: '/p',
      createdAt: 'now',
      engineHead: null,
      patchesFingerprint: null,
    });
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

  it('refuses to nest under a marker that exists but cannot be parsed', async () => {
    // An unparseable marker still means "something claims this is a tree";
    // reading it as absent would clone a snapshot into itself.
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    vi.mocked(readTreeMarker).mockResolvedValue({
      kind: 'corrupt',
      reason: 'the marker could not be read (Unexpected end of JSON input)',
    });

    await expect(treeCreateCommand(root, 'shard-a')).rejects.toThrow(
      /claims this directory is a verification tree/
    );
    expect(cloneTree).not.toHaveBeenCalled();
  });

  it('refuses to nest under a valid marker', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    vi.mocked(readTreeMarker).mockResolvedValue({ kind: 'valid', marker: MARKER });

    await expect(treeCreateCommand(root, 'shard-a')).rejects.toThrow(/cannot be nested/);
    expect(cloneTree).not.toHaveBeenCalled();
  });

  it('--with-objdir threads the probed objdir into cloneTree under the primary build lock', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');

    await treeCreateCommand(root, 'shard-a', { withObjdir: true });

    expect(withBuildLock).toHaveBeenCalledWith(root, expect.any(Function));
    const cloneArgs = vi.mocked(cloneTree).mock.calls[0]?.[0];
    expect(cloneArgs?.withObjdir?.objDir).toBe('obj-x86_64');
    expect(typeof cloneArgs?.withObjdir?.reconfigure).toBe('function');
  });

  it('--with-objdir re-resolves the objdir UNDER the build lock, and that result wins', async () => {
    // The pre-lock probe is a fast-fail courtesy; a build finishing between
    // it and the lock acquisition must not let a stale objdir be cloned.
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    const events: string[] = [];
    vi.mocked(hasBuildArtifacts).mockImplementation(() => {
      events.push('probe');
      return Promise.resolve(
        events.filter((e) => e === 'probe').length === 1
          ? { exists: true, objDir: 'obj-old' }
          : { exists: true, objDir: 'obj-new' }
      );
    });
    vi.mocked(withBuildLock).mockImplementation((_root, op) => {
      events.push('lock');
      return op();
    });
    vi.mocked(cloneTree).mockImplementation(() => {
      events.push('clone');
      return Promise.resolve({ ...MARKER, clonedObjdir: 'obj-new' });
    });

    await treeCreateCommand(root, 'shard-a', { withObjdir: true });

    expect(events).toEqual(['probe', 'lock', 'probe', 'clone']);
    const cloneArgs = vi.mocked(cloneTree).mock.calls[0]?.[0];
    expect(cloneArgs?.withObjdir?.objDir).toBe('obj-new');
  });

  it('--with-objdir refuses under the lock when the build disappeared after the courtesy probe', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    vi.mocked(hasBuildArtifacts)
      .mockResolvedValueOnce({ exists: true, objDir: 'obj-x86_64' })
      .mockResolvedValueOnce({ exists: false });

    await expect(treeCreateCommand(root, 'shard-a', { withObjdir: true })).rejects.toThrow(
      /requires a completed primary build/
    );
    expect(withBuildLock).toHaveBeenCalled();
    expect(cloneTree).not.toHaveBeenCalled();
  });

  it('the reconfigure closure runs mach configure in the tree and fails closed on a non-zero exit', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');

    await treeCreateCommand(root, 'shard-a', { withObjdir: true });

    const cloneArgs = vi.mocked(cloneTree).mock.calls[0]?.[0];
    const reconfigure = cloneArgs?.withObjdir?.reconfigure;
    expect(reconfigure).toBeDefined();

    await expect(reconfigure?.('/tree/engine')).resolves.toBeUndefined();
    expect(runMach).toHaveBeenCalledWith(['configure'], '/tree/engine');
    // The postcondition check receives the tree engine, the objdir the
    // clone kept, and the primary engine as the forbidden path.
    expect(findObjdirRelocationViolation).toHaveBeenCalledWith({
      engineDir: '/tree/engine',
      objDir: 'obj-x86_64',
      forbiddenDir: join(root, 'engine'),
    });

    vi.mocked(runMach).mockResolvedValueOnce(2);
    await expect(reconfigure?.('/tree/engine')).rejects.toThrow(
      /mach configure exited non-zero \(2\) in the cloned tree/
    );

    vi.mocked(runMach).mockRejectedValueOnce(new Error('mach missing'));
    await expect(reconfigure?.('/tree/engine')).rejects.toThrow(
      /mach configure failed in the cloned tree/
    );

    // Exit 0 with a failed postcondition is NOT trusted.
    vi.mocked(findObjdirRelocationViolation).mockResolvedValueOnce(
      'obj-x86_64/config.status still contains the primary engine path /primary/engine'
    );
    await expect(reconfigure?.('/tree/engine')).rejects.toThrow(
      /exited 0 in the cloned tree but did not relocate the objdir: obj-x86_64\/config\.status still contains/
    );
  });

  it('a plain create never touches the build lock and passes no objdir', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');

    await treeCreateCommand(root, 'shard-a');

    expect(withBuildLock).not.toHaveBeenCalled();
    expect(hasBuildArtifacts).not.toHaveBeenCalled();
    const cloneArgs = vi.mocked(cloneTree).mock.calls[0]?.[0];
    expect(cloneArgs).toBeDefined();
    expect(cloneArgs?.withObjdir).toBeUndefined();
  });

  it('an objdir-less create pays no mach configure and no venv rebootstrap', async () => {
    // The consumer asked whether a gate paying tree machinery twice could
    // skip configure/venv work on the objdir-less verify tree. It already
    // does: `mach configure` and the `_virtualenvs` scrub live behind the
    // reconfigure closure, which only `--with-objdir` supplies. No closure
    // is passed here, so there is nothing to skip.
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');

    await treeCreateCommand(root, 'shard-a');

    expect(runMach).not.toHaveBeenCalled();
    expect(vi.mocked(cloneTree).mock.calls[0]?.[0]?.withObjdir).toBeUndefined();
  });

  it('--with-objdir refuses before cloning when the primary has no completed build', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: false });

    await expect(treeCreateCommand(root, 'shard-a', { withObjdir: true })).rejects.toThrow(
      /requires a completed primary build/
    );
    expect(cloneTree).not.toHaveBeenCalled();
  });

  it('--with-objdir refuses an ambiguous multi-objdir primary', async () => {
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: true,
      ambiguous: true,
      objDirs: ['obj-a', 'obj-b'],
    });

    await expect(treeCreateCommand(root, 'shard-a', { withObjdir: true })).rejects.toThrow(
      /Multiple build artifact directories/
    );
    expect(cloneTree).not.toHaveBeenCalled();
  });

  it('a failed clone removes the partial tree and rethrows', async () => {
    // A cloneTree failure must not leak the partial tree, or the next create
    // trips the "already exists" refusal on debris.
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    const treeRoot = join(root, '.fireforge', 'trees', 'shard-a');
    vi.mocked(cloneTree).mockImplementation(async () => {
      await mkdir(treeRoot, { recursive: true });
      throw new Error('mid-clone failure');
    });

    await expect(treeCreateCommand(root, 'shard-a')).rejects.toThrow(/mid-clone failure/);
    expect(existsSync(treeRoot)).toBe(false);
  });
});

const MARKER = {
  schemaVersion: 1 as const,
  name: 'shard-a',
  primaryRoot: '/p',
  createdAt: '2026-08-07T00:00:00.000Z',
  engineHead: 'aaa',
  patchesFingerprint: 'bbb',
};

/** Builds a program with the tree group registered and errors passed through. */
function treeProgram(projectRoot: string): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerTree(program, {
    getProjectRoot: () => projectRoot,
    withErrorHandling: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
  });
  return program;
}

/**
 * Fake child process whose exit/error can be driven from the test.
 *
 * Returned from `mockImplementation`, never `mockReturnValue`: the emit is
 * scheduled when the child is constructed, so building it eagerly would fire
 * before `treeExecCommand` attaches its listeners and the promise would hang.
 */
function fakeChild(outcome: { code?: number | null; error?: Error }): EventEmitter {
  const child = new EventEmitter();
  setImmediate(() => {
    if (outcome.error) child.emit('error', outcome.error);
    else child.emit('exit', outcome.code === undefined ? 0 : outcome.code);
  });
  return child;
}

describePosix('tree create --wait-lock', () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'ff-tree-waitlock-'));
    vi.mocked(getTreesDir).mockImplementation((primary: string) =>
      join(primary, '.fireforge', 'trees')
    );
    vi.mocked(readTreeMarker).mockResolvedValue({ kind: 'absent' });
    vi.mocked(detectCowSupport).mockResolvedValue('clonefile');
    vi.mocked(cloneTree).mockResolvedValue(MARKER);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createTree(...flags: string[]): Promise<void> {
    await treeProgram(root).parseAsync(['node', 'ff', 'tree', 'create', 'shard-a', ...flags]);
  }

  it('threads --wait-lock <seconds> into the engine session lock wait budget', async () => {
    // The lock refusal recommends --wait-lock, so the flag must be
    // registered on tree create — otherwise commander throws
    // `unknown option`.
    await createTree('--wait-lock', '120');

    expect(withEngineSessionLock).toHaveBeenCalledWith(root, 'tree create', expect.any(Function), {
      waitLockSeconds: 120,
    });
  });

  it('maps a bare --wait-lock to the 60-second default budget', async () => {
    await createTree('--wait-lock');

    expect(withEngineSessionLock).toHaveBeenCalledWith(root, 'tree create', expect.any(Function), {
      waitLockSeconds: 60,
    });
  });

  it('keeps the ~1s fail-fast when the flag is absent', async () => {
    await createTree();

    expect(withEngineSessionLock).toHaveBeenCalledWith(root, 'tree create', expect.any(Function), {
      waitLockSeconds: undefined,
    });
  });

  it('rejects out-of-range --wait-lock values through commander', async () => {
    await expect(createTree('--wait-lock', '0')).rejects.toThrow(
      '--wait-lock must be an integer in 1..3600 (got "0")'
    );
    expect(cloneTree).not.toHaveBeenCalled();
  });
});

describe('treeListCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the empty case with a create hint', async () => {
    vi.mocked(listTrees).mockResolvedValue([]);
    await treeListCommand('/p');
    expect(info).toHaveBeenCalledWith(
      'No verification trees. Create one with: fireforge tree create <name>'
    );
  });

  it('prints one row per tree with its staleness verdict', async () => {
    vi.mocked(listTrees).mockResolvedValue([
      { name: 'shard-a', path: '/p/a', createdAt: 'then', staleness: 'fresh' },
    ]);
    await treeListCommand('/p');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('shard-a'));
  });

  it('emits machine-readable JSON without the human framing', async () => {
    vi.mocked(listTrees).mockResolvedValue([]);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await treeListCommand('/p', { json: true });
      expect(write).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    } finally {
      write.mockRestore();
    }
    expect(info).not.toHaveBeenCalled();
  });
});

describePosix('tree remove --all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports when there is nothing to remove', async () => {
    vi.mocked(listTrees).mockResolvedValue([]);
    await treeProgram('/p').parseAsync(['node', 'ff', 'tree', 'remove', '--all']);
    expect(info).toHaveBeenCalledWith('No verification trees to remove.');
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('removes every tree it finds', async () => {
    vi.mocked(listTrees).mockResolvedValue([
      { name: 'a', path: '/p/a', createdAt: 't', staleness: 'fresh' },
      { name: 'b', path: '/p/b', createdAt: 't', staleness: 'fresh' },
    ]);
    await treeProgram('/p').parseAsync(['node', 'ff', 'tree', 'remove', '--all']);
    expect(removeTree).toHaveBeenCalledWith('/p', 'a', { force: false });
    expect(removeTree).toHaveBeenCalledWith('/p', 'b', { force: false });
    expect(success).toHaveBeenCalledTimes(2);
  });

  it('forwards --force to removeTree so the unknown-lock-owner refusal can be overridden', async () => {
    vi.mocked(listTrees).mockResolvedValue([]);
    await treeProgram('/p').parseAsync(['node', 'ff', 'tree', 'remove', 'a', '--force']);
    expect(removeTree).toHaveBeenCalledWith('/p', 'a', { force: true });
  });
});

describePosix('tree exec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readTreeMarker).mockResolvedValue({ kind: 'valid', marker: MARKER });
    vi.mocked(computePrimaryFingerprint).mockResolvedValue({
      engineHead: 'aaa',
      patchesFingerprint: 'bbb',
    });
    vi.mocked(spawn).mockImplementation(() => fakeChild({ code: 0 }) as never);
  });

  async function exec(...args: string[]): Promise<void> {
    await treeProgram('/p').parseAsync(['node', 'ff', 'tree', 'exec', 'shard-a', ...args]);
  }

  it('refuses an unknown tree name', async () => {
    vi.mocked(readTreeMarker).mockResolvedValue({ kind: 'absent' });
    await expect(exec('status')).rejects.toThrow(/No verification tree named "shard-a"/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('names the corruption for a tree whose marker cannot be read', async () => {
    // Collapsing corrupt into "no such tree" pointed the operator at the
    // wrong remediation: the directory IS there, claiming to be a tree.
    vi.mocked(readTreeMarker).mockResolvedValue({
      kind: 'corrupt',
      reason: 'its tree marker is not valid JSON',
    });
    await expect(exec('status')).rejects.toThrow(
      /marker could not be read: its tree marker is not valid JSON/
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the CLI with the tree as its working directory', async () => {
    await exec('status');
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['status']),
      expect.objectContaining({ cwd: '/p/.fireforge/trees/shard-a', stdio: 'inherit' })
    );
  });

  it('warns when the primary engine advanced past the snapshot', async () => {
    vi.mocked(computePrimaryFingerprint).mockResolvedValue({
      engineHead: 'zzz',
      patchesFingerprint: 'bbb',
    });
    await exec('status');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('primary engine advanced'));
  });

  it('warns when uncommitted engine content changed without advancing HEAD', async () => {
    vi.mocked(readTreeMarker).mockResolvedValue({
      kind: 'valid',
      marker: { ...MARKER, engineFingerprint: 'engine-before' },
    });
    vi.mocked(computePrimaryFingerprint).mockResolvedValue({
      engineHead: 'aaa',
      engineFingerprint: 'engine-after',
      patchesFingerprint: 'bbb',
    });
    await exec('status');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('engine worktree changed'));
  });

  it('warns when the primary patches changed but the engine did not', async () => {
    vi.mocked(computePrimaryFingerprint).mockResolvedValue({
      engineHead: 'aaa',
      patchesFingerprint: 'zzz',
    });
    await exec('status');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('primary patches changed'));
  });

  it('does not warn for a fresh tree', async () => {
    await exec('status');
    expect(warn).not.toHaveBeenCalled();
  });

  it('propagates a non-zero child exit as a refusal naming the code', async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild({ code: 3 }) as never);
    await expect(exec('lint')).rejects.toThrow(/tree exec: fireforge lint exited with code 3/);
  });

  it('treats a null exit code (signalled child) as failure', async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild({ code: null }) as never);
    await expect(exec('lint')).rejects.toThrow(/exited with code 1/);
  });

  it('surfaces a spawn error', async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild({ error: new Error('ENOENT') }) as never);
    await expect(exec('lint')).rejects.toThrow(/ENOENT/);
  });

  it('seals stdout once the child settles, so a failure refusal cannot print after the verdict', async () => {
    // The child owned stdout via `stdio: 'inherit'` — its FIREFORGE-VERDICT
    // line must stay the run's last stdout write. The parent seals before
    // its own GeneralError renders, routing the refusal to stderr.
    vi.mocked(spawn).mockImplementation(() => fakeChild({ code: 1 }) as never);
    await expect(exec('test')).rejects.toThrow(/exited with code 1/);
    expect(setStdoutSealed).toHaveBeenCalledWith(true);
  });

  it('seals stdout after a successful child too (parent writes nothing more)', async () => {
    await exec('status');
    expect(setStdoutSealed).toHaveBeenCalledWith(true);
  });

  it('seals stdout even when the spawn itself errors after handing over stdio', async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild({ error: new Error('EAGAIN') }) as never);
    await expect(exec('lint')).rejects.toThrow(/EAGAIN/);
    expect(setStdoutSealed).toHaveBeenCalledWith(true);
  });

  it('does NOT seal stdout for pre-spawn refusals (no child ever wrote a verdict)', async () => {
    vi.mocked(readTreeMarker).mockResolvedValue({ kind: 'absent' });
    await expect(exec('status')).rejects.toThrow(/No verification tree/);
    expect(setStdoutSealed).not.toHaveBeenCalled();
  });

  it('refuses when the CLI entry point cannot be resolved', async () => {
    const original = process.argv[1];

    delete (process.argv as unknown as Record<string, unknown>)[1];
    try {
      await expect(exec('status')).rejects.toThrow(/Cannot resolve the fireforge CLI entry point/);
    } finally {
      process.argv[1] = original ?? '';
    }
  });
});

describe('POSIX-only refusals', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  const onWindows = (): void => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  };

  it('refuses tree create on Windows, naming copy-on-write as the reason', async () => {
    onWindows();
    await expect(treeCreateCommand('/primary', 'shard-a')).rejects.toThrow(
      /tree is POSIX-only.*clonefile\/reflink/s
    );
  });

  it('refuses tree remove on Windows', async () => {
    onWindows();
    await expect(treeRemoveCommand('/primary', 'shard-a')).rejects.toThrow(/tree is POSIX-only/);
  });

  it('refuses tree exec on Windows', async () => {
    onWindows();
    await expect(
      treeProgram('/p').parseAsync(['node', 'ff', 'tree', 'exec', 'shard-a', 'status'])
    ).rejects.toThrow(/tree is POSIX-only/);
  });
});
