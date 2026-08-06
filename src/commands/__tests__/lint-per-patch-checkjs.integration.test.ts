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

  it('a warm (all-cache-hit) run still surfaces run-level checkJs errors (FORGE F5)', async () => {
    // A broken extra shim produces a GLOBAL checkJs error (no owning file).
    // Global findings are never cached, so before the fix an all-cache-hit
    // run dropped them entirely and reported fewer errors than a cold run.
    const { writeFireForgeConfig: rewriteConfig } = await import('../../test-utils/index.js');
    await rewriteConfig(projectRoot, {
      patchLint: { checkJs: true, checkJsExtraShim: 'does-not-exist.d.ts' },
    });

    const globalErrorLines = (): string[] =>
      vi
        .mocked(warn)
        .mock.calls.map((c) => c[0])
        .filter((l) => l.includes('does-not-exist.d.ts'));

    // Cold run (populates the cache).
    await lintCommand(projectRoot, [], { perPatch: true }).catch(() => undefined);
    const coldLines = globalErrorLines();
    expect(coldLines.length).toBeGreaterThan(0);

    vi.mocked(warn).mockClear();

    // Warm run — every patch is a cache hit, the global error must persist.
    await lintCommand(projectRoot, [], { perPatch: true }).catch(() => undefined);
    const warmLines = globalErrorLines();
    expect(warmLines.length).toBe(coldLines.length);
  });
});

/**
 * FORGE G5: per-patch checkJs never included patch-adopted test `.js`
 * files, so a call to a harness member the consumer's shim does not
 * declare (the TS2339 on `TestUtils.waitForCondition`) was invisible at
 * the patch boundary and surfaced only in the downstream composed gate.
 */
describe('lint --per-patch checkJs over patch-owned test files (FORGE G5)', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  const TEST_FILE = 'browser/components/mb/test/browser/browser_mb_basic.js';
  const TEST_SOURCE = [
    HEADER,
    'add_task(async function test_basic() {',
    '  await TestUtils.waitForCondition(() => true);',
    '  ok(true, "ran");',
    '});',
    '',
  ].join('\n');
  // Consumer-typed harness shim: TestUtils exists but declares only
  // waitForTick — the waitForCondition call must fail as a type error.
  const TYPED_TEST_SHIM = [
    'interface TypedTestUtils {',
    '  waitForTick(): Promise<void>;',
    '}',
    'declare var TestUtils: TypedTestUtils;',
    '',
  ].join('\n');

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-perpatch-checkjs-tests-');
    engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, { 'browser/components/mb/.gitkeep': '' });
    await writeFiles(engineDir, { [TEST_FILE]: TEST_SOURCE });
    await writeFiles(projectRoot, { 'shims/test-harness.d.ts': TYPED_TEST_SHIM });

    const patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    await writeFile(join(patchesDir, '001-test.patch'), newFilePatchBody(TEST_FILE));
    const manifest: PatchesManifest = {
      version: 1,
      patches: [meta('001-test.patch', 1, [TEST_FILE])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('pins the pre-0.40.0 gap: without checkJsTestFiles the test file is never checked', async () => {
    await writeFireForgeConfig(projectRoot, { patchLint: { checkJs: true } });

    await lintCommand(projectRoot, [], { perPatch: true, noCache: true }).catch(() => undefined);

    expect(checkJsLines()).toHaveLength(0);
  });

  it('surfaces the TS2339-class harness error attributed to the owning patch when enabled', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchLint: {
        checkJs: true,
        checkJsTestFiles: true,
        checkJsTestShim: 'shims/test-harness.d.ts',
      },
    });

    await lintCommand(projectRoot, [], { perPatch: true, noCache: true }).catch(() => undefined);

    const lines = checkJsLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join('\n')).toContain('001-test.patch');
    expect(lines.join('\n')).toContain('browser_mb_basic.js');
    expect(lines.join('\n')).toContain('waitForCondition');
  });

  it('passes with the loose built-in harness shim when no consumer shim narrows it', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchLint: { checkJs: true, checkJsTestFiles: true },
    });

    await expect(
      lintCommand(projectRoot, [], { perPatch: true, noCache: true })
    ).resolves.toBeUndefined();

    expect(checkJsLines()).toHaveLength(0);
  });
});
