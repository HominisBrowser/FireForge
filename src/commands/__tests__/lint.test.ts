// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: nativePath('/project/engine'),
    config: nativePath('/project/fireforge.json'),
    fireforgeDir: nativePath('/project/.fireforge'),
    state: nativePath('/project/.fireforge/state.json'),
    patches: nativePath('/project/patches'),
    configs: nativePath('/project/configs'),
    src: nativePath('/project/src'),
    componentsDir: nativePath('/project/components'),
  })),
  loadConfig: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../core/git.js', () => ({
  // Engine-precondition ladder (assertEngineGitReady). Stubbed to the
  // healthy-engine answers so these suites test their own subject.
  getHead: vi.fn(() => Promise.resolve('0'.repeat(40))),
  isMissingHeadError: vi.fn(() => false),

  isGitRepository: vi.fn(() => Promise.resolve(true)),
  hasChanges: vi.fn(() => Promise.resolve(true)),
  getStatusWithCodes: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/git-diff.js', () => ({
  getAllDiff: vi.fn(() => Promise.resolve('diff content')),
  getDiffForFilesAgainstHead: vi.fn(() => Promise.resolve('diff content')),
}));

vi.mock('../../core/git-status.js', () => ({
  resolveMaxUntrackedFilesPerDir: vi.fn(() => 5000),
  getModifiedFiles: vi.fn(() => Promise.resolve([])),
  getModifiedFilesInDir: vi.fn(() => Promise.resolve([])),
  getUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getUntrackedFilesInDir: vi.fn(() => Promise.resolve([])),
  getWorkingTreeStatus: vi.fn(() => Promise.resolve([])),
  expandUntrackedDirectoryEntries: vi.fn((_dir: string, entries: unknown[]) =>
    Promise.resolve(entries)
  ),
}));

vi.mock('../../core/branding.js', () => ({
  // Pass-through branding check that maps `browser/branding/<binary>/`
  // to true; the aggregate-mode exclusion uses this to partition the
  // dirty tree into lintable vs tool-managed branding buckets.
  isBrandingManagedPath: vi.fn((path: string, binaryName: string) =>
    path.startsWith(`browser/branding/${binaryName}/`)
  ),
}));

// Mock furnace-config so lint can import collectFurnaceManagedPrefixes
// without dragging in the real furnace.json loader (which would trip the
// FIREFORGE_DIR import on the test config mock).
vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  collectFurnaceManagedPrefixes: vi.fn(() => Promise.resolve(new Set<string>())),
}));

vi.mock('../../core/patch-apply.js', () => ({
  extractAffectedFiles: vi.fn(() => []),
}));

vi.mock('../../core/patch-lint.js', () => ({
  formatPatchLintIssue: vi.fn(
    (issue: { check: string; file: string; message: string }) =>
      `[${issue.check}] ${issue.file}: ${issue.message}`
  ),
  lintExportedPatch: vi.fn(() => Promise.resolve([])),
  buildPatchQueueContext: vi.fn(() => Promise.resolve({ entries: [] })),
  lintPatchQueue: vi.fn(() => []),
  resolvePatchSizeTier: vi.fn(() => ({ tier: 'general' })),
  countNonBinaryDiffLines: vi.fn(() => ({ total: 42, textLines: 42 })),
  getPatchSizeThresholds: vi.fn(() => ({
    lines: { notice: 800, warning: 1500, error: 3000 },
    maxFiles: 5,
  })),
}));

