// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../build-baseline.js', () => ({
  readBuildBaseline: vi.fn(),
}));

vi.mock('../git.js', () => ({
  hasChanges: vi.fn(),
  isMissingHeadError: vi.fn(() => false),
}));

vi.mock('../git-base.js', () => ({
  git: vi.fn(),
}));

vi.mock('../git-status.js', () => ({
  getUntrackedFiles: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

import { readBuildBaseline } from '../build-baseline.js';
import { hasChanges } from '../git.js';
import { git } from '../git-base.js';
import { getUntrackedFiles } from '../git-status.js';
import { checkStaleBuildForTest, formatStaleBuildWarning } from '../test-stale-check.js';

const mockReadBaseline = vi.mocked(readBuildBaseline);
const mockGit = vi.mocked(git);
const mockHasChanges = vi.mocked(hasChanges);
const mockGetUntracked = vi.mocked(getUntrackedFiles);

describe('checkStaleBuildForTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.mockResolvedValue('');
    mockHasChanges.mockResolvedValue(false);
    mockGetUntracked.mockResolvedValue([]);
  });

  it('returns not-stale when no baseline marker exists', async () => {
    // First run of a fresh workspace: no `.fireforge/last-build.json` exists
    // yet, so we have nothing to diff against. Returning `stale: true` in
    // that case would warn on every first test invocation.
    mockReadBaseline.mockResolvedValue(undefined);

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result).toEqual({
      stale: false,
      changedPaths: [],
      truncated: 0,
      baseline: undefined,
    });
  });

  it('returns not-stale when git diff shows no packageable paths', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    // Only a non-packaged path changed (tools/, .py) — not a bundle concern.
    mockGit.mockResolvedValueOnce('tools/ci.py\n');

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(false);
    expect(result.changedPaths).toEqual([]);
  });

  it('flags packageable engine paths changed since the baseline', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    mockGit.mockResolvedValueOnce(
      'browser/base/content/hominis.xhtml\n' + 'browser/base/content/hominis.js\n' + 'tools/ci.py\n'
    );

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(true);
    expect(result.changedPaths).toEqual([
      'browser/base/content/hominis.js',
      'browser/base/content/hominis.xhtml',
    ]);
    expect(result.truncated).toBe(0);
  });

  it('includes workdir modifications and untracked packageable files', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    mockGit
      .mockResolvedValueOnce('') // baseline..HEAD diff is empty
      .mockResolvedValueOnce('browser/base/content/workdir-edit.js\n'); // HEAD diff (workdir)
    mockHasChanges.mockResolvedValue(true);
    mockGetUntracked.mockResolvedValue(['browser/base/content/new-untracked.mjs']);

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(true);
    expect(result.changedPaths).toEqual(
      expect.arrayContaining([
        'browser/base/content/workdir-edit.js',
        'browser/base/content/new-untracked.mjs',
      ])
    );
  });

  it('truncates the changedPaths list to the render cap and reports the remainder', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    // 12 packageable files — 10 should render inline, 2 should be truncated.
    const paths = Array.from(
      { length: 12 },
      (_, i) => `browser/base/content/file${String(i).padStart(2, '0')}.js`
    );
    mockGit.mockResolvedValueOnce(paths.join('\n') + '\n');

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(true);
    expect(result.changedPaths).toHaveLength(10);
    expect(result.truncated).toBe(2);
  });

  it('degrades to not-stale when git diff throws (broken probe must not block tests)', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    mockGit.mockRejectedValueOnce(new Error('git unavailable'));
    mockHasChanges.mockRejectedValue(new Error('git unavailable'));

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(false);
  });

  it('skips fingerprint-matching files when the baseline carries packageableFingerprints (Finding #18)', async () => {
    // Regression guard: with per-file fingerprints in the baseline, the
    // stale check must not flag a path whose live content still matches
    // what it was at build time — that is the motivating case for
    // projects with persistent patch/furnace workdir diffs that stay
    // byte-identical between builds. Use a real temp engine directory
    // because `node:fs/promises.readFile` is an ESM namespace export
    // that vitest cannot spy on.
    const { mkdtemp, writeFile: fsWriteFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { createHash } = await import('node:crypto');

    const engineDir = await mkdtemp(joinPath(tmpdir(), 'ff-stale-fp-'));
    try {
      const relPath = 'browser/base/content/stable.js';
      const absPath = joinPath(engineDir, relPath);
      const { ensureDir } = await import('../../utils/fs.js');
      await ensureDir(joinPath(engineDir, 'browser/base/content'));
      const content = 'hello world\n';
      await fsWriteFile(absPath, content);
      const stableHash = createHash('sha256').update(content).digest('hex');

      mockReadBaseline.mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
        packageableFingerprints: { [relPath]: stableHash },
      });
      mockGit.mockResolvedValueOnce(`${relPath}\n`);

      const result = await checkStaleBuildForTest('/project', engineDir);
      expect(result.stale).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('still flags packageable paths whose live content differs from the fingerprint', async () => {
    const { mkdtemp, writeFile: fsWriteFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { createHash } = await import('node:crypto');

    const engineDir = await mkdtemp(joinPath(tmpdir(), 'ff-stale-fp-'));
    try {
      const relPath = 'browser/base/content/edited.js';
      const absPath = joinPath(engineDir, relPath);
      const { ensureDir } = await import('../../utils/fs.js');
      await ensureDir(joinPath(engineDir, 'browser/base/content'));
      await fsWriteFile(absPath, 'edited content\n');
      const oldHash = createHash('sha256').update('old content\n').digest('hex');

      mockReadBaseline.mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
        packageableFingerprints: { [relPath]: oldHash },
      });
      mockGit.mockResolvedValueOnce(`${relPath}\n`);

      const result = await checkStaleBuildForTest('/project', engineDir);
      expect(result.stale).toBe(true);
      expect(result.changedPaths).toContain(relPath);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });
});

describe('formatStaleBuildWarning', () => {
  it('renders the list of changed paths and the recommended --build invocation', () => {
    const message = formatStaleBuildWarning({
      stale: true,
      changedPaths: ['browser/base/content/hominis.xhtml', 'browser/base/content/hominis.js'],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
      },
    });
    expect(message).toContain('browser/base/content/hominis.xhtml');
    expect(message).toContain('browser/base/content/hominis.js');
    expect(message).toContain('fireforge test --build');
  });

  it('appends a (+N more) tail when paths were truncated', () => {
    const message = formatStaleBuildWarning({
      stale: true,
      changedPaths: ['a.js', 'b.js'],
      truncated: 3,
      baseline: undefined,
    });
    expect(message).toContain('(+3 more)');
  });
});
