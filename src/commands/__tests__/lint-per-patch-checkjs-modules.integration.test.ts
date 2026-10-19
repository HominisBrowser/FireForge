// SPDX-License-Identifier: EUPL-1.2
/**
 * A test script's `resource:///` type import resolves to a module an
 * earlier patch creates, so checkJs judges the test against the module's
 * real types; a module a later patch creates stays the shim's `any`.
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

const MODULE = 'browser/modules/Bangs.sys.mjs';
const TEST = 'browser/components/bangs/test/browser_bangs.js';
const HEADER = '/* SPDX-License-Identifier: EUPL-1.2 */';

const MODULE_SOURCE = [
  HEADER,
  '/**',
  ' * @param {string} text - query',
  ' * @returns {string} the bang',
  ' */',
  'export function parseBang(text) {',
  '  return text;',
  '}',
  '',
].join('\n');

const TEST_SOURCE = [
  HEADER,
  '/** @type {typeof import("resource:///modules/Bangs.sys.mjs")} */',
  'const { parseBang } = ChromeUtils.importESModule("resource:///modules/Bangs.sys.mjs");',
  'add_task(async function test_bang() {',
  '  parseBang(42);',
  '});',
  '',
].join('\n');

function newFilePatchBody(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,1 @@',
    '+x',
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

function checkJsLines(): string[] {
  return vi
    .mocked(warn)
    .mock.calls.map((c) => c[0])
    .filter((l) => l.includes('checkjs-type-error'));
}

describe('per-test checkJs resolves modules created by earlier patches', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  async function seedQueue(moduleOrder: number, testOrder: number): Promise<void> {
    const patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    const modulePatch = `00${moduleOrder}-module.patch`;
    const testPatch = `00${testOrder}-test.patch`;
    await writeFile(join(patchesDir, modulePatch), newFilePatchBody(MODULE));
    await writeFile(join(patchesDir, testPatch), newFilePatchBody(TEST));
    const manifest: PatchesManifest = {
      version: 1,
      patches: [meta(modulePatch, moduleOrder, [MODULE]), meta(testPatch, testOrder, [TEST])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-checkjs-modules-');
    const engineDir = join(projectRoot, 'engine');
    await writeFireForgeConfig(projectRoot, {
      patchLint: { checkJs: true, checkJsTestFiles: true },
    });
    await initCommittedRepo(engineDir, { 'browser/modules/.gitkeep': '' });
    await writeFiles(engineDir, { [MODULE]: MODULE_SOURCE, [TEST]: TEST_SOURCE });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it("types the test against an earlier patch's module", async () => {
    await seedQueue(1, 2);
    await lintCommand(projectRoot, [], { perPatch: true, noCache: true }).catch(() => undefined);
    const lines = checkJsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('browser_bangs.js');
    expect(lines[0]).toContain("not assignable to parameter of type 'string'");
  });

  it("leaves a later patch's module untyped", async () => {
    await seedQueue(2, 1);
    await lintCommand(projectRoot, [], { perPatch: true, noCache: true }).catch(() => undefined);
    expect(checkJsLines().filter((line) => line.includes('browser_bangs.js'))).toEqual([]);
  });
});
