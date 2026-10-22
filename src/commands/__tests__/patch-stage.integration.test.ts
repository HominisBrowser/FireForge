// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `patch stage` against a throwaway project
 * repository: only the named patches' rows of patches.json reach the
 * index, the working copy is untouched, and an invalid result is refused.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mutatePatchRowsInManifest } from '../../core/patch-manifest-io.js';
import { mergeStagedManifest } from '../../core/patch-manifest-stage.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { patchStageCommand } from '../patch/stage.js';

function meta(order: number, extras: Partial<PatchMetadata> = {}): PatchMetadata {
  return {
    filename: `${order}-ui-p${order}.patch`,
    order,
    category: 'ui',
    name: `p${order}`,
    description: 'committed',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    sourceVersion: '140.9.0esr',
    filesAffected: [`ui/P${order}.sys.mjs`],
    ...extras,
  };
}

function manifestText(manifest: PatchesManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

describe('patch stage', () => {
  let projectRoot: string;
  const manifestPath = (): string => join(projectRoot, 'patches', 'patches.json');

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-stage-');
    await initCommittedRepo(projectRoot, {
      'fireforge.json': '{}\n',
      'patches/1-ui-p1.patch': '# p1\n',
      'patches/2-ui-p2.patch': '# p2\n',
      'patches/patches.json': manifestText({ version: 1, patches: [meta(1), meta(2)] }),
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  async function staged(): Promise<PatchesManifest> {
    return JSON.parse(
      await runGit(projectRoot, ['show', ':patches/patches.json'])
    ) as PatchesManifest;
  }

  it("stages one session's rows and patch file, leaving a peer's rows at HEAD", async () => {
    // This session added 3; a peer edited 2 and added 4 in the same file.
    const working: PatchesManifest = {
      version: 1,
      patches: [meta(1), meta(2, { description: 'peer edit' }), meta(3), meta(4)],
    };
    await writeFile(manifestPath(), manifestText(working));
    await writeFile(join(projectRoot, 'patches/3-ui-p3.patch'), '# p3\n');
    await writeFile(join(projectRoot, 'patches/4-ui-p4.patch'), '# p4\n');

    await patchStageCommand(projectRoot, ['3']);

    const index = await staged();
    expect(index.patches.map((row) => [row.order, row.description])).toEqual([
      [1, 'committed'],
      [2, 'committed'],
      [3, 'committed'],
    ]);
    const names = (await runGit(projectRoot, ['diff', '--cached', '--name-only'])).trim();
    expect(names.split('\n').sort()).toEqual(['patches/3-ui-p3.patch', 'patches/patches.json']);
    // The working copy keeps every session's rows.
    expect(await readFile(manifestPath(), 'utf8')).toBe(manifestText(working));
  });

  it('leaves no key-order diff between the working copy and the index after a row write', async () => {
    // HEAD with a non-canonical key order: sourceProduct after the arrays.
    const legacy = (order: number): Record<string, unknown> => ({
      ...meta(order),
      sourceProduct: 'firefox-esr',
    });
    const headText = `${JSON.stringify({ version: 1, patches: [legacy(1), legacy(2)] }, null, 2)}\n`;
    await writeFile(manifestPath(), headText);
    await runGit(projectRoot, ['commit', '-qam', 'legacy order']);

    // A re-export of 2 rewrites its row; 1 is untouched.
    await mutatePatchRowsInManifest(join(projectRoot, 'patches'), ['2-ui-p2.patch'], () => ({
      set: { description: 'edited' },
    }));
    await patchStageCommand(projectRoot, ['2']);

    // Row 1 must be canonical in both the working copy and the index, or
    // the next whole-file commit flips it.
    expect(await runGit(projectRoot, ['diff', '--', 'patches/patches.json'])).toBe('');
  });

  it('stages the removal of a deleted patch named by its HEAD filename', async () => {
    await writeFile(manifestPath(), manifestText({ version: 1, patches: [meta(1)] }));
    await rm(join(projectRoot, 'patches/2-ui-p2.patch'));

    await patchStageCommand(projectRoot, ['2-ui-p2.patch']);

    expect((await staged()).patches.map((row) => row.order)).toEqual([1]);
    const status = await runGit(projectRoot, ['diff', '--cached', '--name-status']);
    expect(status).toContain('D\tpatches/2-ui-p2.patch');
  });

  it('--dry-run touches nothing', async () => {
    await writeFile(
      manifestPath(),
      manifestText({ version: 1, patches: [meta(1), meta(2, { description: 'x' })] })
    );
    await patchStageCommand(projectRoot, ['2'], { dryRun: true });
    expect((await runGit(projectRoot, ['diff', '--cached', '--name-only'])).trim()).toBe('');
  });

  it('refuses an unknown patch, a collision, and a non-repository', async () => {
    await expect(patchStageCommand(projectRoot, ['99'])).rejects.toBeInstanceOf(
      InvalidArgumentError
    );

    // A peer renumbered 2 to 3 (unstaged) while this session took order 2.
    await writeFile(
      manifestPath(),
      manifestText({
        version: 1,
        patches: [meta(1), meta(2, { filename: '2-ui-mine.patch', name: 'mine' })],
      })
    );
    await writeFile(join(projectRoot, 'patches/2-ui-mine.patch'), '# mine\n');
    await expect(patchStageCommand(projectRoot, ['2-ui-mine.patch'])).rejects.toThrow(
      /order 2 would be held by both 2-ui-mine\.patch and 2-ui-p2\.patch/
    );

    const bare = await createTempProject('ff-stage-bare-');
    try {
      await expect(patchStageCommand(bare, ['1'])).rejects.toBeInstanceOf(GeneralError);
    } finally {
      await removeTempProject(bare);
    }
  });
});

describe('mergeStagedManifest', () => {
  it('takes named retired slots from the working copy and drops filled reservations', () => {
    const head: PatchesManifest = {
      version: 1,
      patches: [meta(1), meta(2)],
      reserved: [
        { order: 3, category: 'ui', owner: 'me', reservedAt: 't' },
        { order: 4, category: 'ui', owner: 'peer', reservedAt: 't' },
      ],
    };
    const working: PatchesManifest = {
      version: 1,
      patches: [meta(1), meta(3)],
      retired: [{ order: 2, category: 'ui', filename: '2-ui-p2.patch', retiredAt: 't' }],
      reserved: [{ order: 4, category: 'ui', owner: 'peer', reservedAt: 't' }],
    };

    const { manifest, changes } = mergeStagedManifest(
      head,
      working,
      new Set(['2-ui-p2.patch', '3-ui-p3.patch'])
    );

    expect(manifest.patches.map((row) => row.order)).toEqual([1, 3]);
    expect(manifest.retired?.map((slot) => slot.order)).toEqual([2]);
    expect(manifest.reserved?.map((slot) => slot.order)).toEqual([4]);
    expect(changes).toEqual([
      { filename: '2-ui-p2.patch', change: 'removed' },
      { filename: '3-ui-p3.patch', change: 'added' },
    ]);
  });

  it('reports an unchanged row and refuses a manifest that would not validate', () => {
    const head: PatchesManifest = { version: 1, patches: [meta(1)] };
    expect(mergeStagedManifest(head, head, new Set(['1-ui-p1.patch'])).changes).toEqual([
      { filename: '1-ui-p1.patch', change: 'unchanged' },
    ]);
    const broken = { version: 1, patches: [{ ...meta(1), order: -1 }] } as PatchesManifest;
    expect(() => mergeStagedManifest(null, broken, new Set(['1-ui-p1.patch']))).toThrow(
      /would not validate/
    );
  });
});
