// SPDX-License-Identifier: EUPL-1.2
/**
 * `--expect-unmanaged`: a recorded exception to the adjacency refusal.
 *
 * `--refuse-adjacent-unmanaged` was all-or-nothing. A project with a
 * reviewed, deliberately unmanaged path beside a patch's ownership had to
 * drop the flag entirely on every touch of every adjacent patch, and
 * substitute a hand-read of the notice, a weaker belt than the one being
 * disarmed, recurring forever. The carve-out keeps the belt armed for
 * everything except the paths named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/git-status.js', () => ({
  getModifiedFilesInDir: vi.fn(() => Promise.resolve([])),
  getUntrackedFilesInDir: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

import { getUntrackedFilesInDir } from '../../core/git-status.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { info, warn } from '../../utils/logger.js';
import type { AdjacentUnmanagedContext } from '../re-export-adjacent.js';
import { reportAdjacentUnmanagedFiles } from '../re-export-adjacent.js';

const OWNED = 'browser/themes/shared/hominis/fonts.css';
const FONT = 'browser/themes/shared/hominis/nebula-sans-regular.woff2';
const STRAY = 'browser/themes/shared/hominis/scratch.css';
/** The directory OWNED lives in, the anchor every notice names. */
const ANCHOR_DIR = 'browser/themes/shared/hominis';

const patch: PatchMetadata = {
  filename: '101-fonts.patch',
  order: 101,
  name: 'fonts',
  description: '',
  filesAffected: [OWNED],
} as PatchMetadata;

const manifest: PatchesManifest = { patches: [patch] } as PatchesManifest;

const paths = { engine: '/project/engine' } as ReturnType<
  typeof import('../../core/config.js').getProjectPaths
>;

function makeCtx(approved: string[]): AdjacentUnmanagedContext {
  return {
    binaryName: 'hominis',
    furnacePrefixes: new Set<string>(),
    refuseAdjacentUnmanaged: true,
    approvedUnmanaged: new Set(approved),
    approvedSeen: new Set(),
    refusals: [],
  };
}

describe('--expect-unmanaged carve-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses an unapproved adjacent file', async () => {
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([FONT]);
    const ctx = makeCtx([]);

    const refused = await reportAdjacentUnmanagedFiles({
      patch,
      paths,
      manifest,
      currentFilesAffected: [OWNED],
      ctx,
    });

    expect(refused).toBe(true);
    expect(ctx.refusals).toEqual([
      {
        patchFilename: '101-fonts.patch',
        files: [FONT],
        anchored: [`${FONT} (beside engine/${ANCHOR_DIR})`],
      },
    ]);
  });

  it('admits an approved path without refusing, and still reports it', async () => {
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([FONT]);
    const ctx = makeCtx([FONT]);

    const refused = await reportAdjacentUnmanagedFiles({
      patch,
      paths,
      manifest,
      currentFilesAffected: [OWNED],
      ctx,
    });

    expect(refused).toBe(false);
    expect(ctx.refusals).toEqual([]);
    expect(ctx.approvedSeen.has(FONT)).toBe(true);
    // Carved out, never hidden: an exception nobody can see is how one
    // quietly widens.
    expect(vi.mocked(info).mock.calls.flat().join('\n')).toContain('--expect-unmanaged');
  });

  it('keeps the belt armed for everything the carve-out does not name', async () => {
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([FONT, STRAY]);
    const ctx = makeCtx([FONT]);

    const refused = await reportAdjacentUnmanagedFiles({
      patch,
      paths,
      manifest,
      currentFilesAffected: [OWNED],
      ctx,
    });

    expect(refused).toBe(true);
    expect(ctx.refusals).toEqual([
      {
        patchFilename: '101-fonts.patch',
        files: [STRAY],
        anchored: [`${STRAY} (beside engine/${ANCHOR_DIR})`],
      },
    ]);
    expect(vi.mocked(warn).mock.calls.flat().join('\n')).toContain(STRAY);
  });

  it('names the owned directory that made each file adjacent', async () => {
    // The case the anchor exists for: a patch owning files in two
    // directories. Without the anchor the notice names the offender and the
    // patch but not which ownership it sits beside, so an unattended run
    // cannot triage the refusal from its output alone.
    const ownedA = 'browser/base/content/test/about/browser_a.js';
    const ownedB = 'browser/base/content/test/contextMenu/browser_b.js';
    const strayInB = 'browser/base/content/test/contextMenu/browser_peer.js';
    const multi: PatchMetadata = { ...patch, filesAffected: [ownedA, ownedB] };
    vi.mocked(getUntrackedFilesInDir).mockImplementation((_engine: string, dir: string) =>
      Promise.resolve(dir === 'browser/base/content/test/contextMenu' ? [strayInB] : [])
    );
    const ctx = makeCtx([]);

    const refused = await reportAdjacentUnmanagedFiles({
      patch: multi,
      paths,
      manifest: { patches: [multi] } as PatchesManifest,
      currentFilesAffected: [ownedA, ownedB],
      ctx,
    });

    expect(refused).toBe(true);
    expect(ctx.refusals).toEqual([
      {
        patchFilename: '101-fonts.patch',
        files: [strayInB],
        anchored: [`${strayInB} (beside engine/browser/base/content/test/contextMenu)`],
      },
    ]);
    const warned = vi.mocked(warn).mock.calls.flat().join('\n');
    expect(warned).toContain('beside engine/browser/base/content/test/contextMenu');
    // The rule itself is stated, so a reader need not infer it from the example.
    expect(warned).toContain('a directory this patch already owns a file in');
    // The anchor is the owning directory, never the unrelated sibling.
    expect(warned).not.toContain('beside engine/browser/base/content/test/about');
  });
});
