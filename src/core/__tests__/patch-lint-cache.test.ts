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
import type { PatchQueueContext } from '../patch-lint-cross.js';

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
    // fields at once, so nothing pinned the waiver field by itself — the
    // exact input whose omission would replay a pre-waiver verdict.
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
    // The cache-hit path in lint-per-patch returns BEFORE the empty-diff
    // probe. That is safe only because reverting an affected file (which
    // would empty the diff) always changes the file-content hash in the
    // key — this test pins that invariant.
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

    // Content edit in place — the adoption-workflow shape that replays stale
    // findings when the config block carries only the PATH.
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
          modifiedFileAdditions: new Map(),
        },
      ],
    };

    await expect(key({ queueContext: changedCtx })).resolves.not.toBe(before);
  });

  it('loads, reuses, and clears cached issues', async () => {
    const cacheKey = await key();
    const cache = await loadPerPatchLintCache(projectRoot);
    setCachedPerPatchLintIssues(
      cache,
      patch.filename,
      cacheKey,
      [
        {
          file: 'browser/a.js',
          check: 'missing-modification-comment',
          message: 'marker missing',
          severity: 'warning',
        },
      ],
      [
        {
          file: '(patch)',
          check: 'large-patch-lines',
          message: 'Patch is 4200 lines (hard limit: 3000).',
          severity: 'error',
        },
      ],
      4200
    );
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
    // Entry computed with NO waiver in force.
    setCachedPerPatchLintIssues(cache, patch.filename, cacheKey, [issue], [], 10, []);
    await savePerPatchLintCache(projectRoot, cache);
    const loaded = await loadPerPatchLintCache(projectRoot);

    // Same key, same waiver set — replayed.
    expect(getCachedPerPatchLintIssues(loaded, patch.filename, cacheKey, [])?.issues).toHaveLength(
      1
    );
    // Same key, a waiver written since — must MISS rather than replay the
    // pre-waiver verdict the operator just waived.
    expect(
      getCachedPerPatchLintIssues(loaded, patch.filename, cacheKey, ['checkjs-type-error'])
    ).toBeUndefined();
    // Order and duplicates are not significant.
    setCachedPerPatchLintIssues(cache, patch.filename, cacheKey, [issue], [], 10, ['b', 'a', 'a']);
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