vi.mock('../../core/patch-lint-cache.js', () => ({
  buildPerPatchLintCacheKey: vi.fn(() => Promise.resolve('cache-key')),
  clearPerPatchLintCache: vi.fn(() => Promise.resolve()),
  getCachedPerPatchLintIssues: vi.fn(() => undefined),
  getPerPatchLintCacheHeadSha: vi.fn(() => Promise.resolve('test-head-sha')),
  loadPerPatchLintCache: vi.fn(() => Promise.resolve({ schemaVersion: 1, entries: {} })),
  savePerPatchLintCache: vi.fn(() => Promise.resolve()),
  setCachedPerPatchLintIssues: vi.fn(),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../core/patch-lint-diff-tag.js', () => ({
  collectDiffFilePaths: vi.fn(() => Promise.resolve(new Set<string>())),
  tagLintIssues: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { getStatusWithCodes, hasChanges } from '../../core/git.js';
import { getAllDiff, getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import {
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
  getWorkingTreeStatus,
} from '../../core/git-status.js';
import {
  buildPatchQueueContext,
  lintExportedPatch,
  lintPatchQueue,
} from '../../core/patch-lint.js';
import type { PerPatchLintCacheFile } from '../../core/patch-lint-cache.js';
import {
  buildPerPatchLintCacheKey,
  clearPerPatchLintCache,
  getCachedPerPatchLintIssues,
  getPerPatchLintCacheHeadSha,
  loadPerPatchLintCache,
  savePerPatchLintCache,
  setCachedPerPatchLintIssues,
} from '../../core/patch-lint-cache.js';
import { collectDiffFilePaths, tagLintIssues } from '../../core/patch-lint-diff-tag.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { GeneralError } from '../../errors/base.js';
import { makeManifest, nativePath } from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { applyAggregateLintIgnoreSuppression, lintCommand, registerLint } from '../lint.js';

function fakeStats(overrides: Partial<Stats>): Stats {
  return { isDirectory: () => false, isFile: () => true, ...overrides } as Stats;
}

describe('lintCommand — branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(getAllDiff).mockResolvedValue('diff content');
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
    vi.mocked(lintExportedPatch).mockResolvedValue([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);
  });

  it('collects files from a directory input', async () => {
    vi.mocked(stat).mockResolvedValue(fakeStats({ isDirectory: () => true }));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['src/app.ts']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['src/new.ts']);

    await lintCommand('/project', ['src']);

    expect(getModifiedFilesInDir).toHaveBeenCalledWith(nativePath('/project/engine'), 'src');
    expect(getUntrackedFilesInDir).toHaveBeenCalledWith(nativePath('/project/engine'), 'src');
    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith(nativePath('/project/engine'), [
      'src/app.ts',
      'src/new.ts',
    ]);
  });

  it('strips trailing slash from directory path', async () => {
    vi.mocked(stat).mockResolvedValue(fakeStats({ isDirectory: () => true }));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['src/app.ts']);

    await lintCommand('/project', ['src/']);

    expect(getModifiedFilesInDir).toHaveBeenCalledWith(nativePath('/project/engine'), 'src');
  });

  it('falls back to file lookup when stat throws', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'missing.ts' }]);

    await lintCommand('/project', ['missing.ts']);

    expect(getStatusWithCodes).toHaveBeenCalled();
    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith(nativePath('/project/engine'), [
      'missing.ts',
    ]);
  });

  it('loads file statuses only once for multiple file inputs', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'a.ts' },
      { status: 'M', file: 'b.ts' },
    ]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);

    await lintCommand('/project', ['a.ts', 'b.ts']);

    // Should call getStatusWithCodes only once despite two file inputs
    expect(getStatusWithCodes).toHaveBeenCalledTimes(1);
    expect(getUntrackedFiles).toHaveBeenCalledTimes(1);
  });

  it('reports nothing to lint when no specified files have status', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([]);

    await lintCommand('/project', ['clean.ts']);

    expect(vi.mocked(info)).toHaveBeenCalledWith('No modified files found in the specified paths.');
  });

  it('reports nothing to lint when diff is empty', async () => {
    vi.mocked(getAllDiff).mockResolvedValue('   \n  ');

    await lintCommand('/project', []);

    expect(vi.mocked(info)).toHaveBeenCalledWith('No diff content to lint.');
  });

  it('reports nothing to lint when there are no changes', async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);

    await lintCommand('/project', []);

    expect(vi.mocked(info)).toHaveBeenCalledWith('No changes to lint.');
  });

  it('passes lint with no issues', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([]);

    await lintCommand('/project', []);

    expect(vi.mocked(success)).toHaveBeenCalledWith('No lint issues found.');
  });

  it('throws GeneralError when there are lint errors', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([
      { severity: 'error', check: 'license', file: 'a.ts', message: 'Missing license' },
    ]);

    await expect(lintCommand('/project', [])).rejects.toBeInstanceOf(GeneralError);
  });

  it('passes with warnings only', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([
      { severity: 'warning', check: 'jsdoc', file: 'a.ts', message: 'Missing JSDoc' },
    ]);

    await lintCommand('/project', []);

    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Missing JSDoc'));
    expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint passed with warnings');
  });

  it('reports both errors and warnings, then throws', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([
      { severity: 'warning', check: 'jsdoc', file: 'a.ts', message: 'Missing JSDoc' },
      { severity: 'error', check: 'license', file: 'b.ts', message: 'Missing license' },
    ]);

    await expect(lintCommand('/project', [])).rejects.toBeInstanceOf(GeneralError);
    // Both warn calls should have been made before the throw
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Missing JSDoc'));
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Missing license'));
  });

  it('throws when engine path does not exist', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(lintCommand('/project', [])).rejects.toThrow('Firefox source not found');
  });

  describe('--only-introduced', () => {
    it('rejects --only-introduced without --since up-front', async () => {
      await expect(lintCommand('/project', [], { onlyIntroduced: true })).rejects.toThrow(
        /requires --since/
      );
      // Must abort before any git probe runs so a misconfigured CI exits
      // with a clear message rather than silently treating every error as
      // cumulative.
      expect(lintExportedPatch).not.toHaveBeenCalled();
    });

    it('passes lint when cumulative errors exist but no issues are tagged introduced', async () => {
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'raw-color',
          file: 'unrelated.css',
          message: 'raw color value',
          tag: 'cumulative',
        },
      ]);
      // tagLintIssues is normally what stamps the tag — mock it to be a
      // no-op so the resolved value above flows through unchanged.
      vi.mocked(tagLintIssues).mockImplementation((issues) => issues);
      vi.mocked(collectDiffFilePaths).mockResolvedValue(new Set());

      // With --only-introduced set and no issues tagged introduced, exit
      // code should be clean.
      await expect(
        lintCommand('/project', [], { since: 'main', onlyIntroduced: true })
      ).resolves.toBeUndefined();
      expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint passed with warnings');
    });

    it('fails lint when an introduced error exists, even if cumulative ones also exist', async () => {
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'license-header',
          file: 'old.ts',
          message: 'missing header',
          tag: 'cumulative',
        },
        {
          severity: 'error',
          check: 'raw-color',
          file: 'new.ts',
          message: 'raw color',
          tag: 'introduced',
        },
      ]);
      vi.mocked(tagLintIssues).mockImplementation((issues) => issues);
      vi.mocked(collectDiffFilePaths).mockResolvedValue(new Set(['new.ts']));

      await expect(
        lintCommand('/project', [], { since: 'main', onlyIntroduced: true })
      ).rejects.toThrow(/introduced error/);
    });

    it('still fails lint when an introduced error is the only tagged error', async () => {
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'raw-color',
          file: 'new.ts',
          message: 'raw color',
          tag: 'introduced',
        },
      ]);
      vi.mocked(tagLintIssues).mockImplementation((issues) => issues);
      vi.mocked(collectDiffFilePaths).mockResolvedValue(new Set(['new.ts']));

      await expect(
        lintCommand('/project', [], { since: 'main', onlyIntroduced: true })
      ).rejects.toThrow(/introduced error/);
    });

    it('reports cumulative errors as suppressed in the failure message when introduced errors trigger the failure', async () => {
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'a',
          file: 'x.ts',
          message: 'm',
          tag: 'cumulative',
        },
        {
          severity: 'error',
          check: 'b',
          file: 'y.ts',
          message: 'n',
          tag: 'cumulative',
        },
        {
          severity: 'error',
          check: 'c',
          file: 'z.ts',
          message: 'o',
          tag: 'introduced',
        },
      ]);
      vi.mocked(tagLintIssues).mockImplementation((issues) => issues);
      vi.mocked(collectDiffFilePaths).mockResolvedValue(new Set(['z.ts']));

      await expect(
        lintCommand('/project', [], { since: 'main', onlyIntroduced: true })
      ).rejects.toThrow(/cumulative error\(s\) suppressed by --only-introduced/);
    });

    it('keeps the classic exit-code semantics when --only-introduced is not set', async () => {
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'raw-color',
          file: 'unrelated.css',
          message: 'raw color',
          tag: 'cumulative',
        },
      ]);
      vi.mocked(tagLintIssues).mockImplementation((issues) => issues);
      vi.mocked(collectDiffFilePaths).mockResolvedValue(new Set());

      // Without --only-introduced the cumulative error still fails lint so
      // operators keep the pre-flag behaviour unchanged.
      await expect(lintCommand('/project', [], { since: 'main' })).rejects.toThrow(
        /Patch lint found 1 error/
      );
    });
  });

  describe('aggregate-mode NOTE for patch-size rules', () => {
    it('prints the --per-patch hint and downgrades size rules to warnings on a multi-patch queue', async () => {
      // Aggregate-mode on a multi-patch queue should:
      // - still print the NOTE pointing at `--per-patch`
      // - downgrade `large-patch-lines` / `large-patch-files` from error to
      //   warning so the command exits zero (operators use `--per-patch` for
      //   authoritative per-patch error detection).
      vi.mocked(buildPatchQueueContext).mockResolvedValue({
        entries: [{ filename: 'a.patch' }, { filename: 'b.patch' }] as unknown as Awaited<
          ReturnType<typeof buildPatchQueueContext>
        >['entries'],
      });
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'large-patch-lines',
          file: '(patch)',
          message: 'Patch is 37529 lines',
        },
      ]);

      await expect(lintCommand('/project', [])).resolves.toBeUndefined();

      expect(vi.mocked(info)).toHaveBeenCalledWith(
        expect.stringContaining('aggregate diff across all applied patches')
      );
    });

    it('omits the hint when explicit file paths scope the diff', async () => {
      vi.mocked(stat).mockResolvedValue(fakeStats({ isDirectory: () => true }));
      vi.mocked(getModifiedFilesInDir).mockResolvedValue(['src/app.ts']);
      vi.mocked(buildPatchQueueContext).mockResolvedValue({
        entries: [{ filename: 'a.patch' }, { filename: 'b.patch' }] as unknown as Awaited<
          ReturnType<typeof buildPatchQueueContext>
        >['entries'],
      });
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'large-patch-lines',
          file: '(patch)',
          message: 'Patch is 37529 lines',
        },
      ]);

      await expect(lintCommand('/project', ['src'])).rejects.toThrow(/Patch lint found 1 error/);

      expect(vi.mocked(info)).not.toHaveBeenCalledWith(
        expect.stringContaining('aggregate diff across all applied patches')
      );
    });

    it('omits the hint when the queue has only one patch (no aggregation artefact)', async () => {
      vi.mocked(buildPatchQueueContext).mockResolvedValue({
        entries: [{ filename: 'a.patch' }] as unknown as Awaited<
          ReturnType<typeof buildPatchQueueContext>
        >['entries'],
      });
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'large-patch-lines',
          file: '(patch)',
          message: 'Patch is 4000 lines',
        },
      ]);

      await expect(lintCommand('/project', [])).rejects.toThrow(/Patch lint found 1 error/);

      expect(vi.mocked(info)).not.toHaveBeenCalledWith(
        expect.stringContaining('aggregate diff across all applied patches')
      );
    });
  });

  describe('--per-patch', () => {
    let memoryCache: PerPatchLintCacheFile;

    function makePatch(filename: string, filesAffected: string[]): PatchMetadata {
      return {
        filename,
        order: parseInt(filename.split('-')[0] ?? '0', 10),
        category: 'ui' as const,
        name: 'test',
        description: '',
        createdAt: new Date().toISOString(),
        sourceEsrVersion: '140.9.0esr',
        filesAffected,
      };
    }

    beforeEach(() => {
      // Literal (not the imported constant): this module is fully vi.mock'd,
      // so the real LINT_CACHE_SCHEMA_VERSION value is unavailable at runtime.
      memoryCache = { schemaVersion: 4, entries: {} };
      vi.mocked(loadPerPatchLintCache).mockResolvedValue(memoryCache);
      vi.mocked(getPerPatchLintCacheHeadSha).mockResolvedValue('test-head-sha');
      vi.mocked(buildPerPatchLintCacheKey).mockImplementation((input) =>
        Promise.resolve(`key:${input.patch.filename}`)
      );
      vi.mocked(getCachedPerPatchLintIssues).mockImplementation(
        (cache, filename, key, lintIgnore) => {
          const entry = cache.entries[filename];
          if (!entry || entry.key !== key) return undefined;
          const expected = [...new Set(lintIgnore ?? [])].sort();
          const stored = [...new Set(entry.lintIgnore)].sort();
          if (expected.length !== stored.length || expected.some((id, i) => id !== stored[i])) {
            return undefined;
          }
          return {
            issues: entry.issues.map((issue) => ({ ...issue })),
            suppressed: entry.suppressed.map((issue) => ({ ...issue })),
            lineCount: entry.lineCount,
          };
        }
      );
      vi.mocked(setCachedPerPatchLintIssues).mockImplementation(
        (cache, filename, key, issues, suppressed, lineCount, lintIgnore) => {
          cache.entries[filename] = {
            key,
            patchFilename: filename,
            issues: issues.map((issue) => ({ ...issue })),
            suppressed: suppressed.map((issue) => ({ ...issue })),
            lineCount,
            lintIgnore: [...new Set(lintIgnore ?? [])].sort(),
            updatedAt: '2026-01-01T00:00:00.000Z',
          };
        }
      );
      vi.mocked(savePerPatchLintCache).mockResolvedValue();
      vi.mocked(clearPerPatchLintCache).mockResolvedValue();
    });

    it('positional patch names select the per-patch subset like --patches', async () => {
      const a = makePatch('001-ui-a.patch', ['a.ts']);
      const b = makePatch('002-ui-b.patch', ['b.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([a, b]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(
        lintCommand('/project', ['001-ui-a.patch'], { perPatch: true })
      ).resolves.toBeUndefined();

      expect(lintExportedPatch).toHaveBeenCalledTimes(1);
    });

    it('a non-matching positional in per-patch mode fails loud naming the selection rules', async () => {
      const a = makePatch('001-ui-a.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([a]));
      vi.mocked(pathExists).mockResolvedValue(true);

      await expect(
        lintCommand('/project', ['browser/themes/x.css'], { perPatch: true })
      ).rejects.toThrow(
        /No patch in the queue matches "browser\/themes\/x\.css".*drop --per-patch to lint engine paths/s
      );
    });

    it('rejects --patches without --per-patch', async () => {
      await expect(lintCommand('/project', [], { patches: ['001-foo.patch'] })).rejects.toThrow(
        /--patches requires --per-patch/
      );
    });

    it('short-circuits cleanly when the manifest is empty', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([]));

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(vi.mocked(info)).toHaveBeenCalledWith(
        'No patches in manifest — nothing to lint per-patch.'
      );
      expect(lintExportedPatch).not.toHaveBeenCalled();
    });

    it('lints each patch in isolation and forwards its lintIgnore set', async () => {
      const a = makePatch('001-ui-a.patch', ['a.ts']);
      const b = makePatch('002-ui-b.patch', ['b.ts']);
      b.lintIgnore = ['large-patch-lines'];
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([a, b]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(lintExportedPatch).toHaveBeenCalledTimes(2);
      const firstCall = vi.mocked(lintExportedPatch).mock.calls[0];
      const secondCall = vi.mocked(lintExportedPatch).mock.calls[1];
      // First patch has no lintIgnore — the member is absent entirely
      expect(firstCall?.[4]?.ignoreChecks).toBeUndefined();
      // Second patch has lintIgnore — Set containing its entry
      const ignore = secondCall?.[4]?.ignoreChecks;
      expect(ignore).toBeInstanceOf(Set);
      expect(ignore?.has('large-patch-lines')).toBe(true);
    });

    it('accepts comma lists, full filenames, category-prefixed slugs, and bare slugs in --patches', async () => {
      const a = makePatch('001-ui-a.patch', ['a.ts']);
      const b = makePatch('002-ui-b.patch', ['b.ts']);
      const c = makePatch('003-infra-c.patch', ['c.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([a, b, c]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(
        lintCommand('/project', [], {
          perPatch: true,
          patches: ['ui-a,002-ui-b.patch', 'c'],
        })
      ).resolves.toBeUndefined();

      expect(lintExportedPatch).toHaveBeenCalledTimes(3);
    });

    it('forwards patch.tier to lintExportedPatch as the 7th arg', async () => {
      // A branding patch that also touches a non-allowlisted sibling
      // declares `tier: "branding"` in patches.json so `lint --per-patch`
      // applies the branding thresholds. Without the forwarding, per-patch
      // lint refires `large-patch-lines` at 3000 even though the operator
      // explicitly declared branding shape.
      const plain = makePatch('001-ui-a.patch', ['a.ts']);
      const branded = makePatch('002-branding-full.patch', [
        'browser/branding/custom/logo.png',
        'browser/themes/custom-shared/tokens.css',
      ]);
      branded.tier = 'branding';
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([plain, branded]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(lintExportedPatch).toHaveBeenCalledTimes(2);
      const firstCall = vi.mocked(lintExportedPatch).mock.calls[0];
      const secondCall = vi.mocked(lintExportedPatch).mock.calls[1];
      expect(firstCall?.[4]?.patchTier).toBeUndefined();
      expect(secondCall?.[4]).toEqual(expect.objectContaining({ patchTier: 'branding' }));
    });

    it('populates the per-patch lint cache on the first run', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(loadPerPatchLintCache).toHaveBeenCalledWith('/project');
      expect(buildPerPatchLintCacheKey).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRoot: '/project',
          engineDir: nativePath('/project/engine'),
          patchesDir: nativePath('/project/patches'),
          patch,
          existingFiles: ['a.ts'],
          engineHeadSha: 'test-head-sha',
        })
      );
      expect(setCachedPerPatchLintIssues).toHaveBeenCalledWith(
        memoryCache,
        '001-ui-test.patch',
        'key:001-ui-test.patch',
        [],
        [],
        42,
        []
      );
      expect(savePerPatchLintCache).toHaveBeenCalledWith('/project', memoryCache);
    });

    it('reuses the per-patch lint cache on the second identical run', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'notice',
          check: 'file-too-large',
          file: 'a.ts',
          message: 'notice',
        },
      ]);

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();
      vi.mocked(lintExportedPatch).mockClear();
      vi.mocked(info).mockClear();

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(lintExportedPatch).not.toHaveBeenCalled();
      expect(getDiffForFilesAgainstHead).toHaveBeenCalledTimes(1);
      expect(vi.mocked(info)).toHaveBeenCalledWith('Reused lint cache for 1 patch.');
      expect(vi.mocked(info)).toHaveBeenCalledWith(
        'NOTICE [file-too-large] 001-ui-test.patch :: a.ts: notice'
      );
    });

    it('--no-cache bypasses per-patch cache reads and writes', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(
        lintCommand('/project', [], { perPatch: true, noCache: true })
      ).resolves.toBeUndefined();

      expect(loadPerPatchLintCache).not.toHaveBeenCalled();
      expect(buildPerPatchLintCacheKey).not.toHaveBeenCalled();
      expect(getCachedPerPatchLintIssues).not.toHaveBeenCalled();
      expect(setCachedPerPatchLintIssues).not.toHaveBeenCalled();
      expect(savePerPatchLintCache).not.toHaveBeenCalled();
      expect(lintExportedPatch).toHaveBeenCalledTimes(1);
    });

    it('cached warnings still fail per-patch lint when they exceed --max-warnings', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      memoryCache.entries[patch.filename] = {
        key: `key:${patch.filename}`,
        patchFilename: patch.filename,
        issues: [
          {
            severity: 'warning',
            check: 'large-patch-files',
            file: '(patch)',
            message: 'Patch affects 8 files',
          },
        ],
        suppressed: [],
        lineCount: 42,
        lintIgnore: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      await expect(lintCommand('/project', [], { perPatch: true, maxWarnings: 0 })).rejects.toThrow(
        /exceeding --max-warnings 0/
      );

      expect(lintExportedPatch).not.toHaveBeenCalled();
      expect(getDiffForFilesAgainstHead).not.toHaveBeenCalled();
      expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint failed');
    });

    it('namespaces issues with the patch filename so triage can attribute findings', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'error',
          check: 'relative-import',
          file: 'a.ts',
          message: 'bad import',
        },
      ]);

      await expect(lintCommand('/project', [], { perPatch: true })).rejects.toThrow(
        /found 1 error/
      );

      expect(vi.mocked(warn)).toHaveBeenCalledWith(
        'ERROR [relative-import] 001-ui-test.patch :: a.ts: bad import'
      );
    });

    it('fails per-patch lint when warnings exceed --max-warnings', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'warning',
          check: 'large-patch-files',
          file: '(patch)',
          message: 'Patch affects 8 files',
        },
      ]);

      await expect(lintCommand('/project', [], { perPatch: true, maxWarnings: 0 })).rejects.toThrow(
        /exceeding --max-warnings 0/
      );

      expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint failed');
    });

    it('passes per-patch lint when warnings are within --max-warnings', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'warning',
          check: 'large-patch-files',
          file: '(patch)',
          message: 'Patch affects 8 files',
        },
      ]);

      await expect(
        lintCommand('/project', [], { perPatch: true, maxWarnings: 1 })
      ).resolves.toBeUndefined();

      expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint passed with warnings');
    });

    it('keeps per-patch warnings advisory by default', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      vi.mocked(lintExportedPatch).mockResolvedValue([
        {
          severity: 'warning',
          check: 'large-patch-files',
          file: '(patch)',
          message: 'Patch affects 8 files',
        },
      ]);

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint passed with warnings');
    });

    it('still runs cross-patch rules once over the whole queue context', async () => {
      const a = makePatch('001-ui-a.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([a]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(lintPatchQueue).toHaveBeenCalledTimes(1);
    });

    it('still runs cross-patch rules when per-patch results come from cache', async () => {
      const patch = makePatch('001-ui-test.patch', ['a.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      memoryCache.entries[patch.filename] = {
        key: `key:${patch.filename}`,
        patchFilename: patch.filename,
        issues: [],
        suppressed: [],
        lineCount: 42,
        lintIgnore: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(lintExportedPatch).not.toHaveBeenCalled();
      expect(getDiffForFilesAgainstHead).not.toHaveBeenCalled();
      expect(lintPatchQueue).toHaveBeenCalledTimes(1);
    });

    it('skips a patch whose filesAffected are all missing on disk', async () => {
      const patch = makePatch('001-ui-test.patch', ['missing.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([patch]));
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p.endsWith(nativePath('/missing.ts'))) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(lintExportedPatch).not.toHaveBeenCalled();
      // The success line names the skipped patch count so operators can tell
      // "queue clean" from "queue not yet applied".
      expect(vi.mocked(success)).toHaveBeenCalledWith(
        expect.stringContaining('No lint issues found across 0 patch(es) (1 skipped')
      );
    });

    it('points at fireforge import when the entire queue is unapplied', async () => {
      // An unapplied queue otherwise produces `No lint issues found across 0
      // patch(es).` with no hint that *nothing* was linted. The info banner
      // names the missing prerequisite (`fireforge import`) so the success
      // line reads as structurally meaningful rather than a clean bill of
      // health.
      const a = makePatch('001-ui-a.patch', ['a.ts']);
      const b = makePatch('002-ui-b.patch', ['b.ts']);
      const c = makePatch('003-ui-c.patch', ['c.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([a, b, c]));
      vi.mocked(pathExists).mockImplementation((p: string) => {
        // engine/ exists but none of the filesAffected do — every
        // patch is filtered out of the lint pass.
        if (p === nativePath('/project/engine')) return Promise.resolve(true);
        if (p.endsWith('.ts')) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      expect(vi.mocked(info)).toHaveBeenCalledWith(
        expect.stringContaining(
          'No patches in the queue have been applied to engine/. Run "fireforge import" first'
        )
      );
      expect(vi.mocked(success)).toHaveBeenCalledWith(
        expect.stringContaining('No lint issues found across 0 patch(es) (3 skipped')
      );
    });

    it('does not emit the unapplied-queue hint when at least one patch was linted', async () => {
      // The hint must only fire on the all-skipped case. A queue
      // where one patch was applied and another was not should still
      // surface the skipped count (visibility) but not the
      // import-first banner (false alarm).
      const applied = makePatch('001-ui-applied.patch', ['applied.ts']);
      const missing = makePatch('002-ui-missing.patch', ['missing.ts']);
      vi.mocked(loadPatchesManifest).mockResolvedValue(makeManifest([applied, missing]));
      vi.mocked(pathExists).mockImplementation((p: string) => {
        if (p.endsWith(nativePath('/missing.ts'))) return Promise.resolve(false);
        return Promise.resolve(true);
      });
      vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
      vi.mocked(lintExportedPatch).mockResolvedValue([]);

      await expect(lintCommand('/project', [], { perPatch: true })).resolves.toBeUndefined();

      const infoCalls = vi.mocked(info).mock.calls.map((c) => c[0]);
      expect(infoCalls.some((m) => m.includes('Run "fireforge import" first'))).toBe(false);
      expect(vi.mocked(success)).toHaveBeenCalledWith(
        expect.stringContaining('No lint issues found across 1 patch(es) (1 skipped')
      );
    });

    it('clears the per-patch lint cache from the nested subcommand', async () => {
      const program = new Command();
      program.exitOverride();
      registerLint(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: (handler) => handler,
      });

      await program.parseAsync(['node', 'fireforge', 'lint', 'cache', 'clear']);

      expect(clearPerPatchLintCache).toHaveBeenCalledWith('/project');
      expect(vi.mocked(success)).toHaveBeenCalledWith('Cleared per-patch lint cache.');
    });
  });
});

describe('lintCommand — engine/ prefix normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(getAllDiff).mockResolvedValue('diff content');
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
    vi.mocked(lintExportedPatch).mockResolvedValue([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);
  });

  it('accepts a repo-root-relative engine/ prefix on a file path', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'browser/base/content/foo.js' },
    ]);

    // Operator pastes the path with the `engine/` prefix (common from git
    // status output). Without the strip this falls through to "No modified
    // files found in the specified paths.", because the status lookup sees
    // paths relative to engine/ and the explicit prefix double-roots.
    await expect(
      lintCommand('/project', ['engine/browser/base/content/foo.js'])
    ).resolves.toBeUndefined();

    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith(nativePath('/project/engine'), [
      'browser/base/content/foo.js',
    ]);
    expect(info).not.toHaveBeenCalledWith('No modified files found in the specified paths.');
  });

  it('accepts an engine/ prefix on a directory path', async () => {
    vi.mocked(stat).mockResolvedValue(fakeStats({ isDirectory: () => true }));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/base/content/foo.js']);

    await lintCommand('/project', ['engine/browser/base/content']);

    expect(getModifiedFilesInDir).toHaveBeenCalledWith(
      nativePath('/project/engine'),
      'browser/base/content'
    );
  });
});

