// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import {
  buildPerPatchLintCacheKey,
  clearPerPatchLintCache,
  getCachedPerPatchLintIssues,
  LINT_CACHE_SCHEMA_VERSION,
  loadPerPatchLintCache,
  savePerPatchLintCache,
  setCachedPerPatchLintIssues,
} from '../patch-lint-cache.js';
import { invalidateNewFileCreatorsCache, type PatchQueueContext } from '../patch-lint-cross.js';

describe('per-patch lint cache', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let patch: PatchMetadata;
  let config: FireForgeConfig;
  let ctx: PatchQueueContext;

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-lint-cache-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    patch = {
      filename: '001-ui-a.patch',
      order: 1,
      category: 'ui',
      name: 'a',
      description: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/a.js'],
    };
    config = { ...DEFAULT_CONFIG, patchLint: { testAssertionFloor: 'warning' } };
    ctx = {
      entries: [
        {
          filename: patch.filename,
          order: patch.order,
          metadata: patch,
          diff: [
            'diff --git a/browser/a.js b/browser/a.js',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/browser/a.js',
            '@@ -0,0 +1 @@',
            '+const a = 1;',
            '',
          ].join('\n'),
          newFiles: new Map([['browser/a.js', 'const a = 1;\n']]),
          createdFiles: new Set<string>(),
          modifiedFileAdditions: new Map(),
        },
      ],
    };
    await writeFiles(projectRoot, {
      'engine/browser/a.js': 'const a = 1;\n',
      'patches/001-ui-a.patch': ctx.entries[0]?.diff ?? '',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  async function key(
    overrides: {
      patch?: PatchMetadata;
      config?: FireForgeConfig;
      existingFiles?: string[];
      queueContext?: PatchQueueContext;
    } = {}
  ): Promise<string> {
    return buildPerPatchLintCacheKey({
      projectRoot,
      engineDir,
      patchesDir,
      patch: overrides.patch ?? patch,
      existingFiles: overrides.existingFiles ?? ['browser/a.js'],
      config: overrides.config ?? config,
      queueContext: overrides.queueContext ?? ctx,
      engineHeadSha: 'test-head-sha',
      packageVersion: 'test-version',
    });
  }

  it('invalidates when patch file content changes', async () => {
    const before = await key();
    await writeFiles(patchesDir, {
      '001-ui-a.patch': 'diff --git a/browser/a.js b/browser/a.js\n',
    });

    await expect(key()).resolves.not.toBe(before);
  });

  it('invalidates when relevant patch metadata changes', async () => {
    const before = await key();
    const changed: PatchMetadata = {
      ...patch,
      filesAffected: ['browser/a.js', 'browser/b.js'],
      lintIgnore: ['large-patch-lines'],
      stagedDependencies: {
        forwardImports: [
          {
            file: 'browser/a.js',
            specifier: 'resource:///modules/B.sys.mjs',
            creates: 'browser/B.sys.mjs',
            owner: '002-ui-b.patch',
          },
        ],
      },
      tier: 'branding',
    };

    await expect(key({ patch: changed, existingFiles: ['browser/a.js'] })).resolves.not.toBe(
      before
    );
  });

  it('invalidates when lintIgnore alone changes', async () => {
    // Isolated on purpose: the pre-existing metadata test changes four
    // fields at once, so nothing pinned the waiver field by itself. That is
    // the exact input whose omission would replay a pre-waiver verdict.
    const before = await key();
    const changed: PatchMetadata = { ...patch, lintIgnore: ['checkjs-type-error'] };
    await expect(key({ patch: changed })).resolves.not.toBe(before);
  });

  it('invalidates when an affected engine file changes', async () => {
    const before = await key();
    await writeFiles(engineDir, { 'browser/a.js': 'const a = 2;\n' });

    await expect(key()).resolves.not.toBe(before);
  });

  it('engine-side content revert invalidates the per-patch cache', async () => {
    // The cache-hit path in lint-per-patch returns before the empty-diff
    // probe. That is safe only because reverting an affected file (which
    // would empty the diff) always changes the file-content hash in the
    // key. This test pins that invariant.
    const dirty = await key();
    await writeFiles(engineDir, { 'browser/a.js': 'reverted to head content\n' });

    await expect(key()).resolves.not.toBe(dirty);
  });

  it('invalidates when the engine HEAD baseline changes', async () => {
    const before = await key();
    const after = await buildPerPatchLintCacheKey({
      projectRoot,
      engineDir,
      patchesDir,
      patch,
      existingFiles: ['browser/a.js'],
      config,
      queueContext: ctx,
      engineHeadSha: 'different-head-sha',
      packageVersion: 'test-version',
    });

    expect(after).not.toBe(before);
  });

  it('invalidates when relevant fireforge lint config changes', async () => {
    const before = await key();
    const changed: FireForgeConfig = {
      ...config,
      patchLint: { testAssertionFloor: 'error' },
    };

    await expect(key({ config: changed })).resolves.not.toBe(before);
  });

  it('invalidates when furnace.json or checkJs extra shim content changes', async () => {
    const withShim: FireForgeConfig = {
      ...config,
      patchLint: { checkJs: true, checkJsExtraShim: 'types/firefox-extra.d.ts' },
    };
    await writeFiles(projectRoot, {
      'furnace.json': JSON.stringify({ version: 1, stock: [], overrides: {}, custom: {} }),
      'types/firefox-extra.d.ts': 'declare var Extra: string;\n',
    });
    const before = await key({ config: withShim });

    await writeFiles(projectRoot, {
      'furnace.json': JSON.stringify({
        version: 1,
        tokenPrefix: '--my-',
        stock: [],
        overrides: {},
        custom: {},
      }),
      'types/firefox-extra.d.ts': 'declare var Extra: number;\n',
    });

    await expect(key({ config: withShim })).resolves.not.toBe(before);
  });

  it('invalidates when checkJs test shim content, path, or presence changes', async () => {
    const withTestShim: FireForgeConfig = {
      ...config,
      patchLint: {
        checkJs: true,
        checkJsTestFiles: true,
        checkJsTestShim: 'types/test-shim.d.ts',
      },
    };
    await writeFiles(projectRoot, {
      'types/test-shim.d.ts': 'declare var HominisTestHarness: string;\n',
    });
    const before = await key({ config: withTestShim });

    // Content edit in place: the adoption-workflow shape that replays stale
    // findings when the config block carries only the path.
    await writeFiles(projectRoot, {
      'types/test-shim.d.ts': 'declare var HominisTestHarness: number;\n',
    });
    const afterContentEdit = await key({ config: withTestShim });
    expect(afterContentEdit).not.toBe(before);

    // Path-only change (same content elsewhere) also invalidates.
    await writeFiles(projectRoot, {
      'types/renamed-shim.d.ts': 'declare var HominisTestHarness: number;\n',
    });
    const renamed: FireForgeConfig = {
      ...config,
      patchLint: {
        checkJs: true,
        checkJsTestFiles: true,
        checkJsTestShim: 'types/renamed-shim.d.ts',
      },
    };
    await expect(key({ config: renamed })).resolves.not.toBe(afterContentEdit);

    // Absent → present invalidates too.
    const withoutShim: FireForgeConfig = {
      ...config,
      patchLint: { checkJs: true, checkJsTestFiles: true },
    };
    await expect(key({ config: withoutShim })).resolves.not.toBe(afterContentEdit);
  });

  it('invalidates when queue ownership for affected JS files changes', async () => {
    const before = await key();
    const changedCtx: PatchQueueContext = {
      entries: [
        ...ctx.entries,
        {
          filename: '002-ui-a-copy.patch',
          order: 2,
          metadata: null,
          diff: ctx.entries[0]?.diff ?? '',
          newFiles: new Map([['browser/a.js', 'const a = 1;\n']]),
          createdFiles: new Set<string>(),
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    await expect(key({ queueContext: changedCtx })).resolves.not.toBe(before);
  });

  it('loads, reuses, and clears cached issues', async () => {
    const cacheKey = await key();
    const cache = await loadPerPatchLintCache(projectRoot);
    setCachedPerPatchLintIssues({
      cache,
      patchFilename: patch.filename,
      key: cacheKey,
      issues: [
        {
          file: 'browser/a.js',
          check: 'missing-modification-comment',
          message: 'marker missing',
          severity: 'warning',
        },
      ],
      suppressed: [
        {
          file: '(patch)',
          check: 'large-patch-lines',
          message: 'Patch is 4200 lines (hard limit: 3000).',
          severity: 'error',
        },
      ],
      lineCount: 4200,
    });
    await savePerPatchLintCache(projectRoot, cache);

    const loaded = await loadPerPatchLintCache(projectRoot);
    const cached = getCachedPerPatchLintIssues(loaded, patch.filename, cacheKey);
    expect(cached?.issues).toHaveLength(1);
    // The waived measurement round-trips through the cache so a
    // warm run reports the same suppressed sizes as a cold one.
    expect(cached?.suppressed).toHaveLength(1);
    expect(cached?.lineCount).toBe(4200);

    await clearPerPatchLintCache(projectRoot);
    const cleared = await loadPerPatchLintCache(projectRoot);
    expect(getCachedPerPatchLintIssues(cleared, patch.filename, cacheKey)).toBeUndefined();
  });

  it('refuses a cache hit whose waiver set differs, even on a matching key', async () => {
    const cacheKey = await key();
    const cache = await loadPerPatchLintCache(projectRoot);
    const issue = {
      file: 'browser/a.js',
      check: 'checkjs-type-error',
      message: 'implicit any',
      severity: 'error' as const,
    };
    // Entry computed with no waiver in force.
    setCachedPerPatchLintIssues({
      cache,
      patchFilename: patch.filename,
      key: cacheKey,
      issues: [issue],
      suppressed: [],
      lineCount: 10,
      lintIgnore: [],
    });
    await savePerPatchLintCache(projectRoot, cache);
    const loaded = await loadPerPatchLintCache(projectRoot);

    // Same key, same waiver set: replayed.
    expect(getCachedPerPatchLintIssues(loaded, patch.filename, cacheKey, [])?.issues).toHaveLength(
      1
    );
    // Same key, but a waiver written since: this must miss rather than
    // replay the pre-waiver verdict the operator just waived.
    expect(
      getCachedPerPatchLintIssues(loaded, patch.filename, cacheKey, ['checkjs-type-error'])
    ).toBeUndefined();
    // Order and duplicates are not significant.
    setCachedPerPatchLintIssues({
      cache,
      patchFilename: patch.filename,
      key: cacheKey,
      issues: [issue],
      suppressed: [],
      lineCount: 10,
      lintIgnore: ['b', 'a', 'a'],
    });
    expect(getCachedPerPatchLintIssues(cache, patch.filename, cacheKey, ['a', 'b'])).toBeDefined();
  });

  it('discards pre-schema-4 entries that carry no recorded waiver set', async () => {
    const cacheKey = await key();
    await writeFiles(projectRoot, {
      '.fireforge/lint-cache/per-patch-v1.json': JSON.stringify({
        schemaVersion: LINT_CACHE_SCHEMA_VERSION,
        entries: {
          [patch.filename]: {
            key: cacheKey,
            patchFilename: patch.filename,
            issues: [],
            suppressed: [],
            lineCount: 1,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    });
    const loaded = await loadPerPatchLintCache(projectRoot);
    expect(loaded.entries[patch.filename]).toBeUndefined();
  });
});

describe('per-patch lint cache: the checkJs world', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  const checkJsConfig: FireForgeConfig = {
    ...DEFAULT_CONFIG,
    patchLint: { checkJs: true, checkJsTestFiles: true },
  };

  function creating(
    filename: string,
    order: number,
    files: string[]
  ): PatchQueueContext['entries'][number] {
    const diff = files
      .map((file) =>
        [
          `diff --git a/${file} b/${file}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${file}`,
          '@@ -0,0 +1 @@',
          '+export {};',
          '',
        ].join('\n')
      )
      .join('');
    return {
      filename,
      order,
      metadata: null,
      diff,
      newFiles: new Map(files.map((file) => [file, 'export {};\n'])),
      createdFiles: new Set(files),
      modifiedFileAdditions: new Map(),
    };
  }

  /** A fresh context per call: one context is one run's snapshot. */
  function queue(order: 'forward' | 'reversed' = 'forward'): PatchQueueContext {
    const entries = [
      creating('001-ui-a.patch', 1, ['browser/modules/A.sys.mjs', 'browser/test/head.js']),
      creating('002-ui-b.patch', 2, ['browser/modules/B.sys.mjs', 'browser/test/browser_b.js']),
      creating('003-ui-plain.patch', 3, ['browser/plain.css']),
    ];
    return { entries: order === 'forward' ? entries : [...entries].reverse() };
  }

  function patchB(): PatchMetadata {
    return {
      filename: '002-ui-b.patch',
      order: 2,
      category: 'ui',
      name: 'b',
      description: 'b',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['browser/modules/B.sys.mjs', 'browser/test/browser_b.js'],
    };
  }

  async function keyFor(
    options: {
      ctx?: PatchQueueContext;
      config?: FireForgeConfig;
      patch?: PatchMetadata;
    } = {}
  ): Promise<string> {
    const patch = options.patch ?? patchB();
    return buildPerPatchLintCacheKey({
      projectRoot,
      engineDir,
      patchesDir,
      patch,
      existingFiles: patch.filesAffected,
      config: options.config ?? checkJsConfig,
      queueContext: options.ctx ?? queue(),
      engineHeadSha: 'test-head-sha',
      packageVersion: 'test-version',
    });
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-lint-cache-checkjs-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await writeFiles(projectRoot, {
      'engine/browser/modules/A.sys.mjs': 'export const a = 1;\n',
      'engine/browser/modules/B.sys.mjs': 'export const b = 2;\n',
      'engine/browser/test/head.js': 'function helper() {}\n',
      'engine/browser/test/browser_b.js': 'add_task(async () => helper());\n',
      'engine/browser/plain.css': ':root {}\n',
      'engine/toolkit/content/widgets/moz-x/moz-x.mjs': 'export default class {}\n',
      'patches/002-ui-b.patch': queue().entries[1]?.diff ?? '',
      'patches/003-ui-plain.patch': queue().entries[2]?.diff ?? '',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it("misses when another patch's module changes, and hits again once it is restored", async () => {
    const before = await keyFor();
    await writeFiles(engineDir, { 'browser/modules/A.sys.mjs': 'export const a = "x";\n' });
    const edited = await keyFor();
    expect(edited).not.toBe(before);

    await writeFiles(engineDir, { 'browser/modules/A.sys.mjs': 'export const a = 1;\n' });
    await expect(keyFor()).resolves.toBe(before);
  });

  it("misses when another patch's test head changes", async () => {
    const before = await keyFor();
    await writeFiles(engineDir, { 'browser/test/head.js': 'function helper2() {}\n' });
    await expect(keyFor()).resolves.not.toBe(before);
  });

  it('misses when the queue is reordered', async () => {
    const before = await keyFor();
    await expect(keyFor({ ctx: queue('reversed') })).resolves.not.toBe(before);
  });

  it('misses when a `paths` target changes', async () => {
    const config: FireForgeConfig = {
      ...DEFAULT_CONFIG,
      patchLint: {
        checkJs: true,
        checkJsStrict: true,
        checkJsCompilerOptions: {
          paths: { 'chrome://global/content/elements/*': ['toolkit/content/widgets/*'] },
        },
      },
    };
    const before = await keyFor({ config });
    await writeFiles(engineDir, {
      'toolkit/content/widgets/moz-x/moz-x.mjs': 'export default class X {}\n',
    });
    await expect(keyFor({ config })).resolves.not.toBe(before);
  });

  it('leaves a patch with no checkJs-relevant file out of the checkJs world', async () => {
    const plain: PatchMetadata = {
      ...patchB(),
      filename: '003-ui-plain.patch',
      order: 3,
      filesAffected: ['browser/plain.css'],
    };
    const before = await keyFor({ patch: plain });
    await writeFiles(engineDir, { 'browser/modules/A.sys.mjs': 'export const a = "x";\n' });
    await expect(keyFor({ patch: plain })).resolves.toBe(before);
    await expect(keyFor({ patch: plain, ctx: queue('reversed') })).resolves.toBe(before);
  });

  it('keeps the checkJs world out of the key when checkJs is off', async () => {
    const config: FireForgeConfig = { ...DEFAULT_CONFIG, patchLint: {} };
    const before = await keyFor({ config });
    await writeFiles(engineDir, { 'browser/modules/A.sys.mjs': 'export const a = "x";\n' });
    await expect(keyFor({ config })).resolves.toBe(before);
  });

  it("recomputes the queue part after an in-place entry update, reusing the run's hashes", async () => {
    const ctx = queue();
    const before = await keyFor({ ctx });
    const entry = ctx.entries[0];
    if (!entry) throw new Error('fixture');
    Object.assign(entry, creating('001-ui-a.patch', 1, ['browser/modules/A.sys.mjs']));
    invalidateNewFileCreatorsCache(ctx);
    await expect(keyFor({ ctx })).resolves.not.toBe(before);
  });
});
