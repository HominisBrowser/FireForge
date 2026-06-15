// SPDX-License-Identifier: EUPL-1.2
/**
 * Regression coverage for item B2 (0.32.0): `lint --per-patch` builds the
 * checkJs program once per run and attributes each finding to its owning
 * patch, instead of rebuilding the queue-wide program for every patch (which
 * duplicated a single type regression once per patch in the queue).
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
import { warn } from '../../utils/logger.js';
import { lintCommand } from '../lint.js';

vi.mock('../../utils/logger.js', () => ({
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
// Bad declares a number return but yields a string — a checkJs type error.
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

describe('lint --per-patch checkJs program is built once and attributed per patch (item B2)', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-perpatch-checkjs-');
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

  it('reports the type error exactly once, attributed to its owning patch, with one program build', async () => {
    const groupedSpy = vi.spyOn(checkjs, 'invokePatchLintCheckJsGrouped');

    // Per-patch lint throws because Bad has a real error; the findings are
    // still emitted via warn() before the throw.
    await lintCommand(projectRoot, [], { perPatch: true, noCache: true }).catch(() => undefined);

    const lines = checkJsLines();
    // Exactly one checkJs finding — not duplicated once per patch in the queue.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Bad.sys.mjs');
    expect(lines[0]).toContain('002-bad.patch');
    expect(lines[0]).not.toContain('001-good.patch');

    // The queue-wide program is built once for the whole run, not per patch.
    expect(groupedSpy).toHaveBeenCalledTimes(1);
  });
});
