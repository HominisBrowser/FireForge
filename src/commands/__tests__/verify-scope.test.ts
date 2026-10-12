// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { OwnershipRow } from '../../core/ownership-table.js';
import type { ClassifiedFile } from '../../core/status-classify.js';
import type { PatchLintIssue } from '../../types/commands/index.js';
import { ownershipConflictPaths, scopeClassified, scopeOwnershipRows } from '../status-scope.js';
import {
  anyPatchInScope,
  isFilenameInScope,
  scopeLintIssues,
  scopePatches,
  type VerifyScope,
} from '../verify-scope.js';

const scope: VerifyScope = {
  patches: new Set(['201-ui-a.patch']),
  files: new Set(['a.js']),
};

const lintIssue = (file: string, patches?: string[]): PatchLintIssue => ({
  file,
  check: 'x',
  message: 'm',
  severity: 'error',
  ...(patches ? { patches } : {}),
});

describe('verify scope', () => {
  it('keeps everything without a scope', () => {
    expect(isFilenameInScope(undefined, '999-ui-x.patch')).toBe(true);
    expect(anyPatchInScope(undefined, [])).toBe(true);
    const issues = [lintIssue('z.js')];
    expect(scopeLintIssues(issues, undefined)).toBe(issues);
    expect(scopePatches([{ filename: 'b' }], undefined)).toEqual([{ filename: 'b' }]);
  });

  it('keeps queue-wide findings and drops unscoped patches', () => {
    expect(isFilenameInScope(scope, 'patches.json')).toBe(true);
    expect(isFilenameInScope(scope, '201-ui-a.patch')).toBe(true);
    expect(isFilenameInScope(scope, '402-ui-peer.patch')).toBe(false);
  });

  it('attributes lint issues by their patches, else by their file', () => {
    expect(
      scopeLintIssues(
        [
          lintIssue('q.js', ['201-ui-a.patch', '300-ui-b.patch']),
          lintIssue('a.js', ['402-ui-peer.patch']),
          lintIssue('a.js'),
          lintIssue('z.js'),
        ],
        scope
      ).map((issue) => `${issue.file}:${issue.patches?.join('+') ?? '-'}`)
    ).toEqual(['q.js:201-ui-a.patch+300-ui-b.patch', 'a.js:-']);
  });

  it('keeps only scoped manifest rows', () => {
    expect(
      scopePatches([{ filename: '201-ui-a.patch' }, { filename: '402-ui-peer.patch' }], scope)
    ).toEqual([{ filename: '201-ui-a.patch' }]);
  });
});

describe('status scope', () => {
  const classified: ClassifiedFile[] = [
    { file: 'a.js', status: ' M', classification: 'patch-owned-drift', owner: '201-ui-a.patch' },
    { file: 'b.js', status: ' M', classification: 'conflict', claimedBy: ['201-ui-a.patch', 'x'] },
    { file: 'c.js', status: '??', classification: 'unmanaged' },
    { file: 'd.js', status: ' M', classification: 'patch-backed', owner: 'peer.patch' },
  ];
  const statusScope = { patches: ['201-ui-a.patch'] };

  it('keeps owned and claimed files, dropping unmanaged and peer files', () => {
    expect(scopeClassified(classified, statusScope).map((entry) => entry.file)).toEqual([
      'a.js',
      'b.js',
    ]);
    expect(scopeClassified(classified, undefined)).toBe(classified);
  });

  it('keeps ownership rows naming a scoped patch, and lists conflicts', () => {
    const row = (path: string, owners: string[], conflict = false): OwnershipRow => ({
      path,
      owners,
      conflict,
      conflictReason: conflict ? 'files-affected' : null,
      unmanaged: owners.length === 0,
      state: conflict ? 'conflict' : 'owned',
    });
    const rows = [
      row('a.js', ['201-ui-a.patch']),
      row('b.js', ['201-ui-a.patch', 'x'], true),
      row('c.js', []),
      row('d.js', ['peer.patch', 'x'], true),
    ];
    const scoped = scopeOwnershipRows(rows, statusScope);
    expect(scoped.map((entry) => entry.path)).toEqual(['a.js', 'b.js']);
    expect(ownershipConflictPaths(scoped)).toEqual(['b.js']);
    expect(ownershipConflictPaths(scopeOwnershipRows(rows, undefined))).toEqual(['b.js', 'd.js']);
  });
});
