// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { COMMAND_MANIFEST } from '../../commands/manifest.js';
import { enforceTreeGuard, TREE_COMMAND_VERDICTS } from '../tree-guard.js';
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
    expect(verdictOf('re-export')).toThrow(/must run in the primary tree/);
    expect(verdictOf('patch', ['staged-dependency'])).toThrow(/patch staged-dependency/);
    expect(verdictOf('token', ['add'])).toThrow(/Verification trees support:/);
    expect(verdictOf('build')).toThrow(GeneralErrorMatcher);
    expect(verdictOf('test')).toThrow(GeneralErrorMatcher);
    expect(verdictOf('run')).toThrow(GeneralErrorMatcher);
  });

  it('export and export-all are allowed only with --dry-run', () => {
    expect(verdictOf('export', [], { dryRun: true })).not.toThrow();
    expect(verdictOf('export-all', [], { dryRun: true })).not.toThrow();
    expect(verdictOf('export', [], {})).toThrow(/must run in the primary tree/);
    expect(verdictOf('export-all', [], { dryRun: false })).toThrow(/must run in the primary tree/);
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
