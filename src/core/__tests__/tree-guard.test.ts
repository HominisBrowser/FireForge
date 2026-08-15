// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMAND_MANIFEST } from '../../commands/manifest.js';
import { enforceTreeGuard, runTreeGuardHook, TREE_COMMAND_VERDICTS } from '../tree-guard.js';
import type { TreeMarker } from '../tree-store.js';

const MARKER: TreeMarker = {
  schemaVersion: 1,
  name: 'shard-a',
  primaryRoot: '/primary',
  createdAt: '2026-08-06T00:00:00.000Z',
  engineHead: 'abc',
  patchesFingerprint: 'def',
};

function verdictOf(
  command: string,
  subcommands: string[] = [],
  options = {},
  args: unknown[] = []
) {
  return () => {
    enforceTreeGuard(MARKER, command, { subcommands, options, args });
  };
}

describe('tree guard verdict table (FORGE G15)', () => {
  it('classifies EVERY manifest command explicitly (drift gate: new commands default-deny until classified)', () => {
    const unclassified = COMMAND_MANIFEST.map((entry) => entry.name).filter(
      (name) => TREE_COMMAND_VERDICTS[name] === undefined
    );
    expect(unclassified).toEqual([]);
  });

  it('allows the read-verification set', () => {
    for (const command of ['status', 'lint', 'typecheck', 'verify']) {
      expect(verdictOf(command), command).not.toThrow();
    }
  });

  it('refuses mutating commands with a message naming the tree and the allowed set', () => {
    expect(verdictOf('export')).toThrow(/verification tree \("shard-a", created from \/primary\)/);
    expect(verdictOf('patch', ['move-files'])).toThrow(/must run in the primary tree/);
    expect(verdictOf('patch', ['staged-dependency'])).toThrow(/patch staged-dependency/);
    expect(verdictOf('token', ['add'])).toThrow(/Verification trees support:/);
    expect(verdictOf('build')).toThrow(GeneralErrorMatcher);
    expect(verdictOf('run')).toThrow(GeneralErrorMatcher);
  });

  it('test is refused in an objdir-less tree, naming --with-objdir as the remedy', () => {
    expect(verdictOf('test')).toThrow(GeneralErrorMatcher);
    expect(verdictOf('test')).toThrow(/--with-objdir/);
  });

  it('test runs build-less in a tree whose marker records a cloned objdir; --build stays refused', () => {
    const markerWithObjdir: TreeMarker = { ...MARKER, clonedObjdir: 'obj-x86_64' };
    expect(() => {
      enforceTreeGuard(markerWithObjdir, 'test', { subcommands: [], options: {}, args: [] });
    }).not.toThrow();
    expect(() => {
      enforceTreeGuard(markerWithObjdir, 'test', {
        subcommands: [],
        options: { build: true },
        args: [],
      });
    }).toThrow(/"test --build" rebuilds the engine and must run in the primary tree/);
  });

  it('export and export-all are allowed only with --dry-run', () => {
    expect(verdictOf('export', [], { dryRun: true })).not.toThrow();
    expect(verdictOf('export-all', [], { dryRun: true })).not.toThrow();
    expect(verdictOf('export', [], {})).toThrow(/must run in the primary tree/);
    expect(verdictOf('export-all', [], { dryRun: false })).toThrow(/must run in the primary tree/);
  });

  it('re-export is allowed only with --dry-run (FORGE H3, gated on the H1 purity proof)', () => {
    expect(verdictOf('re-export', [], { dryRun: true })).not.toThrow();
    expect(verdictOf('re-export', [], {})).toThrow(/must run in the primary tree/);
    expect(verdictOf('re-export', [], { dryRun: false })).toThrow(/must run in the primary tree/);
  });

  it('config reads pass, config writes refuse', () => {
    expect(verdictOf('config', [], {}, ['binaryName'])).not.toThrow();
    expect(verdictOf('config', [], {}, ['binaryName', 'newvalue'])).toThrow(
      /must run in the primary tree/
    );
  });

  it('doctor passes read-only and refuses repair flags', () => {
    expect(verdictOf('doctor', [], {})).not.toThrow();
    expect(verdictOf('doctor', [], { repairFurnace: true })).toThrow(
      /must run in the primary tree/
    );
    expect(verdictOf('doctor', [], { fix: true })).toThrow(/must run in the primary tree/);
  });

  it('tree list is allowed inside a tree; lifecycle and nesting are refused', () => {
    expect(verdictOf('tree', ['list'])).not.toThrow();
    expect(verdictOf('tree', ['create'])).toThrow(/must run in the primary tree/);
    expect(verdictOf('tree', ['remove'])).toThrow(/must run in the primary tree/);
    expect(verdictOf('tree', ['exec'])).toThrow(/must run in the primary tree/);
  });

  it('an UNKNOWN command name is refused (default-deny)', () => {
    expect(verdictOf('brand-new-command')).toThrow(/must run in the primary tree/);
  });
});

