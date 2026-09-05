// SPDX-License-Identifier: EUPL-1.2
/**
 * The ad-hoc explicit-file-list lint path (`fireforge lint <files>`) must
 * resolve each file's owning patch for the patch-size rules, so it agrees
 * with `lint --per-patch` and `re-export --dry-run` instead of synthesising a
 * phantom oversized patch from the operator's cross-patch file selection.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { lintCommand } from '../lint.js';

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

const CLEAN_CSS = '/* SPDX-License-Identifier: EUPL-1.2 */\n.foo { display: flex; }\n';

function cssFiles(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${dir}/file-${String(i + 1)}.css`);
}

function meta(
  filename: string,
  order: number,
  filesAffected: string[],
  lintIgnore?: string[]
): PatchMetadata {
  return {
    filename,
    order,
    category: 'feature',
    name: filename.replace(/^\d+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-06-15T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
    ...(lintIgnore ? { lintIgnore } : {}),
  };
}

/** Joins every `warn(...)` line emitted during the most recent lint run. */
function warnText(): string {
  return vi
    .mocked(warn)
    .mock.calls.map((c) => c[0])
    .join('\n');
}

/** Lines mentioning the large-patch-files rule. */
function largePatchFilesLines(): string[] {
  return warnText()
    .split('\n')
    .filter((l) => l.includes('large-patch-files'));
}

describe('lint <files> ad-hoc owning-patch size resolution (item A)', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  // Four patches: two small (3 files each, under the threshold), one big (6
  // files, over), one big-but-waived (6 files + lintIgnore).
  const smallA = cssFiles('browser/x/a', 3);
  const smallB = cssFiles('browser/x/b', 3);
  const big = cssFiles('browser/x/big', 6);
  const ignored = cssFiles('browser/x/ign', 6);
  const allFiles = [...smallA, ...smallB, ...big, ...ignored];

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-lint-adhoc-');
    engineDir = join(projectRoot, 'engine');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(engineDir, { 'browser/x/.gitkeep': '' });
    // New (untracked) clean CSS files. They trip no per-file rule, so the
    // only size signal is the patch-cardinality rule under test.
    await writeFiles(engineDir, Object.fromEntries(allFiles.map((f) => [f, CLEAN_CSS])));

    const patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    const patches: PatchMetadata[] = [
      meta('001-small-a.patch', 1, smallA),
      meta('002-small-b.patch', 2, smallB),
      meta('003-big.patch', 3, big),
      meta('004-ignored.patch', 4, ignored, ['large-patch-files']),
    ];
    for (const p of patches) {
      await writeFile(join(patchesDir, p.filename), `# stub ${p.filename}\n`);
    }
    const manifest: PatchesManifest = { version: 1, patches };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('A1: a cross-patch file list does not synthesise a phantom oversized patch', async () => {
    // 6 files across two 3-file patches: the old aggregate path counted 6 (> 5)
    // and fired. Per-owner resolution sees 3 and 3, so it must not fire.
    await lintCommand(projectRoot, [...smallA, ...smallB]);
    expect(largePatchFilesLines()).toEqual([]);
  });

  it('A1: a genuinely oversized owning patch still fires, attributed to that patch', async () => {
    await lintCommand(projectRoot, big);
    const lines = largePatchFilesLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('003-big.patch');
  });

  it('A2: the owning patch lintIgnore suppresses large-patch-files in ad-hoc mode', async () => {
    await lintCommand(projectRoot, ignored);
    expect(largePatchFilesLines()).toEqual([]);
  });

  it('all three counts agree: ad-hoc whole-tree lint matches --per-patch', async () => {
    // Ad-hoc over the whole tree: only the un-waived oversized patch fires.
    await lintCommand(projectRoot, ['browser/x']);
    const adHoc = largePatchFilesLines();
    expect(adHoc.some((l) => l.includes('003-big.patch'))).toBe(true);
    expect(adHoc.some((l) => l.includes('004-ignored.patch'))).toBe(false);

    vi.clearAllMocks();

    // --per-patch over the same queue: same large-patch-files owner set.
    await lintCommand(projectRoot, [], { perPatch: true }).catch(() => undefined);
    const perPatch = largePatchFilesLines();
    expect(perPatch.some((l) => l.includes('003-big.patch'))).toBe(true);
    expect(perPatch.some((l) => l.includes('004-ignored.patch'))).toBe(false);
  });
});