describe('lintCommand — default-mode branding exclusion', () => {
  // Running `fireforge lint` on a fresh-setup workspace otherwise fails
  // `large-patch-lines`, `large-patch-files`, and `missing-license-header`
  // on the tool-managed branding tree. Status classifies that content as
  // `branding`; default lint partitions the dirty tree the same way and
  // leaves branding out of the aggregate diff. Explicit
  // `fireforge lint <path>` still lints branding when the operator asks.

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'My Browser',
      vendor: 'Acme',
      appId: 'org.acme.browser',
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    vi.mocked(lintExportedPatch).mockResolvedValue([]);
  });

  function statusEntry(
    status: string,
    file: string
  ): {
    status: string;
    indexStatus: string;
    worktreeStatus: string;
    file: string;
    isUntracked: boolean;
    isRenameOrCopy: boolean;
    isDeleted: boolean;
  } {
    return {
      status,
      indexStatus: status[0] ?? ' ',
      worktreeStatus: status[1] ?? status[0] ?? ' ',
      file,
      isUntracked: status.includes('?'),
      isRenameOrCopy: false,
      isDeleted: status.includes('D'),
    };
  }

  it('filters branding-managed paths out of the default aggregate diff', async () => {
    // The aggregate-mode branding branch sources paths via
    // `getWorkingTreeStatus` + `expandUntrackedDirectoryEntries` so it can
    // expand `?? dir/` entries before the diff pass. A
    // `getModifiedFiles`/`getUntrackedFiles` blend trips EISDIR on imported
    // patch stacks.
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      statusEntry(' M', 'browser/branding/mybrowser/locales/en-US/brand.ftl'),
      statusEntry(' M', 'browser/branding/mybrowser/configure.sh'),
      statusEntry(' M', 'browser/base/content/myhook.js'),
    ]);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

    await lintCommand('/project', []);

    // The diff handed to `lintExportedPatch` must exclude branding paths.
    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith(nativePath('/project/engine'), [
      'browser/base/content/myhook.js',
    ]);
    // The operator sees a one-line note telling them what was excluded.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Excluded 2 tool-managed branding file')
    );
  });

  it('passes through unchanged when no branding files are dirty', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      statusEntry(' M', 'browser/base/content/myhook.js'),
    ]);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

    await lintCommand('/project', []);

    // No branding exclusion note fires when there's nothing to exclude.
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Excluded'));
    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith(nativePath('/project/engine'), [
      'browser/base/content/myhook.js',
    ]);
  });

  it('short-circuits when every dirty file is branding', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      statusEntry(' M', 'browser/branding/mybrowser/locales/en-US/brand.ftl'),
      statusEntry(' M', 'browser/branding/mybrowser/configure.sh'),
    ]);

    await lintCommand('/project', []);

    // With nothing to lint after exclusion, the command surfaces a
    // targeted "nothing to lint" banner and does NOT call
    // lintExportedPatch. The wording covers both branding and Furnace
    // exclusions now that the aggregate-mode filter drops both buckets
    // (see lint.ts: "No non-branding, non-Furnace changes to lint.").
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('No non-branding, non-Furnace changes')
    );
    expect(lintExportedPatch).not.toHaveBeenCalled();
  });

  it('does not filter branding when the caller supplies explicit paths', async () => {
    // Explicit-path mode is the operator's signal that they want to
    // lint exactly these files; the aggregate branding exclusion does
    // not apply.
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      {
        status: 'M',
        file: 'browser/branding/mybrowser/locales/en-US/brand.ftl',
      },
    ]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');

    await lintCommand('/project', ['browser/branding/mybrowser/locales/en-US/brand.ftl']);

    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith(nativePath('/project/engine'), [
      'browser/branding/mybrowser/locales/en-US/brand.ftl',
    ]);
    // No "Excluded …" banner in file-list mode.
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Excluded'));
  });
});

