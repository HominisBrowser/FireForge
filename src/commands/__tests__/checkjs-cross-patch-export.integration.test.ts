// SPDX-License-Identifier: EUPL-1.2
/**
 * The export/re-export lint path resolves cross-patch `resource:///` imports
 * against the whole queue (no hand-generated ambient stub shim), while
 * reporting only the patch under export. `runPatchLint` is the shared helper
 * export/export-all/re-export(--files) all call; passing the whole-queue
 * context makes patch B's import of patch A's module type-check against A's
 * real source.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../core/config.js';
import { getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import { buildPatchQueueContext } from '../../core/patch-lint.js';
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
import { runPatchLint } from '../export-shared.js';

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

const A_PATH = 'browser/modules/mb/A.sys.mjs';
const B_PATH = 'browser/modules/mb/B.sys.mjs';

const A_SOURCE = [
  '/* SPDX-License-Identifier: EUPL-1.2 */',
  '/**',
  ' * Doubles a number.',
  ' * @param {number} n - input',
  ' * @returns {number} doubled',
  ' */',
  'export function dbl(n) {',
  '  return n * 2;',
  '}',
  '',
].join('\n');

// B imports A's resource:/// module and misuses dbl (string where number).
const B_SOURCE = [
  '/* SPDX-License-Identifier: EUPL-1.2 */',
  "import { dbl } from 'resource:///modules/A.sys.mjs';",
  '/**',
  ' * Uses dbl.',
  ' * @returns {number} result',
  ' */',
  'export function use() {',
  "  return dbl('not a number');",
  '}',
  '',
].join('\n');

function newFilePatchBody(path: string, addedLine: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,1 @@',
    `+${addedLine}`,
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
    createdAt: '2026-06-15T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

function checkJsErrorLines(): string[] {
  return vi
    .mocked(warn)
    .mock.calls.map((c) => c[0])
    .filter((l) => l.includes('checkjs-type-error'));
}

describe('export/re-export cross-patch checkJs resolution (item C)', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-checkjs-xpatch-');
    engineDir = join(projectRoot, 'engine');
    await writeFireForgeConfig(projectRoot, { patchLint: { checkJs: true } });
    await initCommittedRepo(engineDir, { 'browser/modules/mb/.gitkeep': '' });
    await writeFiles(engineDir, { [A_PATH]: A_SOURCE, [B_PATH]: B_SOURCE });

    const patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    await writeFile(
      join(patchesDir, '001-a.patch'),
      newFilePatchBody(A_PATH, 'export function dbl(n) { return n * 2; }')
    );
    await writeFile(
      join(patchesDir, '002-b.patch'),
      newFilePatchBody(B_PATH, "import { dbl } from 'resource:///modules/A.sys.mjs';")
    );
    const manifest: PatchesManifest = {
      version: 1,
      patches: [meta('001-a.patch', 1, [A_PATH]), meta('002-b.patch', 2, [B_PATH])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('resolves B → A cross-patch and reports B misusing A (no ambient stub)', async () => {
    const config = await loadConfig(projectRoot);
    const ctx = await buildPatchQueueContext(join(projectRoot, 'patches'));
    const diff = await getDiffForFilesAgainstHead(engineDir, [B_PATH]);

    // With the whole-queue context, B's import resolves to A's real source,
    // so the misuse is a hard error that blocks the (re-)export.
    await expect(runPatchLint(engineDir, [B_PATH], diff, config, false, ctx)).rejects.toThrow(
      /error/i
    );
    const lines = checkJsErrorLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l) => l.includes(B_PATH))).toBe(true);
  });

  it('without the queue context the isolated patch cannot resolve the import', async () => {
    const config = await loadConfig(projectRoot);
    const diff = await getDiffForFilesAgainstHead(engineDir, [B_PATH]);

    // No context → resolution is limited to B's own files, so the import
    // degrades to the ambient wildcard and the misuse is invisible.
    await expect(
      runPatchLint(engineDir, [B_PATH], diff, config, false, undefined)
    ).resolves.toBeUndefined();
    expect(checkJsErrorLines()).toHaveLength(0);
  });
});
