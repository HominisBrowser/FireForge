// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit coverage for the FORGE F1 discard planner: plan kinds, refusals,
 * and the human-facing describe/summarize strings. The end-to-end restore
 * mechanics live in discard-patch-baseline.integration.test.ts.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  makeGitStatusEntry,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import {
  describeConflictWarning,
  describeDiscardBaseline,
  describeDiscardOutcome,
  type DiscardBaselinePlan,
  planDiscardBaselines,
  planUpstreamDiscards,
  summarizeDiscardBaselines,
} from '../discard-baseline.js';

const TRACKED = 'browser/tracked.txt';
const CREATED = 'browser/created.txt';
const DELETED = 'browser/gone.txt';

const EDIT_PATCH = [
  `diff --git a/${TRACKED} b/${TRACKED}`,
  `--- a/${TRACKED}`,
  `+++ b/${TRACKED}`,
  '@@ -1 +1,2 @@',
  ' upstream\n+patched',
  '',
].join('\n');

const CREATE_PATCH = [
  `diff --git a/${CREATED} b/${CREATED}`,
  'new file mode 100644',
  '--- /dev/null',
  `+++ b/${CREATED}`,
  '@@ -0,0 +1 @@',
  '+created',
  '',
].join('\n');

const DELETE_PATCH = [
  `diff --git a/${DELETED} b/${DELETED}`,
  'deleted file mode 100644',
  `--- a/${DELETED}`,
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

describe('planDiscardBaselines', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-discard-plan-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { [TRACKED]: 'upstream\n', [DELETED]: 'bye\n' });
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '0001-ui-edit.patch'), EDIT_PATCH);
    await writeFile(join(patchesDir, '0002-ui-create.patch'), CREATE_PATCH);
    await writeFile(join(patchesDir, '0003-ui-delete.patch'), DELETE_PATCH);
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        meta('0001-ui-edit.patch', 1, [TRACKED]),
        meta('0002-ui-create.patch', 2, [CREATED]),
        meta('0003-ui-delete.patch', 3, [DELETED]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('classifies patch-backed, patch-created, patch-deleted, and unmanaged entries', async () => {
    await writeFiles(engineDir, { [DELETED]: 'resurrected\n' });
    const entries = [
      makeGitStatusEntry({ file: TRACKED, status: ' M' }),
      makeGitStatusEntry({ file: CREATED, status: '??', isUntracked: true }),
      makeGitStatusEntry({ file: DELETED, status: '??', isUntracked: true }),
      makeGitStatusEntry({ file: 'browser/unrelated.txt', status: '??', isUntracked: true }),
    ];

    const plans = await planDiscardBaselines(patchesDir, engineDir, entries);
    expect(plans.map((p) => p.kind)).toEqual([
      'patch-backed',
      'patch-created',
      'patch-deleted',
      'unmanaged',
    ]);
    expect(plans[0]?.owners).toEqual(['0001-ui-edit.patch']);
    expect(plans[0]?.expectedContent).toContain('patched');
    expect(plans[1]?.expectedContent).toBe('created\n');
    expect(plans[2]?.expectedContent).toBeNull();
    expect(plans[3]?.owners).toEqual([]);
  });

  it('marks multi-owner claims as conflicted', async () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        meta('0001-ui-edit.patch', 1, [TRACKED]),
        meta('0002-ui-create.patch', 2, [CREATED, TRACKED]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));

    const plans = await planDiscardBaselines(patchesDir, engineDir, [
      makeGitStatusEntry({ file: TRACKED, status: ' M' }),
    ]);
    expect(plans[0]?.conflicted).toBe(true);
    expect(plans[0]?.owners).toEqual(['0001-ui-edit.patch', '0002-ui-create.patch']);
    expect(describeConflictWarning(plans[0] as DiscardBaselinePlan)).toContain(
      'claimed by 2 patches'
    );
  });

  it('degrades every plan to unmanaged when no patches dir or manifest exists', async () => {
    const noManifest = await createTempProject('ff-discard-nomanifest-');
    try {
      const plans = await planDiscardBaselines(join(noManifest, 'patches'), engineDir, [
        makeGitStatusEntry({ file: TRACKED, status: ' M' }),
      ]);
      expect(plans[0]?.kind).toBe('unmanaged');
    } finally {
      await removeTempProject(noManifest);
    }
  });

  it('refuses on a corrupt manifest instead of falling back to upstream', async () => {
    await writeFile(join(patchesDir, 'patches.json'), '{ nope');
    await expect(
      planDiscardBaselines(patchesDir, engineDir, [makeGitStatusEntry({ file: TRACKED })])
    ).rejects.toThrow(/patches\.json is unreadable.*--to-upstream/s);
  });

  it('refuses when a claimed baseline cannot be reconstructed', async () => {
    // A patch body that cannot apply to HEAD content (context mismatch).
    await writeFile(
      join(patchesDir, '0001-ui-edit.patch'),
      EDIT_PATCH.replace(' upstream', ' totally different context')
    );
    await expect(
      planDiscardBaselines(patchesDir, engineDir, [makeGitStatusEntry({ file: TRACKED })])
    ).rejects.toThrow(/Cannot reconstruct the patch baseline for .*--to-upstream/s);
  });
});

