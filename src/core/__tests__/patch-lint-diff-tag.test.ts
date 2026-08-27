// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PatchLintIssue } from '../../types/commands/index.js';
import * as gitBase from '../git-base.js';
import * as gitStatus from '../git-status.js';
import {
  AGGREGATE_PATCH_FILE,
  collectDiffFilePaths,
  tagLintIssues,
} from '../patch-lint-diff-tag.js';

describe('collectDiffFilePaths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('combines committed diff, worktree diff, and untracked files', async () => {
    vi.spyOn(gitBase, 'git').mockImplementation((args: string[]) => {
      if (args.includes('HEAD...HEAD')) {
        return Promise.resolve('src/a.js\nsrc/b.js\n');
      }
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'HEAD') {
        return Promise.resolve('src/c.js\n');
      }
      return Promise.resolve('');
    });
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue(['src/d.js']);

    const files = await collectDiffFilePaths('/engine', 'HEAD');
    expect(files).toEqual(new Set(['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']));
  });

  it('degrades gracefully when a git sub-call fails', async () => {
    vi.spyOn(gitBase, 'git').mockRejectedValue(new Error('git unavailable'));
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockRejectedValue(new Error('git unavailable'));
    const files = await collectDiffFilePaths('/engine', 'main');
    expect(files).toEqual(new Set());
  });
});

describe('tagLintIssues', () => {
  it('tags each issue based on whether its file is in the diff set', () => {
    const issues: PatchLintIssue[] = [
      { file: 'touched.js', check: 'x', message: 'm', severity: 'error' },
      { file: 'pristine.css', check: 'y', message: 'm', severity: 'warning' },
    ];
    const result = tagLintIssues(issues, new Set(['touched.js']));
    expect(result[0]?.tag).toBe('introduced');
    expect(result[1]?.tag).toBe('cumulative');
  });

  it('marks fileless issues (cross-patch rules) as cumulative', () => {
    const issues: PatchLintIssue[] = [
      { file: '', check: 'queue-size', message: 'm', severity: 'warning' },
    ];
    tagLintIssues(issues, new Set(['anything.js']));
    expect(issues[0]?.tag).toBe('cumulative');
  });

  it('returns the mutated array so it can be chained', () => {
    const issues: PatchLintIssue[] = [
      { file: 'touched.js', check: 'x', message: 'm', severity: 'error' },
    ];
    const result = tagLintIssues(issues, new Set(['touched.js']));
    expect(result).toBe(issues);
  });

  // Aggregate patch-size findings carry the synthetic `(patch)` file, which
  // never appears in a real diff set, so they are always tagged
  // `[cumulative]` under `--only-introduced` even when the aggregate IS the
  // diff the operator asked about. Tagging promotes the aggregate finding to
  // `introduced` whenever the diff set is non-empty.
  it('tags aggregate patch-size findings as introduced when diff set is non-empty', () => {
    const issues: PatchLintIssue[] = [
      {
        file: AGGREGATE_PATCH_FILE,
        check: 'large-patch-files',
        message: 'Patch affects 63 files (recommended: ≤5).',
        severity: 'warning',
      },
      {
        file: AGGREGATE_PATCH_FILE,
        check: 'large-patch-lines',
        message: 'Patch is 21759 lines (hard limit: 3000).',
        severity: 'warning',
      },
    ];
    tagLintIssues(issues, new Set(['browser/modules/mybrowser/MyBrowserStore.sys.mjs']));
    expect(issues[0]?.tag).toBe('introduced');
    expect(issues[1]?.tag).toBe('introduced');
  });

  it('keeps aggregate findings as cumulative when diff set is empty', () => {
    // Empty diff set means `lint --since HEAD` ran but the caller is not
    // introducing any change — a clean branch whose only lint noise is
    // pre-existing cumulative queue state. An aggregate finding here
    // genuinely describes drift, not current work.
    const issues: PatchLintIssue[] = [
      {
        file: AGGREGATE_PATCH_FILE,
        check: 'large-patch-lines',
        message: 'Patch is 5000 lines.',
        severity: 'warning',
      },
    ];
    tagLintIssues(issues, new Set());
    expect(issues[0]?.tag).toBe('cumulative');
  });
});
