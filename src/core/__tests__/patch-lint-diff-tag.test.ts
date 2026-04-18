// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PatchLintIssue } from '../../types/commands/index.js';
import * as gitBase from '../git-base.js';
import * as gitStatus from '../git-status.js';
import { collectDiffFilePaths, tagLintIssues } from '../patch-lint-diff-tag.js';

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
});