describe('applyDiscardBaseline (rename and staged sides)', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-discard-apply-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { [TRACKED]: 'upstream\n' });
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '0001-ui-edit.patch'), EDIT_PATCH);
    const manifest: PatchesManifest = {
      version: 1,
      patches: [meta('0001-ui-edit.patch', 1, [TRACKED])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('restores a claimed original side and removes an unclaimed renamed side', async () => {
    const { applyDiscardBaseline } = await import('../discard-baseline.js');
    const { runGit } = await import('../../test-utils/index.js');
    // Simulate a staged rename of the claimed tracked file to a new name.
    await runGit(engineDir, ['mv', TRACKED, 'browser/renamed.txt']);

    const plans = await planDiscardBaselines(patchesDir, engineDir, [
      makeGitStatusEntry({
        file: 'browser/renamed.txt',
        originalPath: TRACKED,
        isRenameOrCopy: true,
        status: 'R ',
      }),
    ]);
    expect(plans[0]?.kind).toBe('patch-deleted'); // renamed.txt itself is unclaimed & untracked-at-baseline
    expect(plans[0]?.expectedOriginalContent).toContain('patched');

    await applyDiscardBaseline(engineDir, plans[0] as DiscardBaselinePlan);

    const { readProjectText } = await import('../../test-utils/index.js');
    await expect(readProjectText(projectRoot, `engine/${TRACKED}`)).resolves.toContain('patched');
  });

  it('restores an unclaimed tracked original side from HEAD', async () => {
    const { applyDiscardBaseline } = await import('../discard-baseline.js');
    const { runGit, readProjectText } = await import('../../test-utils/index.js');
    await writeFiles(engineDir, { 'browser/other.txt': 'other\n' });
    await runGit(engineDir, ['add', 'browser/other.txt']);
    await runGit(engineDir, ['commit', '-m', 'add other']);
    await runGit(engineDir, ['mv', '-f', 'browser/other.txt', TRACKED]);

    // TRACKED (the new side) is claimed; browser/other.txt (original) is not.
    const plans = await planDiscardBaselines(patchesDir, engineDir, [
      makeGitStatusEntry({
        file: TRACKED,
        originalPath: 'browser/other.txt',
        isRenameOrCopy: true,
        status: 'R ',
      }),
    ]);
    await applyDiscardBaseline(engineDir, plans[0] as DiscardBaselinePlan);

    await expect(readProjectText(projectRoot, 'engine/browser/other.txt')).resolves.toBe('other\n');
  });
});

describe('describe/summarize helpers', () => {
  const plan = (kind: DiscardBaselinePlan['kind'], overrides = {}): DiscardBaselinePlan => ({
    entry: makeGitStatusEntry({ file: 'a.txt' }),
    kind,
    owners: kind === 'unmanaged' ? [] : ['0001-ui-a.patch'],
    conflicted: false,
    expectedContent: kind === 'patch-deleted' ? null : 'x',
    ...overrides,
  });

  it('planUpstreamDiscards produces unmanaged plans', () => {
    const plans = planUpstreamDiscards([makeGitStatusEntry({ file: 'a.txt' })]);
    expect(plans[0]?.kind).toBe('unmanaged');
  });

  it('describeDiscardBaseline names the restore target per kind', () => {
    expect(describeDiscardBaseline(plan('patch-backed'))).toBe('patch baseline: 0001-ui-a.patch');
    expect(describeDiscardBaseline(plan('patch-created'))).toBe(
      're-materialize from 0001-ui-a.patch'
    );
    expect(describeDiscardBaseline(plan('patch-deleted'))).toBe(
      'delete — 0001-ui-a.patch removes it'
    );
    expect(
      describeDiscardBaseline(
        plan('unmanaged', { entry: makeGitStatusEntry({ file: 'a.txt', isUntracked: true }) })
      )
    ).toBe('unmanaged — delete');
    expect(describeDiscardBaseline(plan('unmanaged'))).toBe('unmanaged — revert to upstream');
  });

  it('describeDiscardOutcome names the baseline in the outro', () => {
    expect(describeDiscardOutcome(plan('patch-backed'), false)).toBe(
      'File restored to patch baseline (0001-ui-a.patch)'
    );
    expect(describeDiscardOutcome(plan('patch-created'), false)).toBe(
      'File re-materialized from patch baseline (0001-ui-a.patch)'
    );
    expect(describeDiscardOutcome(plan('patch-deleted'), false)).toBe(
      'File removed to match patch baseline (0001-ui-a.patch deletes it)'
    );
    expect(describeDiscardOutcome(plan('unmanaged'), false)).toBe(
      'File restored to original state'
    );
    expect(describeDiscardOutcome(plan('patch-backed'), true)).toBe(
      'File restored to pristine upstream (HEAD)'
    );
  });

  it('summarizeDiscardBaselines buckets the counts', () => {
    expect(
      summarizeDiscardBaselines(
        [plan('patch-backed'), plan('patch-created'), plan('patch-deleted'), plan('unmanaged')],
        4
      )
    ).toBe(
      '4 file(s) restored: 1 to patch baseline, 1 re-materialized, 1 removed per patch baseline, 1 to upstream state'
    );
    expect(summarizeDiscardBaselines([plan('unmanaged'), plan('unmanaged')], 2)).toBe(
      '2 file(s) restored to upstream state'
    );
  });
});
