// SPDX-License-Identifier: EUPL-1.2
/**
 * `--expect-unmanaged`: a recorded exception to the adjacency refusal.
 *
 * `--refuse-adjacent-unmanaged` was all-or-nothing. A project with a
 * reviewed, deliberately unmanaged path beside a patch's ownership had to
 * drop the flag entirely on every touch of every adjacent patch, and
 * substitute a hand-read of the notice — a weaker belt than the one being
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
    expect(ctx.refusals).toEqual([{ patchFilename: '101-fonts.patch', files: [FONT] }]);
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
    // Carved out, never hidden — an exception nobody can see is how one
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
    expect(ctx.refusals).toEqual([{ patchFilename: '101-fonts.patch', files: [STRAY] }]);
    expect(vi.mocked(warn).mock.calls.flat().join('\n')).toContain(STRAY);
  });
});
