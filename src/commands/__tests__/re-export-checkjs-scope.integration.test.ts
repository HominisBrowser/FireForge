// SPDX-License-Identifier: EUPL-1.2
/**
 * `re-export` roots its checkJs program at the patches it re-exports, the
 * way `lint --per-patch --patches` roots at its subset. Unscoped, a one-patch
 * re-export that missed the lint cache type-checked the whole queue.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as checkjs from '../../core/patch-lint-checkjs.js';
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
import { info, warn } from '../../utils/logger.js';
import { reExportCommand } from '../re-export.js';

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

const GOOD = 'browser/modules/mb/Good.sys.mjs';
const BAD = 'browser/modules/mb/Bad.sys.mjs';

const HEADER = '/* SPDX-License-Identifier: EUPL-1.2 */';
const GOOD_SOURCE = [
  HEADER,
  '/** @returns {number} ok */',
  'export function f() {',
  '  return 1;',
  '}',
  '',
].join('\n');
// Bad declares a number return but yields a string, a checkJs type error.
const BAD_SOURCE = [
  HEADER,
  '/** @returns {number} bad */',
  'export function f() {',
  "  return 'not a number';",
  '}',
  '',
].join('\n');

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
    createdAt: '2026-06-15T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

function checkJsLines(): string[] {
  return vi
    .mocked(warn)
    .mock.calls.map((c) => c[0])
    .filter((l) => l.includes('checkjs-type-error'));
}

describe('re-export roots checkJs at the re-exported patches', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-reexport-checkjs-scope-');
    engineDir = join(projectRoot, 'engine');
    await writeFireForgeConfig(projectRoot, { patchLint: { checkJs: true } });
    await initCommittedRepo(engineDir, { 'browser/modules/mb/.gitkeep': '' });
    await writeFiles(engineDir, { [GOOD]: GOOD_SOURCE, [BAD]: BAD_SOURCE });

    const patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '001-good.patch'), newFilePatchBody(GOOD));
    await writeFile(join(patchesDir, '002-bad.patch'), newFilePatchBody(BAD));
    const manifest: PatchesManifest = {
      version: 1,
      patches: [meta('001-good.patch', 1, [GOOD]), meta('002-bad.patch', 2, [BAD])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('checks only the named patch and says what the lint scope is', async () => {
    const groupedSpy = vi.spyOn(checkjs, 'invokePatchLintCheckJsGrouped');
    groupedSpy.mockClear();

    await reExportCommand(projectRoot, ['001'], { dryRun: true, noCache: true });

    // The program was rooted at the named patch's files, not the queue.
    expect(groupedSpy).toHaveBeenCalledTimes(1);
    expect(groupedSpy.mock.calls[0]?.[4]).toEqual(new Set([GOOD]));
    // The other patch's type error is resolvable but never checked here.
    expect(checkJsLines()).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Lint scope: queue rules over all 2 patch(es); checkJs rooted at the 1 re-exported patch(es); lint cache off (--no-cache).'
      )
    );
    expect(info).toHaveBeenCalledWith(
      'checkJs: type-checking 1 file(s) of 001-good.patch (lint cache off).'
    );
  });

  it("reports the named patch's own findings exactly as lint --per-patch does", async () => {
    await expect(
      reExportCommand(projectRoot, ['002'], { dryRun: true, noCache: true })
    ).rejects.toThrow();

    const lines = checkJsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Bad.sys.mjs');
  });
});