describe('applyAggregateLintIgnoreSuppression', () => {
  // Use lightweight inline shapes; PatchQueueContext only exposes
  // `entries[*].metadata.{lintIgnore, filesAffected}` for this code
  // path, so we don't need the full PatchQueueEntry construction.
  function ctx(
    entries: Array<{ filename: string; lintIgnore?: string[]; filesAffected: string[] }>
  ): import('../../core/patch-lint.js').PatchQueueContext {
    return {
      entries: entries.map((e, i) => ({
        filename: e.filename,
        order: i + 1,
        diff: '',
        newFiles: new Map<string, string>(),
        modifiedFileAdditions: new Map<string, string>(),
        metadata: {
          filename: e.filename,
          order: i + 1,
          category: 'infra' as const,
          name: e.filename,
          description: '',
          createdAt: '2026-04-30T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: e.filesAffected,
          ...(e.lintIgnore !== undefined ? { lintIgnore: e.lintIgnore } : {}),
        },
      })),
    };
  }

  it('drops issues whose owning patch waived the check via lintIgnore', () => {
    const issues = [
      {
        file: 'browser/components/extensions/parent/ext-browser.js',
        check: 'modified-file-missing-header',
        message: 'Modified upstream file appears to be missing a recognized license header.',
        severity: 'warning' as const,
      },
    ];
    const queue = ctx([
      {
        filename: '0042-infra-marionette-tabbrowser-guards.patch',
        lintIgnore: ['modified-file-missing-header'],
        filesAffected: ['browser/components/extensions/parent/ext-browser.js'],
      },
    ]);

    const result = applyAggregateLintIgnoreSuppression(issues, queue);

    expect(result.dropped).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it('preserves issues whose check is not in the owning patch lintIgnore', () => {
    const issues = [
      {
        file: 'browser/foo.js',
        check: 'raw-color-value',
        message: 'raw color',
        severity: 'error' as const,
      },
    ];
    const queue = ctx([
      {
        filename: '0001-ui-foo.patch',
        lintIgnore: ['large-patch-files'],
        filesAffected: ['browser/foo.js'],
      },
    ]);

    const result = applyAggregateLintIgnoreSuppression(issues, queue);

    expect(result.dropped).toBe(0);
    expect(result.issues).toHaveLength(1);
  });

  it('preserves issues whose file is not in any patch filesAffected (no owner)', () => {
    const issues = [
      {
        file: 'browser/unowned.js',
        check: 'modified-file-missing-header',
        message: 'header',
        severity: 'warning' as const,
      },
    ];
    const queue = ctx([
      {
        filename: '0001-ui-foo.patch',
        lintIgnore: ['modified-file-missing-header'],
        filesAffected: ['browser/something-else.js'],
      },
    ]);

    const result = applyAggregateLintIgnoreSuppression(issues, queue);

    expect(result.dropped).toBe(0);
    expect(result.issues).toHaveLength(1);
  });

  it('drops when at least one of multiple owning patches waived the check', () => {
    // The same file is touched by two patches; one waives the rule, one
    // does not. Per the conservative contract, the issue is suppressed —
    // mirrors per-patch mode where the waiving patch's slice would not
    // produce the issue at all.
    const issues = [
      {
        file: 'browser/shared.js',
        check: 'modified-file-missing-header',
        message: 'header',
        severity: 'warning' as const,
      },
    ];
    const queue = ctx([
      {
        filename: '0001-ui-creator.patch',
        filesAffected: ['browser/shared.js'],
      },
      {
        filename: '0002-ui-modifier.patch',
        lintIgnore: ['modified-file-missing-header'],
        filesAffected: ['browser/shared.js'],
      },
    ]);

    const result = applyAggregateLintIgnoreSuppression(issues, queue);

    expect(result.dropped).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it('returns the original list untouched when no patch carries lintIgnore', () => {
    const issues = [
      {
        file: 'browser/foo.js',
        check: 'modified-file-missing-header',
        message: 'header',
        severity: 'warning' as const,
      },
    ];
    const queue = ctx([
      {
        filename: '0001-ui-foo.patch',
        filesAffected: ['browser/foo.js'],
      },
    ]);

    const result = applyAggregateLintIgnoreSuppression(issues, queue);

    expect(result.dropped).toBe(0);
    expect(result.issues).toBe(issues);
  });
});
