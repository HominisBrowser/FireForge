// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the ownership-table assembly shared by `status
 * --ownership` and the `--include-ownership` JSON block. The
 * command-level wiring is covered by status.test.ts; what matters here is
 * that the module builds identical rows for both callers and degrades
 * cleanly when the queue directory does not exist yet.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClassifiedFile, StatusFile } from '../../core/status-classify.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import {
  buildOwnershipJsonBlock,
  collectOwnershipRows,
  summarizeOwnership,
} from '../status-ownership.js';

const OWNED = 'browser/base/content/browser.js';
const STRAY = 'browser/base/content/stray.js';

function patch(filename: string, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order: Number(filename.slice(0, 3)),
    category: 'ui',
    name: filename.replace(/^\d+-ui-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-08-11T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

function classified(
  file: string,
  classification: ClassifiedFile['classification']
): ClassifiedFile {
  return { file, status: ' M', classification };
}

describe('collectOwnershipRows', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-status-ownership-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('degrades to filesAffected-only when the patches directory does not exist', async () => {
    // A fresh project with no queue yet must not fail: there are no patch
    // bodies to walk for duplicate-creation conflicts.
    const rows = await collectOwnershipRows(
      join(root, 'patches'),
      [patch('001-ui-a.patch', [OWNED])],
      [],
      []
    );

    expect(rows.map((r) => r.path)).toEqual([OWNED]);
    expect(rows[0]?.owners).toEqual(['001-ui-a.patch']);
    expect(rows[0]?.conflict).toBe(false);
  });

  it('marks a worktree file claimed by nobody as unmanaged', async () => {
    const files: StatusFile[] = [{ status: '??', file: STRAY }];
    const rows = await collectOwnershipRows(
      join(root, 'patches'),
      [patch('001-ui-a.patch', [OWNED])],
      files,
      [classified(STRAY, 'unmanaged')]
    );

    const stray = rows.find((r) => r.path === STRAY);
    expect(stray?.unmanaged).toBe(true);
    expect(stray?.owners).toEqual([]);
  });

  it('flags a filesAffected collision between two patches', async () => {
    const rows = await collectOwnershipRows(
      join(root, 'patches'),
      [patch('001-ui-a.patch', [OWNED]), patch('002-ui-b.patch', [OWNED])],
      [],
      []
    );

    expect(rows[0]?.conflict).toBe(true);
    expect(rows[0]?.conflictReason).toBe('files-affected');
    expect(rows[0]?.owners).toEqual(['001-ui-a.patch', '002-ui-b.patch']);
  });
});

describe('summarizeOwnership / buildOwnershipJsonBlock', () => {
  const rows = [
    {
      path: 'a',
      owners: ['1.patch'],
      conflict: false,
      conflictReason: null,
      unmanaged: false,
      state: 'owned' as const,
    },
    {
      path: 'b',
      owners: [],
      conflict: false,
      conflictReason: null,
      unmanaged: true,
      state: 'unmanaged' as const,
    },
    {
      path: 'c',
      owners: ['1.patch', '2.patch'],
      conflict: true,
      conflictReason: 'files-affected' as const,
      unmanaged: false,
      state: 'conflict' as const,
    },
  ];

  it('counts managed, unmanaged, and conflicted rows independently', () => {
    // A conflicted row is still managed — it has owners, just too many.
    expect(summarizeOwnership(rows)).toEqual({ managed: 2, unmanaged: 1, conflicts: 1 });
  });

  it('carries the rows verbatim into the JSON block', () => {
    const block = buildOwnershipJsonBlock([...rows]);
    expect(block.rows).toEqual(rows);
    expect(block.summary.conflicts).toBe(1);
  });
});
