// SPDX-License-Identifier: EUPL-1.2
/**
 * `lint --per-patch` builds the checkJs program once per run and attributes
 * each finding to its owning patch, instead of rebuilding the queue-wide
 * program for every patch — which duplicates a single type regression once
 * per patch in the queue.
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

  it('roots the program at the --patches subset with full-queue resolution and identical findings', async () => {
    const groupedSpy = vi.spyOn(checkjs, 'invokePatchLintCheckJsGrouped');

    // Subset run over the bad patch: same finding as a full run.
    await lintCommand(projectRoot, [], {
      perPatch: true,
      noCache: true,
      patches: ['002-bad.patch'],
    }).catch(() => undefined);
    const subsetLines = checkJsLines();
    expect(subsetLines).toHaveLength(1);
    expect(subsetLines[0]).toContain('Bad.sys.mjs');
    // The program received a rootScope restricted to the subset's files.
    expect(groupedSpy.mock.calls[0]?.[4]).toEqual(new Set([BAD]));

    vi.mocked(warn).mockClear();

    // Subset run over the clean patch: the bad patch's finding must NOT
    // surface (its file is resolvable but not a root).
    await lintCommand(projectRoot, [], {
      perPatch: true,
      noCache: true,
      patches: ['001-good.patch'],
    }).catch(() => undefined);
    expect(checkJsLines()).toHaveLength(0);
  });

  it('an all-warm run does not build the checkJs program at all', async () => {
    // Cold run populates the cache.
    await lintCommand(projectRoot, [], { perPatch: true }).catch(() => undefined);

    // spyOn returns the same persistent spy across tests in this file, so
    // drop the cold run's recorded build before asserting on the warm run.
    const groupedSpy = vi.spyOn(checkjs, 'invokePatchLintCheckJsGrouped');
    groupedSpy.mockClear();
    vi.mocked(warn).mockClear();

    // Warm run: every patch hits the cache; run-level globals come from the
    // cheap probe, so the ~37 s program build never happens.
    await lintCommand(projectRoot, [], { perPatch: true }).catch(() => undefined);

    expect(groupedSpy).not.toHaveBeenCalled();
    // The cached findings still surface identically.
    const lines = checkJsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Bad.sys.mjs');
  });

  it('a warm (all-cache-hit) run still surfaces run-level checkJs errors', async () => {
    // A broken extra shim produces a GLOBAL checkJs error (no owning file).
    // Global findings are never cached, so an all-cache-hit run that drops
    // them reports fewer errors than a cold run.
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
 * Per-patch checkJs must include patch-adopted test `.js` files: otherwise a
 * call to a harness member the consumer's shim does not declare (the TS2339
 * on `TestUtils.waitForCondition`) is invisible at the patch boundary and
 * surfaces only in the downstream composed gate.
 */
describe('lint --per-patch checkJs over patch-owned test files', () => {
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

  it('without checkJsTestFiles the test file is never checked', async () => {
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