const GeneralErrorMatcher = /must run in the primary tree/;

describe('tree guard hook: unreadable markers fail closed', () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    cwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), 'ff-guard-hook-'));
    await mkdir(join(root, '.fireforge'), { recursive: true });
    await writeFile(join(root, 'fireforge.json'), '{}', 'utf-8');
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  /** Minimal commander-shaped action command for the hook. */
  function actionCommand(
    name: string,
    options: Record<string, unknown> = {}
  ): Parameters<typeof runTreeGuardHook>[1] {
    return {
      name: () => name,
      optsWithGlobals: () => options,
      args: [] as unknown[],
      parent: { name: () => 'fireforge', parent: null },
    };
  }

  it('refuses a mutating command when the marker exists but does not parse', async () => {
    // Dropping ONE field was enough to make the marker read as "not a tree",
    // which allowed `reset` to run against the snapshot.
    await writeFile(
      join(root, '.fireforge', 'tree.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'shard-a',
        primaryRoot: '/primary',
        engineHead: null,
        patchesFingerprint: null,
      }),
      'utf-8'
    );

    await expect(runTreeGuardHook('fireforge', actionCommand('reset'))).rejects.toThrow(
      /identifies this directory as a FireForge verification tree/
    );
  });

  it('refuses when the marker is not valid JSON', async () => {
    await writeFile(join(root, '.fireforge', 'tree.json'), '{ truncated', 'utf-8');
    await expect(runTreeGuardHook('fireforge', actionCommand('discard'))).rejects.toThrow(
      /could not be read/
    );
  });

  it('--ignore-corrupt-tree-marker is the documented escape', async () => {
    await writeFile(join(root, '.fireforge', 'tree.json'), '{ truncated', 'utf-8');
    await expect(
      runTreeGuardHook('fireforge', actionCommand('reset', { ignoreCorruptTreeMarker: true }))
    ).resolves.toBeUndefined();
  });

  it('no marker at all still means "not a tree"', async () => {
    await expect(runTreeGuardHook('fireforge', actionCommand('reset'))).resolves.toBeUndefined();
  });

  it('lets unconditionally-allowed read-only commands run under a corrupt marker', async () => {
    // An 'allowed' verdict never consults marker fields, so an unreadable
    // marker cannot change its answer — and blocking it left the operator
    // unable to even run `status` on the tree they need to diagnose.
    await writeFile(join(root, '.fireforge', 'tree.json'), '{ truncated', 'utf-8');
    await expect(runTreeGuardHook('fireforge', actionCommand('status'))).resolves.toBeUndefined();
    // 'conditional' verdicts can write; they stay behind the refusal.
    await expect(runTreeGuardHook('fireforge', actionCommand('doctor'))).rejects.toThrow(
      /could not be read/
    );
  });

  it('keeps test refused under a corrupt marker even when the garbage claims a cloned objdir', async () => {
    // `test` is 'conditional' and its predicate reads marker.clonedObjdir — a
    // marker we could not validate must never satisfy it.
    await writeFile(
      join(root, '.fireforge', 'tree.json'),
      '{ "clonedObjdir": "obj-x86_64", truncated',
      'utf-8'
    );
    await expect(runTreeGuardHook('fireforge', actionCommand('test'))).rejects.toThrow(
      /could not be read/
    );
  });
});
