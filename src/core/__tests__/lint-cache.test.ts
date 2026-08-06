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
  loadPerPatchLintCache,
  savePerPatchLintCache,
  setCachedPerPatchLintIssues,
} from '../lint-cache.js';
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

  it('invalidates when an affected engine file changes', async () => {
    const before = await key();
    await writeFiles(engineDir, { 'browser/a.js': 'const a = 2;\n' });

    await expect(key()).resolves.not.toBe(before);
  });

  it('engine-side content revert invalidates the per-patch cache (FORGE F5)', async () => {
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
    // FORGE G10: the waived measurement round-trips through the cache so a
    // warm run reports the same suppressed sizes as a cold one.
    expect(cached?.suppressed).toHaveLength(1);
    expect(cached?.lineCount).toBe(4200);

    await clearPerPatchLintCache(projectRoot);
    const cleared = await loadPerPatchLintCache(projectRoot);
    expect(getCachedPerPatchLintIssues(cleared, patch.filename, cacheKey)).toBeUndefined();
  });
});
