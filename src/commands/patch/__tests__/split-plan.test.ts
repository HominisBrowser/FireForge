// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit coverage for the pure `patch split` planning helpers — staged
 * forward-import merge/rewrite and the human summary — exercised directly so
 * each branch is hit without driving the whole command (the integration test
 * covers the end-to-end transaction).
 */

import { describe, expect, it } from 'vitest';

import type { PatchMetadata, PatchStagedForwardImport } from '../../../types/commands/index.js';
import type { PlacementPlan } from '../../export-flow.js';
import {
  buildSplitSummary,
  mergeStagedForwardImports,
  rewriteSplitOwners,
  type SplitPlan,
} from '../split-plan.js';

function makePatch(filename: string, overrides: Partial<PatchMetadata> = {}): PatchMetadata {
  return {
    filename,
    order: 1,
    category: 'infra',
    name: 'p',
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
    ...overrides,
  };
}

const DECL: PatchStagedForwardImport = {
  file: 'a/Importer.sys.mjs',
  specifier: 'resource:///modules/Helper.sys.mjs',
  creates: 'a/Helper.sys.mjs',
  owner: '002-new.patch',
};

describe('mergeStagedForwardImports', () => {
  it('returns the patch unchanged when there are no declarations to add', () => {
    const patch = makePatch('001.patch');
    expect(mergeStagedForwardImports(patch, [])).toBe(patch);
  });

  it('adds a declaration to a patch that has none', () => {
    const merged = mergeStagedForwardImports(makePatch('001.patch'), [DECL]);
    expect(merged.stagedDependencies?.forwardImports).toEqual([DECL]);
  });

  it('does not duplicate a declaration that is already present', () => {
    const patch = makePatch('001.patch', {
      stagedDependencies: { forwardImports: [DECL] },
    });
    const merged = mergeStagedForwardImports(patch, [{ ...DECL }]);
    expect(merged.stagedDependencies?.forwardImports).toHaveLength(1);
  });

  it('treats a missing owner as equal to an empty owner for de-dup', () => {
    const noOwner: PatchStagedForwardImport = {
      file: 'a/I.sys.mjs',
      specifier: 'x',
      creates: 'a/H.sys.mjs',
    };
    const patch = makePatch('001.patch', {
      stagedDependencies: { forwardImports: [noOwner] },
    });
    const merged = mergeStagedForwardImports(patch, [{ ...noOwner }]);
    expect(merged.stagedDependencies?.forwardImports).toHaveLength(1);
  });
});

describe('rewriteSplitOwners', () => {
  const movedSet = new Set(['a/Helper.sys.mjs']);

  it('leaves a patch without matching forward imports untouched', () => {
    const patch = makePatch('003.patch');
    expect(rewriteSplitOwners(patch, '002-source.patch', movedSet, '004-new.patch')).toBe(patch);
  });

  it('re-points the owner of a forward import whose creates file moved', () => {
    const patch = makePatch('003.patch', {
      stagedDependencies: {
        forwardImports: [
          {
            file: 'a/I.sys.mjs',
            specifier: 'x',
            creates: 'a/Helper.sys.mjs',
            owner: '002-source.patch',
          },
        ],
      },
    });
    const rewritten = rewriteSplitOwners(patch, '002-source.patch', movedSet, '004-new.patch');
    expect(rewritten.stagedDependencies?.forwardImports?.[0]?.owner).toBe('004-new.patch');
  });
});

describe('buildSplitSummary', () => {
  function makePlan(overrides: Partial<SplitPlan>): SplitPlan {
    const placement: PlacementPlan = {
      newFilename: '002-new.patch',
      insertionOrder: 2,
      renameMap: new Map(),
    };
    return {
      source: makePatch('001-src.patch', { filesAffected: ['a', 'b'] }),
      movedFiles: ['b'],
      remainingFiles: ['a'],
      movedDiff: '',
      remainingDiff: '',
      placement,
      placementOptions: {},
      category: 'infra',
      name: 'new',
      description: '',
      ownerRewrites: [],
      stagedDependencyAdditions: new Map(),
      ...overrides,
    };
  }

  it('summarizes a plain split', () => {
    const summary = buildSplitSummary(makePlan({}));
    expect(summary.join('\n')).toContain('moved files (1): b');
    expect(summary.join('\n')).toContain('new patch: 002-new.patch');
  });

  it('reports renames and owner rewrites when present', () => {
    const placement: PlacementPlan = {
      newFilename: '002-new.patch',
      insertionOrder: 2,
      renameMap: new Map([['003-x.patch', { newFilename: '004-x.patch', newOrder: 4 }]]),
    };
    const summary = buildSplitSummary(makePlan({ placement, ownerRewrites: ['005-dep.patch'] }));
    const text = summary.join('\n');
    expect(text).toContain('003-x.patch  →  004-x.patch');
    expect(text).toContain(
      'staged-dependency owners re-pointed to the new patch in: 005-dep.patch'
    );
  });
});
