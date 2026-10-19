// SPDX-License-Identifier: EUPL-1.2
/**
 * A scoped `lint --per-patch --patches <p>` keeps queue findings that name
 * `<p>` even when the file they point at is one the patch no longer touches:
 * a stale staged import is exactly that case, and the full-queue run already
 * reports it.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { lintCommand } from '../lint.js';

vi.mock('../../utils/logger.js', () => ({
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

const KEEP = 'browser/modules/Keep.sys.mjs';
const OTHER = 'browser/modules/Other.sys.mjs';

function newFilePatchBody(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,1 @@',
    '+export const x = 1;',
    '',
  ].join('\n');
}

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'feature',
    name: filename.replace(/^\d+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-10-19T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

function unusedLines(): string[] {
  return vi
    .mocked(warn)
    .mock.calls.map((c) => c[0])
    .filter((l) => l.includes('staged-dependency-unused'));
}

describe('scoped lint --per-patch keeps queue findings that name the subset', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-perpatch-scope-');
    await writeFireForgeConfig(projectRoot, {});
    await initCommittedRepo(join(projectRoot, 'engine'), { 'browser/modules/.gitkeep': '' });

    const patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '001-keep.patch'), newFilePatchBody(KEEP));
    await writeFile(join(patchesDir, '002-other.patch'), newFilePatchBody(OTHER));
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        {
          ...meta('001-keep.patch', 1, [KEEP]),
          // The importer this declaration names is no longer in the patch.
          stagedDependencies: {
            forwardImports: [
              {
                file: 'browser/modules/Gone.sys.mjs',
                specifier: 'resource:///modules/Other.sys.mjs',
                creates: OTHER,
              },
            ],
          },
        },
        meta('002-other.patch', 2, [OTHER]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('reports a stale staged import on the declaring patch alone', async () => {
    await lintCommand(projectRoot, [], { perPatch: true, noCache: true }).catch(() => undefined);
    expect(unusedLines()).toHaveLength(1);

    vi.mocked(warn).mockClear();
    await lintCommand(projectRoot, [], {
      perPatch: true,
      noCache: true,
      patches: ['001-keep.patch'],
    }).catch(() => undefined);
    expect(unusedLines()).toHaveLength(1);
    expect(unusedLines()[0]).toContain('001-keep.patch');
  });

  it('keeps it out of a run scoped to another patch', async () => {
    await lintCommand(projectRoot, [], {
      perPatch: true,
      noCache: true,
      patches: ['002-other.patch'],
    }).catch(() => undefined);
    expect(unusedLines()).toHaveLength(0);
  });
});
